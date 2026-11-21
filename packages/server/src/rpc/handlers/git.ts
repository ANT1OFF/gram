import {
  effectiveCheckout,
  GitError,
  GitRpcs,
  InvalidState,
  isLocalHost,
  LOCAL_HOST_ID,
  ORCHESTRATOR_HAS_NO_PR,
  reviewBotsOf,
  samePr,
  type BoundPr,
  type Diff,
  type ThreadId,
  type StorageWorktree,
} from "@gram/contracts";
import {
  Checkpoints,
  currentUpstream,
  fetchOriginBranch,
  git,
  gitDiff,
  lastFetchedAt,
  localBaseRef,
  MAX_DIFF_READ_BYTES,
  matchesBotLogin,
  parseGitDiffCapped,
  Pr,
  Proc,
  repoFromPrUrl,
  samePath,
  tryRepoTop,
  whitespaceArgs,
} from "@gram/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  anyPrivate,
  currentReader,
  privacyOf,
  readerMay,
  touchesUnreadable,
} from "../../embedding/readable-by.ts";
import { GitRefresh } from "../../git/platform.ts";
import { deleteMergedBranch } from "../../git/branch-cleanup.ts";
import {
  addExtraPr,
  applyPrEdit,
  bindMainPr,
  editMainPr,
  hidePr,
  isBadgeOf,
  promoteExtraPr,
  rebindBlocker,
  removeExtraPr,
  setExtraPrMonitor,
  showHiddenPrs,
  validPrRef,
} from "../../git/extra-prs.ts";
import { makePrDetailCache, prDetailStamp } from "../../git/pr-detail-cache.ts";
import { GitStatePublisher } from "../../git/publisher.ts";
import { PrReviews } from "../../git/review.ts";
import { ghFolder, pathHere, threadFolder, ThreadPrLookup } from "../../git/thread-pr.ts";
import { turnDiff } from "../../git/turn-diff.ts";
import { diffChunk } from "../../git/diff-chunk.ts";
import { cleanUp, cleanupNotes, cleanupPlan, storageReport } from "../../git/storage.ts";
import { cachedFolderSize, forgetFolderSize } from "../../git/worktree-size.ts";
import { Orchestration } from "../../orchestration/service.ts";
import {
  removalError,
  toDiff,
  toDiffFile,
  toGitError,
  toPrDetail,
  untrackedPaths,
} from "../../git/mapping.ts";
import { WorkerHosts } from "../../host/worker-host.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { heldCheckoutPaths, usedCheckoutPaths } from "../../runtime/create-in-checkout.ts";
import { ThreadRuntimes } from "../../runtime/thread-runtimes.ts";
import { reviewRequestsHandlers } from "../../github/handler.ts";
import { logDefects, type Handlers } from "./common.ts";
import { checksHandlers } from "./checks.ts";
import { gitRefreshHandlers } from "./git-refresh.ts";
import { prHandlers } from "./pr.ts";
import { prCheckoutHandlers } from "./pr-checkout.ts";
import { prCreateHandlers } from "./pr-create.ts";
import { ciDiagnosticHandlers } from "./ci-diagnostics.ts";
import { prPeopleHandlers } from "./pr-people.ts";
import { pushHandlers } from "./push.ts";
import { threadUiHandlers } from "./thread-ui.ts";
import { upstreamSyncHandlers } from "./upstream-sync.ts";

const unnamed = <L extends { readonly worktrees: ReadonlyArray<StorageWorktree> }>(listing: L) =>
  Effect.gen(function* () {
    if (!anyPrivate()) return listing;
    const reader = yield* currentReader;
    return {
      ...listing,
      worktrees: listing.worktrees.filter(
        (worktree) =>
          (worktree.threadId === undefined || readerMay(reader, privacyOf(worktree.threadId))) &&
          !touchesUnreadable(reader, [worktree.path], "read"),
      ),
    };
  });

export const gitHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const runtimes = yield* ThreadRuntimes;
  const proc = yield* Proc;
  const hosts = yield* WorkerHosts;
  const { worktrees, git: gitState } = hosts.placed;
  const pr = yield* Pr;
  const checkpoints = yield* Checkpoints;
  const publisher = yield* GitStatePublisher;
  const refreshes = yield* GitRefresh;
  const reviews = yield* PrReviews;
  const orchestration = Option.getOrUndefined(yield* Effect.serviceOption(Orchestration));
  const cachedDetail = makePrDetailCache(pr.detail);
  const provide = Effect.provideService(Proc, proc);

  const baseRepo = (repoPath: string, base: string) =>
    Effect.gen(function* () {
      if (!/^origin\/[A-Za-z0-9._/-]+$/.test(base) || base.includes("..")) {
        return yield* new GitError({ message: `${base} is not an origin branch` });
      }
      yield* pathHere(hosts, repoPath);
      const repoTop = yield* provide(tryRepoTop(repoPath)).pipe(Effect.mapError(toGitError));
      if (repoTop === undefined) {
        return yield* new GitError({ message: `${repoPath} is not a git repository` });
      }
      return repoTop;
    });

  const mainCheckout = (path: string) =>
    Effect.gen(function* () {
      const list = yield* worktrees
        .list(path, { openCheckouts: [] })
        .pipe(Effect.mapError(toGitError));
      const main = list.worktrees[0];
      if (main === undefined) {
        return yield* new GitError({ message: `${path} is not in a git repository` });
      }
      return main;
    });

  const worktreesHere = hosts.machine(LOCAL_HOST_ID).worktrees;

  const storageSources = Effect.gen(function* () {
    return {
      projects: yield* store.listProjects,
      openThreads: yield* store.listThreads,
      currentThreads: store.listThreads,
      listLinked: (repoTop: string) =>
        worktreesHere
          .list(repoTop, { openCheckouts: [] })
          .pipe(Effect.map((list) => list.worktrees.filter((entry) => !entry.isMain))),
      remove: (request: {
        readonly repoTop: string;
        readonly path: string;
        readonly force: boolean;
        readonly openCheckouts: ReadonlyArray<string>;
      }) =>
        worktreesHere.remove({
          repoPath: request.repoTop,
          worktreeDir: request.path,
          force: request.force,
          openCheckouts: request.openCheckouts,
        }),
    };
  });

  const threadPr = (yield* ThreadPrLookup).target;

  const noPullRequest = new InvalidState({ message: "This thread has no pull request" });

  const refuseOrchestrator = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const thread = yield* store.getThread(threadId);
      if (thread.role === "orchestrator") {
        return yield* new InvalidState({ message: ORCHESTRATOR_HAS_NO_PR, threadId });
      }
    });

  const uncommittedDiff = (cwd: string, ignoreWhitespace: boolean) =>
    provide(
      Effect.gen(function* () {
        const diff = yield* gitDiff(cwd, { ignoreWhitespace }).pipe(Effect.mapError(toGitError));
        if (diff.worktree === undefined || diff.base !== undefined) return toDiff(diff, new Set());
        return toDiff(diff, yield* untrackedPaths(diff.worktree));
      }),
    );

  const branchDiff = (cwd: string, ignoreWhitespace: boolean) =>
    provide(
      Effect.gen(function* () {
        const top = yield* tryRepoTop(cwd).pipe(Effect.mapError(toGitError));
        if (top === undefined) return { repo: false } satisfies Diff;
        const branch = (yield* git(top, ["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
          Effect.mapError(toGitError),
        )).stdout.trim();
        const base = (yield* publisher.stateFor(cwd))?.base ?? (yield* localBaseRef(top));
        const head = { repo: true, worktree: top, ...(branch === "" ? {} : { branch }) };
        if (base === undefined) return { ...head, files: [] } satisfies Diff;
        const out = yield* git(
          top,
          [
            "-c",
            "core.quotepath=false",
            "-c",
            "diff.mnemonicPrefix=false",
            "diff",
            `${base}...HEAD`,
            "--no-color",
            ...whitespaceArgs({ ignoreWhitespace }),
          ],
          { maxOutputBytes: MAX_DIFF_READ_BYTES },
        ).pipe(Effect.mapError(toGitError));
        if (out.status !== 0) {
          return yield* new GitError({
            message: out.stderr.trim() || "git diff failed",
            command: "git diff",
          });
        }
        const { files, note } = parseGitDiffCapped(out.stdout, out.truncated);
        return {
          ...head,
          base,
          files: files.map((f) => toDiffFile(f, new Set())),
          ...(note === undefined ? {} : { note }),
        } satisfies Diff;
      }),
    );

  return {
    "worktree.list": ({ repoPath }) =>
      Effect.gen(function* () {
        const host = (yield* hosts.placeOf(repoPath)) ?? LOCAL_HOST_ID;
        const threads = yield* store.listThreads;
        const lastActivity = (path: string) =>
          Math.max(
            0,
            ...threads
              .filter((t) => heldCheckoutPaths([t], host).some((held) => samePath(held, path)))
              .map((t) => t.lastActivityAt),
          );
        const list = yield* worktrees
          .list(repoPath, { openCheckouts: heldCheckoutPaths(threads, host), lastActivity })
          .pipe(Effect.mapError(toGitError));
        return { repoTop: list.repoTop, worktrees: [...list.worktrees] };
      }),

    "worktree.status": ({ path }) =>
      gitState.snapshot(path, { remote: false }).pipe(Effect.mapError(toGitError)),

    "worktree.size": ({ path }) =>
      Effect.gen(function* () {
        const list = yield* worktrees
          .list(path, { openCheckouts: [] })
          .pipe(Effect.mapError(toGitError));
        if (!list.worktrees.slice(1).some((w) => samePath(w.path, path))) {
          return yield* new InvalidState({ message: `${path} isn't a linked worktree` });
        }
        yield* pathHere(hosts, path);
        return yield* cachedFolderSize(path);
      }),

    "worktree.storage": () =>
      Effect.gen(function* () {
        return yield* unnamed(yield* provide(storageReport(yield* storageSources)));
      }),

    "worktree.cleanupPlan": ({ inactiveDays }) =>
      Effect.gen(function* () {
        const report = yield* provide(storageReport(yield* storageSources));
        return yield* unnamed(yield* cleanupPlan(report, inactiveDays, Date.now()));
      }),

    "worktree.cleanUp": ({ paths, confirmed, prune }) =>
      Effect.gen(function* () {
        const sources = yield* storageSources;
        const { result, cleaned } = yield* provide(
          cleanUp(sources, { paths, confirmed: confirmed ?? [], prune: prune ?? false }),
        );
        if (orchestration !== undefined && cleaned.length > 0) {
          const notes = cleanupNotes(cleaned, yield* store.listWorkspaces, sources.projects);
          for (const { workspaceId, note } of notes) {
            yield* orchestration.noteQuietly(workspaceId, note);
          }
        }
        return result;
      }),

    "worktree.pendingPermissionsAt": ({ path }) =>
      Effect.gen(function* () {
        const main = yield* mainCheckout(path);
        if (samePath(main.path, path)) return [];
        const rules = yield* worktrees
          .pendingPermissions(main.path, path)
          .pipe(Effect.mapError(toGitError));
        return [...rules];
      }),

    "worktree.remove": ({ path, force, permissionRules, deleteBranch }) =>
      Effect.gen(function* () {
        const main = yield* mainCheckout(path);
        if (samePath(main.path, path)) {
          return yield* new InvalidState({ message: "the main checkout can't be removed" });
        }
        const branch =
          deleteBranch === undefined
            ? undefined
            : (yield* worktrees
                .list(main.path, { openCheckouts: [] })
                .pipe(Effect.mapError(toGitError))).worktrees.find((w) => samePath(w.path, path))
                ?.branch;
        const host = (yield* hosts.placeOf(path)) ?? LOCAL_HOST_ID;
        const here = host === LOCAL_HOST_ID;
        const openCheckouts = usedCheckoutPaths(yield* store.listThreads, host);
        yield* worktrees
          .remove({
            repoPath: main.path,
            worktreeDir: path,
            force,
            openCheckouts,
            ...(permissionRules === undefined ? {} : { mergeRules: permissionRules }),
          })
          .pipe(
            Effect.catch((error) =>
              here ? provide(removalError(error, path)) : Effect.fail(toGitError(error)),
            ),
          );
        forgetFolderSize(path);
        if (deleteBranch === undefined || branch === undefined) return {};
        if (!here) {
          return {
            branch: {
              name: branch,
              deleted: false,
              reason: "the branch is on another machine, whose git this can't run",
            },
          };
        }
        const cleanup = yield* provide(
          deleteMergedBranch({ repoPath: main.path, branch, pr: deleteBranch }),
        ).pipe(Effect.provideService(Pr, pr));
        return { branch: cleanup };
      }),

    "git.diff": ({ threadId, scope, ignoreWhitespace = false }) =>
      Effect.gen(function* () {
        const cwd = yield* threadFolder(yield* store.getThread(threadId));
        switch (scope.kind) {
          case "uncommitted":
            return yield* uncommittedDiff(cwd, ignoreWhitespace);
          case "branch":
            return yield* branchDiff(cwd, ignoreWhitespace);
          case "turn":
            return yield* provide(
              turnDiff(threadId, cwd, scope.turnId, { ignoreWhitespace }).pipe(
                Effect.provideService(Checkpoints, checkpoints),
              ),
            );
        }
      }),

    "git.diffChunk": ({ threadId, ...request }) =>
      Effect.gen(function* () {
        const cwd = yield* threadFolder(yield* store.getThread(threadId));
        const branchBase =
          request.scope.kind === "branch" ? (yield* publisher.stateFor(cwd))?.base : undefined;
        return yield* provide(
          diffChunk({ threadId, cwd, ...request, branchBase }).pipe(
            Effect.provideService(Checkpoints, checkpoints),
          ),
        );
      }),

    "git.branches": ({ repoPath }) =>
      worktrees.baseBranches(repoPath).pipe(
        Effect.map((result) => ({
          branches: [...result.branches],
          ...(result.default === undefined ? {} : { default: result.default }),
        })),
        Effect.mapError(toGitError),
      ),

    "git.baseStatus": ({ repoPath, base }) =>
      Effect.gen(function* () {
        const repoTop = yield* baseRepo(repoPath, base);
        const fetchedAt = yield* provide(lastFetchedAt(repoTop));
        return { ref: base, ...(fetchedAt === undefined ? {} : { fetchedAt }) };
      }),

    "git.fetchBase": ({ repoPath, base }) =>
      Effect.gen(function* () {
        const repoTop = yield* baseRepo(repoPath, base);
        const result = yield* provide(fetchOriginBranch(repoTop, base)).pipe(
          Effect.mapError((e) => new GitError({ message: e.message })),
        );
        return {
          ref: base,
          newCommits: result.newCommits,
          ...(result.fetchedAt === undefined ? {} : { fetchedAt: result.fetchedAt }),
        };
      }),

    "git.upstreamStatus": ({ repoPath }) =>
      Effect.gen(function* () {
        yield* pathHere(hosts, repoPath);
        const repoTop = yield* provide(tryRepoTop(repoPath)).pipe(Effect.mapError(toGitError));
        if (repoTop === undefined) {
          return yield* new GitError({ message: `${repoPath} is not a git repository` });
        }
        const { branch, ref } = yield* provide(currentUpstream(repoPath));
        const fetchedAt = ref === undefined ? undefined : yield* provide(lastFetchedAt(repoTop));
        return {
          ...(branch === undefined ? {} : { branch }),
          ...(ref === undefined ? {} : { ref }),
          ...(fetchedAt === undefined ? {} : { fetchedAt }),
        };
      }),

    "git.prDetail": ({ threadId }) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId);
        if (thread.role === "orchestrator") return { available: true };
        const cwd = yield* ghFolder(thread);
        const here = isLocalHost(effectiveCheckout(thread));
        const state = here
          ? yield* publisher.stateFor(cwd)
          : yield* publisher.stateForThread(thread);
        const number =
          thread.boundPr?.number ??
          state?.pr?.number ??
          (here
            ? (yield* pr.status(cwd).pipe(Effect.orElseSucceed(() => undefined)))?.number
            : undefined);
        if (number === undefined) return { available: true };
        const repo =
          thread.boundPr?.repo ??
          (here || state?.pr === undefined ? undefined : repoFromPrUrl(state.pr.url));
        const stamp = prDetailStamp(yield* publisher.badgeFor(thread), { number, repo });
        const result = yield* cachedDetail({
          cwd,
          number,
          ...(repo === undefined ? {} : { repo }),
          ...(stamp === undefined ? {} : { stamp }),
        });
        if (result.detail !== undefined) yield* publisher.reconcile(thread, result.detail);
        return {
          available: result.available,
          ...(result.detail === undefined ? {} : { detail: toPrDetail(result.detail) }),
          ...(result.error === undefined ? {} : { error: result.error }),
        };
      }),

    "pr.bind": ({ threadId, repo, number, monitor }) =>
      Effect.gen(function* () {
        yield* refuseOrchestrator(threadId);
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || number <= 0) {
          return yield* new GitError({ message: `invalid pull request ${repo}#${number}` });
        }
        const boundPr: BoundPr = { repo, number, monitor: monitor ?? false };
        const { thread, refused } = yield* applyPrEdit(runtimes.updateThread, threadId, (t) => {
          const blocked = rebindBlocker(t, boundPr);
          return blocked === undefined
            ? {
                thread: bindMainPr(t, {
                  ...(t.boundPr !== undefined && samePr(t.boundPr, boundPr) ? t.boundPr : boundPr),
                  monitor: boundPr.monitor,
                }),
              }
            : { refused: blocked };
        });
        if (refused !== undefined) return yield* new InvalidState({ message: refused, threadId });
        yield* refreshes.request(effectiveCheckout(thread).path, true);
        return boundPr;
      }),

    "pr.unbind": ({ threadId }) =>
      runtimes
        .updateThread(threadId, (t) => {
          const { boundPr, ...rest } = t;
          void boundPr;
          return rest;
        })
        .pipe(Effect.asVoid),

    "pr.status": ({ threadId }) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId);
        if (thread.role === "orchestrator") return {};
        const badge = isLocalHost(effectiveCheckout(thread))
          ? yield* Effect.gen(function* () {
              const cwd = yield* threadFolder(thread);
              const cached = (yield* publisher.stateFor(cwd))?.pr;
              return cached ?? (yield* pr.status(cwd).pipe(Effect.mapError(toGitError)));
            })
          : (yield* publisher.stateForThread(thread))?.pr;
        return {
          ...(thread.boundPr === undefined ? {} : { bound: thread.boundPr }),
          ...(badge === undefined ? {} : { pr: badge }),
        };
      }),

    "pr.setMonitor": ({ threadId, monitor }) =>
      Effect.gen(function* () {
        if (monitor) yield* refuseOrchestrator(threadId);
        const { refused } = yield* applyPrEdit(
          runtimes.updateThread,
          threadId,
          editMainPr((bound) => ({ ...bound, monitor })),
        );
        if (refused !== undefined) return yield* new InvalidState({ message: refused, threadId });
      }),

    "pr.bindExtra": ({ threadId, repo, number, monitor }) =>
      Effect.gen(function* () {
        yield* refuseOrchestrator(threadId);
        if (!validPrRef({ repo, number })) {
          return yield* new GitError({ message: `invalid pull request ${repo}#${number}` });
        }
        const { thread, refused } = yield* applyPrEdit(runtimes.updateThread, threadId, (t) =>
          addExtraPr(t, { repo, number }, monitor ?? false),
        );
        if (refused !== undefined) return yield* new InvalidState({ message: refused, threadId });
        yield* refreshes.request(effectiveCheckout(thread).path, true);
        return thread.extraPrs ?? [];
      }),

    "pr.unbindExtra": ({ threadId, repo, number }) =>
      Effect.gen(function* () {
        const thread = yield* runtimes.updateThread(threadId, (t) =>
          removeExtraPr(t, { repo, number }),
        );
        yield* refreshes.request(effectiveCheckout(thread).path, true);
      }),

    "pr.setExtraMonitor": ({ threadId, repo, number, monitor }) =>
      Effect.gen(function* () {
        const { refused } = yield* applyPrEdit(runtimes.updateThread, threadId, (t) =>
          setExtraPrMonitor(t, { repo, number }, monitor),
        );
        if (refused !== undefined) return yield* new InvalidState({ message: refused, threadId });
      }),

    "pr.promote": ({ threadId, repo, number }) =>
      Effect.gen(function* () {
        const { thread, refused } = yield* applyPrEdit(runtimes.updateThread, threadId, (t) =>
          promoteExtraPr(t, { repo, number }),
        );
        if (refused !== undefined || thread.boundPr === undefined) {
          return yield* new InvalidState({
            message: refused ?? `${repo}#${number} isn't followed by this thread`,
            threadId,
          });
        }
        if (
          thread.boundPr.number !== number ||
          thread.boundPr.repo.toLowerCase() !== repo.toLowerCase()
        ) {
          return yield* new InvalidState({
            message: `${repo}#${number} is being merged by another thread right now, so it can't become this thread's pull request; it is still followed. Promote it again once that merge settles.`,
            threadId,
          });
        }
        yield* refreshes.request(effectiveCheckout(thread).path, true);
        return thread.boundPr;
      }),

    "pr.hide": ({ threadId, pr: hidden }) =>
      Effect.gen(function* () {
        if (!validPrRef(hidden)) {
          return yield* new GitError({
            message: `invalid pull request ${hidden.repo}#${hidden.number}`,
          });
        }
        yield* runtimes.updateThread(threadId, (t) => hidePr(t, hidden));
      }),

    "pr.showHidden": ({ threadId }) =>
      runtimes.updateThread(threadId, showHiddenPrs).pipe(Effect.asVoid),

    "git.prReview": ({ threadId }) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId);
        const cwd = yield* ghFolder(thread);
        const target = yield* threadPr(thread, cwd);
        if (target === undefined) return { available: true, threads: [] };
        const bots = reviewBotsOf(yield* store.getSettings);
        return yield* reviews
          .fetch(cwd, target.repo, target.number, bots)
          .pipe(
            Effect.catchTag("ReviewActionError", (e) =>
              Effect.succeed({ available: true, error: e.message, threads: [] }),
            ),
          );
      }),

    "git.prApplySuggestion": ({ threadId, commentId }) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId);
        const cwd = yield* threadFolder(thread);
        const target = yield* threadPr(thread, cwd);
        if (target === undefined) return yield* noPullRequest;
        const review = yield* reviews
          .fetch(cwd, target.repo, target.number, reviewBotsOf(yield* store.getSettings))
          .pipe(Effect.mapError(toGitError));
        const reviewThread = review.threads.find((t) => t.comments.some((c) => c.id === commentId));
        const suggestion = reviewThread?.comments.find((c) => c.id === commentId)?.suggestion;
        if (reviewThread === undefined) {
          return yield* new InvalidState({ message: "That review comment no longer exists" });
        }
        if (suggestion === undefined) {
          return yield* new InvalidState({ message: "That comment has no suggestion" });
        }
        const top = (yield* provide(tryRepoTop(cwd)).pipe(Effect.mapError(toGitError))) ?? cwd;
        const applied = yield* reviews
          .applySuggestion(
            top,
            {
              path: reviewThread.path,
              line: reviewThread.line,
              startLine: reviewThread.startLine,
              isOutdated: reviewThread.isOutdated,
            },
            suggestion,
          )
          .pipe(Effect.mapError((e) => new InvalidState({ message: e.message, threadId })));
        yield* refreshes.request(cwd, false);
        return applied;
      }),

    "git.prReplyThread": ({ threadId, reviewThreadId, body }) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId);
        const cwd = yield* ghFolder(thread);
        const comment = yield* reviews
          .reply(cwd, reviewThreadId, body)
          .pipe(Effect.mapError(toGitError));
        yield* refreshes.request(effectiveCheckout(thread).path, true);
        return comment;
      }),

    "git.prResolveThread": ({ threadId, reviewThreadId }) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId);
        const cwd = yield* ghFolder(thread);
        yield* reviews.resolve(cwd, reviewThreadId).pipe(Effect.mapError(toGitError));
        yield* refreshes.request(effectiveCheckout(thread).path, true);
      }),

    "git.prRequestRereview": ({ threadId }) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId);
        const cwd = yield* ghFolder(thread);
        const target = yield* threadPr(thread, cwd);
        if (target === undefined) return yield* noPullRequest;
        const bots = reviewBotsOf(yield* store.getSettings);
        const badge = yield* publisher.badgeFor(thread);
        const seen =
          badge !== undefined && isBadgeOf(badge, target) ? (badge.review?.bots ?? []) : [];
        const bot =
          bots.find((b) => seen.some((login) => matchesBotLogin(b.loginPattern, login))) ?? bots[0];
        if (bot === undefined) {
          return yield* new InvalidState({ message: "No review bot is configured", threadId });
        }
        yield* reviews
          .comment(cwd, target.repo, target.number, bot.rereviewCommand)
          .pipe(Effect.mapError(toGitError));
        yield* refreshes.request(effectiveCheckout(thread).path, true, { expectChange: true });
        return { command: bot.rereviewCommand };
      }),
  } satisfies Partial<Handlers>;
});

/** The git group's handler layer: git, pull requests, review bots and worktrees. */
export const GitHandlersLive = GitRpcs.toLayer(
  Effect.gen(function* () {
    const handlers = {
      ...(yield* gitHandlers),
      ...(yield* gitRefreshHandlers),
      ...(yield* checksHandlers),
      ...(yield* pushHandlers),
      ...(yield* upstreamSyncHandlers),
      ...(yield* prHandlers),
      ...(yield* prCreateHandlers),
      ...(yield* prPeopleHandlers),
      ...(yield* ciDiagnosticHandlers),
      ...(yield* prCheckoutHandlers),
      ...(yield* reviewRequestsHandlers),
      ...(yield* threadUiHandlers),
    };
    return GitRpcs.of(logDefects(GitRpcs, handlers));
  }),
);
