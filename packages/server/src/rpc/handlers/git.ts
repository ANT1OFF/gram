import {
  effectiveCheckout,
  GitError,
  GitRpcs,
  InvalidState,
  ORCHESTRATOR_HAS_NO_PR,
  reviewBotsOf,
  samePr,
  type BoundPr,
  type Diff,
  type ThreadId,
} from "@gram/contracts";
import {
  Checkpoints,
  currentUpstream,
  fetchOriginBranch,
  git,
  GitStateRuntime,
  gitDiff,
  lastFetchedAt,
  localBaseRef,
  matchesBotLogin,
  parseGitDiffCapped,
  Pr,
  prChecksStamp,
  Proc,
  samePath,
  tryRepoTop,
  Worktrees,
} from "@gram/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
import { threadFolder, ThreadPrLookup } from "../../git/thread-pr.ts";
import { turnDiff } from "../../git/turn-diff.ts";
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
import { ThreadStore } from "../../persistence/thread-store.ts";
import { heldCheckoutPaths, usedCheckoutPaths } from "../../runtime/create-in-checkout.ts";
import { ThreadRuntimes } from "../../runtime/thread-runtimes.ts";
import { reviewRequestsHandlers } from "../../github/handler.ts";
import { logDefects, type Handlers } from "./common.ts";
import { gitRefreshHandlers } from "./git-refresh.ts";
import { prHandlers } from "./pr.ts";
import { prCheckoutHandlers } from "./pr-checkout.ts";
import { prCreateHandlers } from "./pr-create.ts";
import { ciDiagnosticHandlers } from "./ci-diagnostics.ts";
import { prPeopleHandlers } from "./pr-people.ts";
import { pushHandlers } from "./push.ts";
import { threadUiHandlers } from "./thread-ui.ts";
import { upstreamSyncHandlers } from "./upstream-sync.ts";

/** `worktree.*`, `git.*` and `pr.*`. */
export const gitHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const runtimes = yield* ThreadRuntimes;
  const proc = yield* Proc;
  const worktrees = yield* Worktrees;
  const pr = yield* Pr;
  const checkpoints = yield* Checkpoints;
  const publisher = yield* GitStatePublisher;
  const refreshes = yield* GitRefresh;
  const reviews = yield* PrReviews;
  const gitState = yield* GitStateRuntime;
  const orchestration = Option.getOrUndefined(yield* Effect.serviceOption(Orchestration));
  const cachedDetail = makePrDetailCache(pr.detail);
  const provide = Effect.provideService(Proc, proc);

  /** The repo top for a base-branch RPC; `base` must name an `origin/` branch. */
  const baseRepo = (repoPath: string, base: string) =>
    Effect.gen(function* () {
      if (!/^origin\/[A-Za-z0-9._/-]+$/.test(base) || base.includes("..")) {
        return yield* new GitError({ message: `${base} is not an origin branch` });
      }
      const repoTop = yield* provide(tryRepoTop(repoPath)).pipe(Effect.mapError(toGitError));
      if (repoTop === undefined) {
        return yield* new GitError({ message: `${repoPath} is not a git repository` });
      }
      return repoTop;
    });

  /** The main checkout of the repo `path` belongs to. */
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

  /** What Settings › Storage reads: the projects, the threads open and closed, and git's lists. */
  const storageSources = Effect.gen(function* () {
    return {
      projects: yield* store.listProjects,
      openThreads: yield* store.listThreads,
      currentThreads: store.listThreads,
      listLinked: (repoTop: string) =>
        worktrees
          .list(repoTop, { openCheckouts: [] })
          .pipe(Effect.map((list) => list.worktrees.filter((entry) => !entry.isMain))),
      remove: (request: {
        readonly repoTop: string;
        readonly path: string;
        readonly force: boolean;
        readonly openCheckouts: ReadonlyArray<string>;
      }) =>
        worktrees.remove({
          repoPath: request.repoTop,
          worktreeDir: request.path,
          force: request.force,
          openCheckouts: request.openCheckouts,
        }),
    };
  });

  /** The thread's PR: the bound PR, else the branch's badge; `undefined` without one. */
  const threadPr = (yield* ThreadPrLookup).target;

  const noPullRequest = new InvalidState({ message: "This thread has no pull request" });

  /** Fails for an orchestrator, which follows no PR of its own. */
  const refuseOrchestrator = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const thread = yield* store.getThread(threadId);
      if (thread.role === "orchestrator") {
        return yield* new InvalidState({ message: ORCHESTRATOR_HAS_NO_PR, threadId });
      }
    });

  /**
   * Uncommitted work. A clean tree on a branch ahead of its base falls back to branch vs base, with
   * `base` set so the panel can say so.
   */
  const uncommittedDiff = (cwd: string) =>
    provide(
      Effect.gen(function* () {
        const diff = yield* gitDiff(cwd).pipe(Effect.mapError(toGitError));
        if (diff.worktree === undefined || diff.base !== undefined) return toDiff(diff, new Set());
        return toDiff(diff, yield* untrackedPaths(diff.worktree));
      }),
    );

  /** Committed branch work against the rebase signal's base, else the repo default. */
  const branchDiff = (cwd: string) =>
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
        const out = yield* git(top, [
          "-c",
          "core.quotepath=false",
          "-c",
          "diff.mnemonicPrefix=false",
          "diff",
          `${base}...HEAD`,
          "--no-color",
        ]).pipe(Effect.mapError(toGitError));
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
        const threads = yield* store.listThreads;
        const lastActivity = (path: string) =>
          Math.max(
            0,
            ...threads
              .filter((t) => heldCheckoutPaths([t]).some((held) => samePath(held, path)))
              .map((t) => t.lastActivityAt),
          );
        const list = yield* worktrees
          .list(repoPath, { openCheckouts: heldCheckoutPaths(threads), lastActivity })
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
        // Only a linked worktree git knows: the RPC takes a path, and the main checkout is never sized.
        if (!list.worktrees.slice(1).some((w) => samePath(w.path, path))) {
          return yield* new InvalidState({ message: `${path} isn't a linked worktree` });
        }
        return yield* cachedFolderSize(path);
      }),

    "worktree.storage": () =>
      Effect.gen(function* () {
        return yield* provide(storageReport(yield* storageSources));
      }),

    "worktree.cleanupPlan": ({ inactiveDays }) =>
      Effect.gen(function* () {
        const report = yield* provide(storageReport(yield* storageSources));
        return yield* cleanupPlan(report, inactiveDays, Date.now());
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
        const openCheckouts = usedCheckoutPaths(yield* store.listThreads);
        yield* worktrees
          .remove({
            repoPath: main.path,
            worktreeDir: path,
            force,
            openCheckouts,
            ...(permissionRules === undefined ? {} : { mergeRules: permissionRules }),
          })
          .pipe(Effect.catch((error) => provide(removalError(error, path))));
        forgetFolderSize(path);
        if (deleteBranch === undefined || branch === undefined) return {};
        const cleanup = yield* provide(
          deleteMergedBranch({ repoPath: main.path, branch, pr: deleteBranch }),
        ).pipe(Effect.provideService(Pr, pr));
        return { branch: cleanup };
      }),

    "git.diff": ({ threadId, scope }) =>
      Effect.gen(function* () {
        const cwd = yield* threadFolder(yield* store.getThread(threadId));
        switch (scope.kind) {
          case "uncommitted":
            return yield* uncommittedDiff(cwd);
          case "branch":
            return yield* branchDiff(cwd);
          case "turn":
            return yield* provide(
              turnDiff(threadId, cwd, scope.turnId).pipe(
                Effect.provideService(Checkpoints, checkpoints),
              ),
            );
        }
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
        // Not its checkout's PR either: an orchestrator follows none of its own.
        if (thread.role === "orchestrator") return { available: true };
        const cwd = yield* threadFolder(thread);
        const state = yield* publisher.stateFor(cwd);
        const number =
          thread.boundPr?.number ??
          state?.pr?.number ??
          (yield* pr.status(cwd).pipe(Effect.orElseSucceed(() => undefined)))?.number;
        // No PR is a normal state, not a failure: `error` is reserved for gh, network and auth failures.
        if (number === undefined) return { available: true };
        const repo = thread.boundPr?.repo;
        const stamp = prDetailStamp(yield* publisher.badgeFor(thread), { number, repo });
        const result = yield* cachedDetail({
          cwd,
          number,
          ...(repo === undefined ? {} : { repo }),
          ...(stamp === undefined ? {} : { stamp }),
        });
        // The panel may be first to see a merge, for a thread no sweep has asked about since.
        if (result.detail !== undefined) yield* publisher.reconcile(thread, result.detail);
        return {
          available: result.available,
          ...(result.detail === undefined ? {} : { detail: toPrDetail(result.detail) }),
          ...(result.error === undefined ? {} : { error: result.error }),
        };
      }),

    "git.prChecks": ({ threadId }) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId);
        const cwd = yield* threadFolder(thread);
        const target = yield* threadPr(thread, cwd);
        // No PR is a normal state here as it is for `git.prDetail`, not a failure.
        if (target === undefined) return { checks: [] };
        // The client asks again as the badge's rollup changes, which is within the lookup's TTL of
        // its last answer as often as not: the stamp keeps that answer from standing in for this one.
        // Only the target's own badge can say so. Numbers are local to a repository, and a PR bound
        // from elsewhere can share its number with the checkout's.
        const badge = yield* publisher.badgeFor(thread);
        const stamp =
          badge !== undefined && isBadgeOf(badge, target) ? prChecksStamp(badge) : undefined;
        const checks = yield* pr
          .checks(cwd, target.number, target.repo, { stamp })
          .pipe(Effect.mapError((e) => new GitError({ message: e.message })));
        // A PR already failing when the app opened has no CI notice to name its checks.
        yield* publisher.checksRead(thread);
        return { checks };
      }),

    "git.prRerunChecks": ({ threadId }) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId);
        const cwd = yield* threadFolder(thread);
        const target = yield* threadPr(thread, cwd);
        if (target === undefined) return yield* noPullRequest;
        // Never from the cache: the PR row reads these checks too, and an answer it cached before
        // they failed says there is nothing to rerun.
        const runs = yield* pr
          .checks(cwd, target.number, target.repo, { fresh: true })
          .pipe(Effect.mapError((e) => new GitError({ message: e.message })));
        // `gh run rerun --failed` reruns cancelled jobs too.
        const failed = runs.filter(
          (run) => run.status === "failing" || run.conclusion?.toUpperCase() === "CANCELLED",
        );
        const runIds = [
          ...new Set(failed.flatMap((run) => (run.runId === undefined ? [] : [run.runId]))),
        ];
        const skipped = failed.filter((run) => run.runId === undefined).map((run) => run.name);
        if (runIds.length === 0) {
          return yield* new InvalidState({
            message:
              skipped.length === 0
                ? "No failed checks to rerun."
                : "The failed checks don't run on GitHub Actions, so rerun them on their provider.",
          });
        }
        // Refresh even when a later rerun fails, since earlier ones were already queued.
        yield* Effect.forEach(
          runIds,
          (runId) => reviews.rerun(cwd, target.repo, runId).pipe(Effect.mapError(toGitError)),
          { discard: true },
        ).pipe(Effect.ensuring(refreshes.request(cwd, true, { expectChange: true })));
        return { runIds, skipped };
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
        const cwd = yield* threadFolder(thread);
        const cached = (yield* publisher.stateFor(cwd))?.pr;
        const badge = cached ?? (yield* pr.status(cwd).pipe(Effect.mapError(toGitError)));
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
        // A network refresh, because only that pass prunes the badge the row was drawn from.
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
        const cwd = yield* threadFolder(thread);
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
        const cwd = yield* threadFolder(yield* store.getThread(threadId));
        const comment = yield* reviews
          .reply(cwd, reviewThreadId, body)
          .pipe(Effect.mapError(toGitError));
        yield* refreshes.request(cwd, true);
        return comment;
      }),

    "git.prResolveThread": ({ threadId, reviewThreadId }) =>
      Effect.gen(function* () {
        const cwd = yield* threadFolder(yield* store.getThread(threadId));
        yield* reviews.resolve(cwd, reviewThreadId).pipe(Effect.mapError(toGitError));
        yield* refreshes.request(cwd, true);
      }),

    "git.prRequestRereview": ({ threadId }) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId);
        const cwd = yield* threadFolder(thread);
        const target = yield* threadPr(thread, cwd);
        if (target === undefined) return yield* noPullRequest;
        const bots = reviewBotsOf(yield* store.getSettings);
        // Not the checkout's badge: a PR bound from another repository is reviewed by its own bot.
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
        yield* refreshes.request(cwd, true, { expectChange: true });
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
