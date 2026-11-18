/**
 * Moving one thread from one Gram to another, with its work in progress, and back
 * (`docs/design/move-a-thread.md`). `exportThread` writes the thread as a bundle (`ThreadBundle`)
 * once its edits are kept on the hidden ref at its repository's remote; `importThread` on the other
 * Gram makes it again in a worktree of that repository with the edits put back; `settleThread`
 * here then leaves a read-only, archived copy saying where it went. All three sit behind the
 * hosted features setting and do nothing while it is off.
 *
 * What goes is what lets the thread carry on: its conversation, scrubbed as a workspace bundle's
 * is; its repository's shareable remote and its branch; and the hidden ref and commit its edits
 * are on. No agent's own session file goes: the thread's first session on the other side opens
 * fresh and reads its recent turns (`renderMovedSession`).
 *
 * Invariants. An export changes nothing here but the ref it pushes. An import replaces nothing: a
 * thread or turn already here refuses it before anything is written, and so does a remote that is
 * not the bundle's. A bundle is untrusted input: the thread opens in the folder made here, on this
 * server's default mode, its edits read only from a ref of that thread at exactly the commit the
 * bundle names. One home at a time: a settled thread here takes no more input.
 */
import {
  BUNDLE_MESSAGES_MAX,
  type Checkout,
  type CheckoutRequest,
  checkoutRequestHost,
  cloneFolderOf,
  effectiveCheckout,
  embeddingOn,
  hostServes,
  InvalidState,
  isLocalHost,
  type NotFound,
  type Project,
  type MovedToServer,
  type Thread,
  type ThreadNotFound,
  type ThreadStatus,
} from "@gram/contracts";
import {
  type ExportThreadInput,
  type ImportThreadForPersonInput,
  type ImportThreadInput,
  type ImportThreadResult,
  type SettleThreadInput,
  type ThreadBundle,
  THREAD_BUNDLE_FORMAT,
} from "@gram/contracts/thread-transfer";
import {
  cachedOriginUrl,
  copyWorktreeIncludes,
  excludeWorktreesFolder,
  fetchBranchTip,
  fetchWip,
  folderName,
  git,
  Proc,
  pushWip,
  randomWorktreeName,
  removeWorktreeDir,
  restoreWip,
  restoreWipWorktree,
  sanitizeBranch,
  setAsideFor,
  type WipKept,
  snapshotWip,
  WIP_PUSH_PROTOCOLS,
  wipCaughtUp,
  wipRef,
} from "@gram/git";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { existsSync } from "node:fs";
import * as nodePath from "node:path";
import { ServerConfig } from "../config.ts";
import { EventHub } from "../events/event-hub.ts";
import { cloneRepo } from "../fs/clone.ts";
import { registerRepo } from "../fs/folders.ts";
import { ReadingAs, SERVER } from "../embedding/readable-by.ts";
import { RemoteHosts } from "../host/remote-hosts.ts";
import { cloneIdentityOf, cloneUrlOf } from "../host/repos.ts";
import { keepThreadWork } from "../host/stop-resume.ts";
import { migrations } from "../persistence/migrations.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { makeClosedReopener } from "../rpc/handlers/closed-threads.ts";
import { CheckoutService } from "../runtime/hooks.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { fileOrigin } from "../thread-profiles/repositories.ts";
import { cut, portableThread, scrubbed, shareableRemote } from "./workspace-transfer.ts";

/** Why nothing here runs while the hosted features setting is off. */
export const THREAD_TRANSFER_OFF =
  "Moving a thread between servers is a hosted feature, and hosted features are off here.";

const SCHEMA = Object.keys(migrations).length;

/** The statuses in which a thread is in the middle of a turn, which no bundle can carry. */
const MID_TURN: ReadonlySet<ThreadStatus> = new Set([
  "starting",
  "running",
  "needsApproval",
  "needsInput",
]);

const refuse = (message: string) => new InvalidState({ message });

/** An id that may name a folder or a file: what Gram's own ids are, and nothing a path could use. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Why a bundle can't be taken in as it is, or `undefined`. Read before anything is written. */
export const threadBundleProblem = (bundle: ThreadBundle): string | undefined => {
  if (!SAFE_ID.test(bundle.thread.id)) return "The bundle's thread id is not one Gram makes.";
  const messages = new Set(bundle.messages.map(({ message }) => message.id));
  if (messages.size !== bundle.messages.length)
    return "The bundle's conversation has a message twice.";
  const turns = new Set<string>(bundle.turns.map((turn) => turn.id));
  if (turns.size !== bundle.turns.length) return "The bundle's conversation has a turn twice.";
  if (bundle.turns.some((turn) => !SAFE_ID.test(turn.id)))
    return "A turn id in the bundle is not one Gram makes.";
  if (bundle.messages.some(({ turnId }) => turnId !== undefined && !turns.has(turnId)))
    return "A message in the bundle belongs to a turn the bundle doesn't have.";
  if (bundle.wip === undefined && bundle.branch !== undefined && bundle.tip === undefined)
    return "The bundle names a branch but not the commit it was at.";
  return undefined;
};

/** What the import says to the person: the bundle's notes, then what happened here. */
const notesOf = (bundle: ThreadBundle, more: ReadonlyArray<string>) => [
  ...bundle.notes,
  ...more,
  ...(bundle.wip?.uncommitted === true
    ? ["Its uncommitted edits are back as uncommitted files."]
    : []),
];

export interface ThreadTransferShape {
  /**
   * The thread as a bundle, its edits kept on its hidden ref and pushed to its repository's
   * remote. Refused mid-turn, for a thread of a workspace, and for one that already moved.
   */
  exportThread(
    input: ExportThreadInput,
  ): Effect.Effect<ThreadBundle, NotFound | ThreadNotFound | InvalidState>;
  /**
   * Makes the bundle's thread here, in a new worktree of the repository at `root` with its edits
   * put back, and opens it. Nothing is kept when any of that fails.
   */
  importThread(
    input: ImportThreadInput,
  ): Effect.Effect<ImportThreadResult, NotFound | ThreadNotFound | InvalidState>;
  /**
   * Makes the bundle's thread here for a person the platform in front signed in, placed as a
   * thread they started would be: on their own machine on a server that runs no work itself,
   * in a clone of the repository here otherwise. Nothing is kept when any of that fails.
   */
  importThreadFor(
    input: ImportThreadForPersonInput,
  ): Effect.Effect<ImportThreadResult, NotFound | ThreadNotFound | InvalidState>;
  /** The thread here becomes a read-only, archived copy saying where it went. */
  settleThread(
    input: SettleThreadInput,
    by?: string,
  ): Effect.Effect<Thread, NotFound | ThreadNotFound | InvalidState>;
  /** The copy on the server the thread came back from is read-only now: it is open only here. */
  settledThere(threadId: Thread["id"]): Effect.Effect<Thread, ThreadNotFound | InvalidState>;
}

/** Who alone may read a moved thread here, and who brought it in, when a person did. */
interface Who {
  readonly reader?: string;
  readonly by?: string;
  /** The server it came back from, whose copy there is still open. */
  readonly leftOpen?: MovedToServer;
}

/**
 * Whether the thread here is the one this person's move of `input` brought in: the same export,
 * from the same Gram, brought in by them and still here. A later export of it is another move.
 */
const sameMove = (thread: Thread, input: ImportThreadForPersonInput): boolean =>
  thread.transferredFrom?.name === input.from &&
  thread.transferredFrom.exportedAt === input.bundle.exportedAt &&
  thread.transferredFrom.by === input.person &&
  thread.transferredTo === undefined;

/** Why the bundle itself can't come in here, whatever is here already. */
const admitShape = (bundle: ThreadBundle) =>
  Effect.gen(function* () {
    if (bundle.app.schema > SCHEMA) {
      return yield* refuse(
        `This thread was exported by a newer Gram (${cut(bundle.app.version, 40)}) than this server runs. Update this server, then move it again.`,
      );
    }
    const problem = threadBundleProblem(bundle);
    if (problem !== undefined) return yield* refuse(problem);
    const branch = bundle.branch === undefined ? undefined : sanitizeBranch(bundle.branch);
    if (bundle.branch !== undefined && branch !== bundle.branch) {
      return yield* refuse("The bundle's branch isn't a branch name git takes.");
    }
  });

/** The repository's own folder that a working tree at `at` belongs to. */
const commonDirOf = (at: string) =>
  git(at, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).pipe(
    Effect.map((out) => (out.status === 0 ? out.stdout.trim() : undefined)),
  );

/** Whether the folder at `dir` is a worktree of the repository at `top`. */
const ofRepository = (dir: string, top: string) =>
  Effect.gen(function* () {
    if (!existsSync(dir)) return false;
    const common = commonDirOf;
    const mine = yield* common(dir);
    return mine !== undefined && mine === (yield* common(top));
  }).pipe(Effect.orElseSucceed(() => false));

export interface ThreadTransferOptions {
  /** The git transports the ref may travel over. Tests allow `file`. */
  readonly protocols?: string;
}

const make = (options: ThreadTransferOptions) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const runtimes = yield* ThreadRuntimes;
    const hub = yield* EventHub;
    const config = yield* ServerConfig;
    const proc = Option.getOrUndefined(yield* Effect.serviceOption(Proc));
    const checkouts = yield* CheckoutService;
    const machines = Option.getOrUndefined(yield* Effect.serviceOption(RemoteHosts));
    const reopener = yield* makeClosedReopener();
    const protocols = options.protocols ?? WIP_PUSH_PROTOCOLS;

    const requireOn = Effect.gen(function* () {
      if (!embeddingOn(yield* store.getSettings)) return yield* refuse(THREAD_TRANSFER_OFF);
    });

    /** Git, or a refusal saying what of the move it couldn't do. */
    const withGit = <A, E>(what: string, effect: Effect.Effect<A, E, Proc>) =>
      proc === undefined
        ? Effect.fail(refuse("This server runs without git, so a thread's edits can't move."))
        : effect.pipe(
            Effect.provideService(Proc, proc),
            Effect.mapError((error) =>
              error instanceof InvalidState
                ? error
                : refuse(
                    `${what}: ${cut(String((error as { message?: unknown }).message ?? error), 400)}`,
                  ),
            ),
          );

    const remoteOf = (root: string) =>
      withGit(
        "The repository's origin couldn't be read",
        cachedOriginUrl(root).pipe(
          Effect.map((url) => (url === undefined ? undefined : shareableRemote(url))),
        ),
      );

    /** What every bundle carries of the thread itself: its conversation, scrubbed, and its plan. */
    const bundleOf = (
      thread: Thread,
      where: Pick<ThreadBundle, "repository" | "branch" | "base" | "tip" | "wip">,
      notes: Array<string>,
    ) =>
      Effect.gen(function* () {
        const history = yield* store.exportHistory(thread.id);
        const dropped = Math.max(0, history.messages.length - BUNDLE_MESSAGES_MAX);
        if (dropped > 0) {
          notes.push(
            `The conversation is longer than a bundle carries; its ${dropped} oldest messages stayed behind.`,
          );
        }
        const plan = yield* store.getPlan(thread.id);
        return scrubbed({
          format: THREAD_BUNDLE_FORMAT,
          app: { version: config.appVersion ?? "0.0.0", schema: SCHEMA },
          exportedAt: yield* Clock.currentTimeMillis,
          thread: portableThread(thread),
          messages: scrubbed(history.messages.slice(dropped), true),
          turns: history.turns.slice(-BUNDLE_MESSAGES_MAX),
          ...(plan.plan === undefined ? {} : { plan: plan.plan }),
          ...(plan.turnPlan === undefined ? {} : { turnPlan: plan.turnPlan }),
          ...where,
          notes,
        } satisfies ThreadBundle);
      });

    /**
     * A thread whose folder is on a joined machine, as a server that runs no work itself keeps a
     * person's: the machine keeps its edits under the hidden ref and pushes them
     * (`host.stop.keep`), as it does after each turn, and the bundle names what it kept.
     */
    const exportFromMachine = (thread: Thread, checkout: Checkout) =>
      Effect.gen(function* () {
        const url =
          checkout.cloneIdentity === undefined ? undefined : cloneUrlOf(checkout.cloneIdentity);
        const remote = url === undefined ? undefined : shareableRemote(url);
        if (machines === undefined || checkout.hostId === undefined || remote === undefined) {
          return yield* refuse(
            "This thread runs on another machine whose repository this server can't name, so its edits can't go with it.",
          );
        }
        const kept = yield* keepThreadWork({ hosts: machines }, checkout.hostId, thread).pipe(
          Effect.mapError((error) =>
            refuse(`The thread's edits couldn't be kept: ${cut(error.message, 400)}`),
          ),
        );
        const work = kept.find((each) => each.cwd === checkout.path);
        if (work === undefined || !work.pushed || work.commit === undefined) {
          return yield* refuse(
            `The thread's edits couldn't be kept${work?.note === undefined ? "." : `: ${cut(work.note, 400)}`}`,
          );
        }
        const project = (yield* store.listProjects).find((each) => each.id === thread.projectId);
        const branch = work.branch ?? checkout.branch;
        return yield* bundleOf(
          thread,
          {
            repository: {
              name: cut(project?.name ?? "repository", 2_000),
              remote: cut(remote, 2_000),
            },
            ...(branch === undefined ? {} : { branch: cut(branch, 2_000) }),
            ...(checkout.base === undefined ? {} : { base: cut(checkout.base, 2_000) }),
            ...(work.caughtUp === true || work.ref === undefined
              ? { tip: work.commit }
              : { wip: { ref: work.ref, commit: work.commit, uncommitted: false } }),
          },
          [],
        );
      });

    const exportThread: ThreadTransferShape["exportThread"] = (input) =>
      Effect.gen(function* () {
        yield* requireOn;
        const thread = yield* store.getThread(input.threadId);
        if (thread.transferredTo !== undefined) {
          return yield* refuse(
            `This thread moved to ${thread.transferredTo.name} already; move it from there.`,
          );
        }
        if (thread.role !== undefined || thread.workspaceId !== undefined) {
          return yield* refuse(
            "This thread belongs to a workspace, which moves as a whole. Move the workspace instead.",
          );
        }
        const status = yield* runtimes
          .status(thread.id)
          .pipe(Effect.orElseSucceed((): ThreadStatus => "cold"));
        if (MID_TURN.has(status)) {
          return yield* new InvalidState({
            message:
              "This thread is in the middle of a turn, which can't move with it. Move it once the turn has ended, or stop the turn first.",
            threadId: thread.id,
            status,
          });
        }
        const checkout = effectiveCheckout(thread);
        if (checkout.hostId !== undefined && !isLocalHost(checkout))
          return yield* exportFromMachine(thread, checkout);
        const project = (yield* store.listProjects).find((each) => each.id === thread.projectId);
        if (project === undefined)
          return yield* refuse("This thread's repository isn't a project here.");
        const remote = yield* remoteOf(project.root);
        if (remote === undefined) {
          return yield* refuse(
            `${project.name} has no origin another server could clone, so its edits can't go with it.`,
          );
        }
        const notes: Array<string> = [];
        // The edits: the working tree on top of HEAD, under the thread's hidden ref. When the
        // branch at the remote holds all of it, nothing needs keeping.
        const kept = yield* withGit(
          "The thread's edits couldn't be kept",
          Effect.gen(function* () {
            const snapshot = yield* snapshotWip(checkout.path, thread.id);
            if (checkout.branch !== undefined && !snapshot.uncommitted) {
              const caughtUp = yield* wipCaughtUp(
                checkout.path,
                snapshot,
                "origin",
                protocols,
              ).pipe(Effect.orElseSucceed(() => false));
              if (caughtUp) return { tip: snapshot.commit };
            }
            yield* pushWip(checkout.path, snapshot, "origin", protocols);
            return { snapshot };
          }),
        );
        return yield* bundleOf(
          thread,
          {
            repository: { name: cut(project.name, 2_000), remote: cut(remote, 2_000) },
            ...(checkout.branch === undefined ? {} : { branch: cut(checkout.branch, 2_000) }),
            ...(checkout.base === undefined ? {} : { base: cut(checkout.base, 2_000) }),
            ...("tip" in kept
              ? { tip: kept.tip }
              : {
                  wip: {
                    ref: kept.snapshot.ref,
                    commit: kept.snapshot.commit,
                    uncommitted: kept.snapshot.uncommitted,
                  },
                }),
          },
          notes,
        );
      });

    /**
     * A new worktree of the repository at `top` holding what the bundle kept: the edits from the
     * named ref at the named commit, or the branch's tip at the remote when nothing else was kept.
     */
    /** What the bundle kept, fetched into the repository at `top` from its remote. */
    const fetchKept = (top: string, bundle: ThreadBundle, branch: string | undefined) =>
      Effect.gen(function* () {
        const kept =
          bundle.wip !== undefined
            ? yield* fetchWip(
                top,
                bundle.thread.id,
                "origin",
                protocols,
                bundle.wip.commit,
                bundle.wip.ref,
              )
            : branch !== undefined && bundle.tip !== undefined
              ? yield* fetchBranchTip(top, branch, "origin", protocols, bundle.tip)
              : undefined;
        if (kept === undefined) {
          return yield* refuse(
            "The repository's remote doesn't hold the thread's edits. Move it again from the other server.",
          );
        }
        return kept;
      });

    const placeWork = (top: string, bundle: ThreadBundle) =>
      withGit(
        "The thread's edits couldn't be put back here",
        Effect.gen(function* () {
          const branch = bundle.branch === undefined ? undefined : sanitizeBranch(bundle.branch);
          if (bundle.branch !== undefined && branch !== bundle.branch) {
            return yield* refuse("The bundle's branch isn't a branch name git takes.");
          }
          const kept = yield* fetchKept(top, bundle, branch);
          const common = (yield* git(top, [
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ])).stdout.trim();
          if (common !== "") yield* Effect.sync(() => excludeWorktreesFolder(common));
          // A branch already checked out in a folder of this repository stays there as it is:
          // the thread's folder then holds its commit, detached, rather than move it.
          const listed = (yield* git(top, ["worktree", "list", "--porcelain"])).stdout;
          const busy =
            branch !== undefined && listed.split("\n").includes(`branch refs/heads/${branch}`);
          let dir = nodePath.join(top, ".worktrees", folderName(branch ?? randomWorktreeName()));
          while (existsSync(dir)) dir = nodePath.join(top, ".worktrees", randomWorktreeName());
          const { ahead } = yield* restoreWipWorktree(top, dir, kept, busy ? undefined : branch);
          yield* copyWorktreeIncludes(top, dir);
          return { dir, detached: busy, ahead };
        }),
      );

    /** The staged thread opened as a closed one is: taken off the list and made again. */
    const openMoved = (threadId: Thread["id"]) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const taken = yield* store.takeClosed(threadId);
          if (taken === undefined)
            return yield* refuse("The thread's record couldn't be read back.");
          const putBack = store.getThread(threadId).pipe(
            Effect.option,
            Effect.flatMap((made) =>
              Option.isSome(made)
                ? Effect.void
                : store.rememberClosed(taken.closed.thread, taken.closed.closedAt, []),
            ),
          );
          yield* restore(reopener.reopenTaken(taken.closed, [])).pipe(
            Effect.onInterrupt(() => putBack),
            Effect.tapError(() => putBack),
            Effect.mapError((error) =>
              refuse(`${error.message} The thread is in the closed threads; reopen it from there.`),
            ),
          );
          return yield* store.getThread(threadId);
        }),
      );

    /** Why the bundle can't come in here, read before anything is written; nothing when it can. */
    const admit = (bundle: ThreadBundle) =>
      Effect.gen(function* () {
        yield* admitShape(bundle);
        const conflict = yield* store.movedThreadConflict(
          bundle.thread.id,
          bundle.turns.map((turn) => turn.id),
        );
        if (conflict !== undefined) return yield* refuse(conflict);
      });

    /**
     * The thread recorded in the folder made for it and opened. Until the record is written, any
     * failure runs `undo`, which takes that folder back; after it, the record keeps the folder,
     * closed, when the thread can't be opened. `who` says who alone may read it here, and who
     * brought it in, if anyone.
     */
    const stage = (
      bundle: ThreadBundle,
      from: string,
      project: Project,
      checkout: Checkout,
      undo: Effect.Effect<void>,
      who: Who,
      returning = false,
    ) =>
      Effect.gen(function* () {
        const written = returning
          ? movedRecord(bundle, from, project, checkout, who).pipe(
              Effect.flatMap((moved) => store.returnMovedThread(moved)),
            )
          : record(bundle, from, project, checkout, who);
        yield* written.pipe(Effect.onError(() => undo));
        return yield* openMoved(bundle.thread.id);
      });

    const record = (
      bundle: ThreadBundle,
      from: string,
      project: Project,
      checkout: Checkout,
      who: Who,
    ) =>
      movedRecord(bundle, from, project, checkout, who).pipe(
        Effect.flatMap((moved) => store.stageMovedThread(moved)),
      );

    /** The bundle's thread as it is recorded here, closed for a reopen to open. */
    const movedRecord = (
      bundle: ThreadBundle,
      from: string,
      project: Project,
      checkout: Checkout,
      who: Who,
    ) =>
      Effect.gen(function* () {
        const settings = yield* store.getSettings;
        const now = yield* Clock.currentTimeMillis;
        // Who may read it is this server's to say too: the bundle's reader is another Gram's
        // subject, and reading as it would lend that identity to this thread's tools.
        const {
          role: _role,
          workspaceId: _workspace,
          readableBy: _reader,
          ...thread
        } = portableThread(bundle.thread);
        // The bundle names its agent and model; how it runs here (a gateway profile, its
        // effort, its speed) is this server's to say.
        const model = { agent: thread.model.agent, model: thread.model.model };
        const base =
          bundle.base !== undefined && sanitizeBranch(bundle.base) === bundle.base
            ? bundle.base
            : undefined;
        return {
          thread: {
            ...thread,
            model,
            projectId: project.id,
            // This server's rules from here on: never a mode the bundle names.
            mode: settings.agents.defaultMode,
            checkout: {
              ...checkout,
              ...(base === undefined ? {} : { base }),
            },
            transferredFrom: {
              name: from,
              at: now,
              exportedAt: bundle.exportedAt,
              ...(who.by === undefined ? {} : { by: who.by }),
              ...(who.leftOpen === undefined ? {} : { leftOpen: who.leftOpen }),
            },
            ...(who.reader === undefined ? {} : { readableBy: who.reader }),
          },
          closedAt: now,
          messages: bundle.messages,
          turns: bundle.turns,
          plan: bundle.plan,
          turnPlan: bundle.turnPlan,
        };
      });

    /** The read-only copy here of a thread that moved from here, open or on the closed list. */
    const copyOf = (threadId: Thread["id"]) =>
      Effect.gen(function* () {
        const open = yield* store.getThread(threadId).pipe(Effect.option);
        if (Option.isSome(open))
          return open.value.transferredTo === undefined
            ? undefined
            : { thread: open.value, open: true };
        const closed = (yield* store.listClosed).find((each) => each.thread.id === threadId);
        return closed?.thread.transferredTo === undefined
          ? undefined
          : { thread: closed.thread, open: false };
      });

    /**
     * The thread back where it moved from: it takes the place of its read-only copy here. Its
     * folder here, when it is still there, takes its edits back, with whatever the person did in
     * it since put aside on a branch of its own first; otherwise it gets a new worktree, as an
     * import does. Nothing of the copy is lost: its conversation stays where the bundle's starts
     * later (`returnMovedThread`).
     */
    const returnHere = (
      input: ImportThreadInput,
      copy: { readonly thread: Thread; readonly open: boolean },
      who: Who,
    ) =>
      Effect.gen(function* () {
        const { bundle } = input;
        yield* admitShape(bundle);
        const here = yield* remoteOf(input.root);
        if (here === undefined || here !== bundle.repository.remote) {
          return yield* refuse(
            `${input.root} isn't a clone of ${cut(bundle.repository.remote, 200)}. Give the folder of that repository here.`,
          );
        }
        const { project } = yield* registerRepo(store, input.root);
        const top = project.root;
        const branch = bundle.branch;
        const was = effectiveCheckout(copy.thread);
        const ours =
          was.kind === "worktree" &&
          was.hostId === undefined &&
          proc !== undefined &&
          (yield* withGit("", ofRepository(was.path, top)).pipe(Effect.orElseSucceed(() => false)));
        // Read before anything here changes, so a refusal leaves the copy as it was: what the
        // folder held as it left (before the fetch moves the ref), and the work coming back.
        const left = ours
          ? (yield* withGit(
              "",
              git(top, [
                "rev-parse",
                "--verify",
                "--quiet",
                `${wipRef(bundle.thread.id)}^{commit}`,
              ]),
            ).pipe(Effect.orElseSucceed(() => ({ stdout: "" })))).stdout.trim()
          : "";
        const kept = yield* withGit(
          "The thread's edits couldn't be fetched here",
          fetchKept(top, bundle, branch),
        );
        // Its branch in another folder of the repository: the folder can't take it back in place,
        // so it gets a new one, as an import does.
        const busy =
          ours && branch !== undefined
            ? (yield* withGit("", git(top, ["worktree", "list", "--porcelain", "-z"])).pipe(
                Effect.orElseSucceed(() => ({ stdout: "" })),
              )).stdout
                .split("\0\0")
                .some((entry) => {
                  const fields = entry.split("\0");
                  const at = fields.find((field) => field.startsWith("worktree "))?.slice(9);
                  return (
                    at !== undefined &&
                    nodePath.resolve(at) !== nodePath.resolve(was.path) &&
                    fields.includes(`branch refs/heads/${branch}`)
                  );
                })
            : false;
        const inPlace = ours && !busy;
        // The copy steps aside, onto the closed list with its folder kept; anything that fails
        // from here on opens it again as it was.
        if (copy.open) {
          yield* runtimes
            .close(bundle.thread.id, {})
            .pipe(
              Effect.mapError((error) =>
                refuse(`The copy here couldn't make way: ${cut(error.message, 300)}`),
              ),
            );
        }
        return yield* placeReturned(input, project, was, inPlace, kept, left, who).pipe(
          Effect.onError(() => reopenCopy(bundle.thread.id)),
        );
      });

    /** The copy, put on the closed list for a return that then failed, open again as it was. */
    const reopenCopy = (threadId: Thread["id"]) =>
      Effect.gen(function* () {
        if (Option.isSome(yield* store.getThread(threadId).pipe(Effect.option))) return;
        const closed = (yield* store.listClosed).find((each) => each.thread.id === threadId);
        if (closed?.thread.transferredTo === undefined) return;
        const taken = yield* store.takeClosed(threadId);
        if (taken === undefined) return;
        yield* reopener
          .reopenTaken(taken.closed, [])
          .pipe(
            Effect.catch(() =>
              store.rememberClosed(taken.closed.thread, taken.closed.closedAt, []),
            ),
          );
      }).pipe(Effect.ignore);

    /** The returning thread's folder made here, and the thread recorded in it and opened. */
    const placeReturned = (
      input: ImportThreadInput,
      project: Project,
      was: Checkout,
      inPlace: boolean,
      kept: WipKept,
      left: string,
      who: Who,
    ) =>
      Effect.gen(function* () {
        const { bundle } = input;
        const top = project.root;
        const branch = bundle.branch;
        const now = yield* Clock.currentTimeMillis;
        const more: Array<string> = [];
        let checkout: Checkout;
        let undo: Effect.Effect<void> = Effect.void;
        if (inPlace) {
          const stamp = new Date(now).toISOString().slice(0, 16).replace(/[-:T]/g, "");
          const aside = `aside/${folderName(branch ?? bundle.thread.id)}-${stamp}`;
          const put = yield* withGit(
            "The thread's edits couldn't be put back in its folder here",
            Effect.gen(function* () {
              const setAside = yield* setAsideFor(
                was.path,
                kept,
                branch,
                aside,
                left === "" ? undefined : left,
              );
              yield* restoreWip(was.path, kept, branch);
              return setAside;
            }),
          );
          if (put !== undefined) {
            more.push(`What you changed in its folder here since it left is on the branch ${put}.`);
          }
          checkout = {
            kind: "worktree",
            path: was.path,
            repoRoot: top,
            ...(branch === undefined ? {} : { branch }),
          };
        } else {
          const placed = yield* placeWork(top, bundle);
          if (placed.detached && branch !== undefined) {
            more.push(
              `${branch} is checked out in another folder here, so the thread's folder holds its work on a detached HEAD.`,
            );
          }
          checkout = {
            kind: "worktree",
            path: placed.dir,
            repoRoot: top,
            ...(branch === undefined || placed.detached ? {} : { branch }),
          };
          undo = withGit("", removeWorktreeDir(top, placed.dir, true)).pipe(Effect.ignore);
        }
        const moved = yield* movedRecord(bundle, input.from, project, checkout, who);
        yield* store
          .returnMovedThread({ ...moved, closedAt: now })
          .pipe(Effect.onError(() => undo));
        const thread = yield* openMoved(bundle.thread.id);
        return { thread, notes: notesOf(bundle, more) } satisfies ImportThreadResult;
      });

    /** The thread in a new worktree of the repository at `root`, on this machine. */
    const importHere = (input: ImportThreadInput, who: Who = {}) =>
      Effect.gen(function* () {
        const { bundle } = input;
        // The same move asked again, as when the first answer never came: the thread it made,
        // open here, is the answer, and nothing is made twice.
        const open = yield* store.getThread(bundle.thread.id).pipe(Effect.option);
        if (
          Option.isSome(open) &&
          open.value.transferredTo === undefined &&
          open.value.transferredFrom?.name === input.from &&
          open.value.transferredFrom.exportedAt === bundle.exportedAt &&
          open.value.transferredFrom.by === who.by
        )
          return { thread: open.value, notes: [] } satisfies ImportThreadResult;
        const copy = yield* copyOf(bundle.thread.id);
        if (copy !== undefined) return yield* returnHere(input, copy, who);
        yield* admit(bundle);
        // Before the folder becomes a project here: a wrong one leaves nothing behind.
        const here = yield* remoteOf(input.root);
        if (here === undefined || here !== bundle.repository.remote) {
          return yield* refuse(
            `${input.root} isn't a clone of ${cut(bundle.repository.remote, 200)}. Give the folder of that repository here.`,
          );
        }
        const { project } = yield* registerRepo(store, input.root);
        const top = project.root;
        const placed = yield* placeWork(top, bundle);
        const { dir } = placed;
        const more: Array<string> = [];
        if (placed.detached && bundle.branch !== undefined) {
          more.push(
            `${bundle.branch} is checked out in another folder here, so the thread's folder holds its work on a detached HEAD.`,
          );
        }
        if (placed.ahead && bundle.branch !== undefined) {
          more.push(
            `${bundle.branch} here already had all of the thread's work, and is used as it is.`,
          );
        }
        const thread = yield* stage(
          bundle,
          input.from,
          project,
          {
            kind: "worktree",
            path: dir,
            repoRoot: top,
            ...(bundle.branch === undefined || placed.detached ? {} : { branch: bundle.branch }),
          },
          withGit("", removeWorktreeDir(top, dir, true)).pipe(Effect.ignore),
          who,
        );
        return {
          thread,
          notes: notesOf(bundle, more),
        } satisfies ImportThreadResult;
      });

    /**
     * The thread on the joined machine this server places a person's work on: the machine clones
     * the repository, if it hasn't, and makes the thread's folder from the ref and commit the
     * bundle names (`host.stop.restore` with `ref`), or from the branch at exactly its commit.
     */
    const importOnMachine = (input: ImportThreadForPersonInput, who: Who, returning = false) =>
      Effect.gen(function* () {
        const { bundle } = input;
        const url = bundle.repository.remote;
        const filed = yield* withGit(
          "The repository couldn't be filed here",
          Effect.suspend(() => fileOrigin(proc!, config.dataDir, url)),
        );
        // Before anything is made on the machine: a failure here leaves nothing there.
        const project = yield* store.ensureProject({ root: filed.path, name: filed.name });
        const branch = bundle.branch;
        const asked: CheckoutRequest = { kind: "newWorktree", branch: branch ?? "moved" };
        const placed = checkouts.place === undefined ? asked : yield* checkouts.place(asked);
        const hostId = checkoutRequestHost(placed);
        if (hostId === undefined || isLocalHost({ hostId }) || machines === undefined) {
          return yield* refuse(
            "There is no machine of yours running here to take the thread. Start one, then move it again.",
          );
        }
        const connection = yield* machines
          .connection(hostId)
          .pipe(Effect.mapError((error) => refuse(error.message)));
        const restore = connection.stop.restore;
        if (restore === undefined || !hostServes(connection.hello, "wip-restore-ref")) {
          return yield* refuse(
            "Your machine here runs an older Gram that can't take a moved thread. Restart it, then move it again.",
          );
        }
        const expected = bundle.wip?.commit ?? bundle.tip;
        if (expected === undefined) {
          return yield* refuse(
            "The repository's remote doesn't hold the thread's edits. Move it again from the other server.",
          );
        }
        // Bounded, as the restore is by the host protocol: the import holds this thread's lock
        // and can't be interrupted, so no call of it may wait forever on a machine that stalls.
        const { path: repoPath } = yield* connection.repos.ensure(url).pipe(
          Effect.mapError((error) => refuse(cut(error.message, 400))),
          Effect.timeoutOrElse({
            duration: "10 minutes",
            orElse: () =>
              Effect.fail(refuse("Your machine took too long to clone the repository.")),
          }),
        );
        // The machine's paths, which may not be this server's kind of path.
        const join =
          repoPath.includes("\\") && !repoPath.includes("/")
            ? nodePath.win32.join
            : nodePath.posix.join;
        const restoreAt = (cwd: string, onBranch = true) =>
          restore({
            threadId: bundle.thread.id,
            cwd,
            url,
            ...(branch === undefined || !onBranch ? {} : { branch }),
            commit: expected,
            ...(bundle.wip === undefined ? { caughtUp: true } : { ref: bundle.wip.ref }),
          }).pipe(
            Effect.mapError((error) =>
              refuse(
                `The thread's edits couldn't be put back on your machine: ${cut(error.message, 400)}`,
              ),
            ),
          );
        let cwd = join(repoPath, ".worktrees", folderName(branch ?? randomWorktreeName()));
        let answer = yield* restoreAt(cwd);
        // A folder of that name is there already, somebody's: one of a name of its own.
        if (!answer.restored && answer.note === "Its folder is there already.") {
          cwd = join(repoPath, ".worktrees", randomWorktreeName());
          answer = yield* restoreAt(cwd);
        }
        // Coming back, its branch may still be in the folder it had here before, which stays as
        // it is: the new folder then holds its work on a detached HEAD.
        let detached = false;
        if (
          returning &&
          branch !== undefined &&
          !answer.restored &&
          answer.note?.includes("is checked out in") === true
        ) {
          detached = true;
          answer = yield* restoreAt(cwd, false);
        }
        if (!answer.restored) {
          return yield* refuse(
            `The thread's edits couldn't be put back on your machine${answer.note === undefined ? "." : `: ${cut(answer.note, 400)}`}`,
          );
        }
        const undo = connection.worktrees
          .remove({
            repoPath,
            worktreeDir: cwd,
            force: true,
            openCheckouts: [],
          })
          .pipe(Effect.timeout("2 minutes"), Effect.ignore);
        // The branch at the remote may have moved since: only the commit the bundle names is taken.
        if (answer.commit !== expected) {
          yield* undo;
          return yield* refuse(
            "The thread's branch at the remote moved since it was exported. Move it again from the other server.",
          );
        }
        const cloneIdentity = cloneIdentityOf(url);
        const thread = yield* stage(
          bundle,
          input.from,
          project,
          {
            kind: "worktree",
            path: cwd,
            hostId,
            repoRoot: repoPath,
            ...(branch === undefined || detached ? {} : { branch }),
            ...(cloneIdentity === undefined ? {} : { cloneIdentity }),
          },
          undo,
          who,
          returning,
        );
        return {
          thread,
          notes: notesOf(bundle, [
            ...(answer.note === undefined ? [] : [cut(answer.note, 400)]),
            ...(detached
              ? [
                  `${branch} is still checked out in the folder it had here before, so its new folder holds its work on a detached HEAD.`,
                ]
              : []),
          ]),
        } satisfies ImportThreadResult;
        // Once the machine has started on the folder, the import runs to its end or its undo: a
        // caller that gives up mid-way leaves no folder nobody records.
      }).pipe(Effect.uninterruptible);

    /** For a person: on their machine where this server runs no work, else a clone of it here. */
    const importFor = (input: ImportThreadForPersonInput) =>
      Effect.gen(function* () {
        // The same move asked again, as when the first answer never reached the platform: the
        // thread it made, open here, is the answer, and nothing is made twice.
        const here = yield* store.getThread(input.bundle.thread.id).pipe(Effect.option);
        if (Option.isSome(here) && sameMove(here.value, input))
          return { thread: here.value, notes: [] } satisfies ImportThreadResult;
        // A thread only one person could read stays only theirs: the person bringing it in.
        const who: Who = {
          by: input.person,
          ...(input.bundle.thread.readableBy === undefined ? {} : { reader: input.person }),
        };
        const copy = yield* copyOf(input.bundle.thread.id);
        if (copy !== undefined) {
          // Only the person who took it away brings it back: whoever it went for, else whoever
          // brought it here, else whoever alone could read it.
          const owner =
            copy.thread.transferredTo?.by ??
            copy.thread.transferredFrom?.by ??
            copy.thread.readableBy;
          if (owner === undefined || owner !== input.person)
            return yield* refuse("This thread is already on this server.");
          if (config.headless === true) {
            yield* admitShape(input.bundle);
            if (copy.open) {
              yield* runtimes
                .close(input.bundle.thread.id, {})
                .pipe(
                  Effect.mapError((error) =>
                    refuse(`The copy here couldn't make way: ${cut(error.message, 300)}`),
                  ),
                );
            }
            return yield* importOnMachine(input, who, true);
          }
        } else {
          yield* admit(input.bundle);
        }
        if (config.headless === true) return yield* importOnMachine(input, who);
        const project = yield* withGit(
          "The repository couldn't be cloned here",
          store.getSettings.pipe(
            Effect.flatMap((settings) =>
              cloneRepo(store, {
                remote: input.bundle.repository.remote,
                cloneFolder: cloneFolderOf(settings),
              }),
            ),
          ),
        );
        return yield* importHere(
          { bundle: input.bundle, root: project.root, from: input.from },
          who,
        );
      });

    // One at a time for a thread: two imports of one thread would each make a worktree before
    // either was refused. Other threads' imports, a clone on someone else's machine say, go on.
    const locks = new Map<string, { readonly lock: Semaphore.Semaphore; users: number }>();
    const oneAtATime = <A, E>(threadId: string, effect: Effect.Effect<A, E>) =>
      Effect.acquireUseRelease(
        // In one step, so two imports of a thread never make a lock each.
        Effect.sync(() => {
          const held = locks.get(threadId) ?? { lock: Semaphore.makeUnsafe(1), users: 0 };
          held.users += 1;
          locks.set(threadId, held);
          return held;
        }),
        (held) => held.lock.withPermits(1)(effect),
        (held) =>
          Effect.sync(() => {
            held.users -= 1;
            if (held.users === 0) locks.delete(threadId);
          }),
      );
    const importThread: ThreadTransferShape["importThread"] = (input) =>
      requireOn.pipe(
        Effect.andThen(
          oneAtATime(
            input.bundle.thread.id,
            importHere(input, input.server === undefined ? {} : { leftOpen: input.server }),
          ),
        ),
      );
    const importThreadFor: ThreadTransferShape["importThreadFor"] = (input) =>
      requireOn.pipe(
        Effect.andThen(oneAtATime(input.bundle.thread.id, importFor(input))),
        // The platform's work: the thread it makes is read back whoever alone may read it.
        Effect.provideService(ReadingAs, SERVER),
      );

    const settleThread: ThreadTransferShape["settleThread"] = (input, by) =>
      Effect.gen(function* () {
        yield* requireOn;
        const before = yield* store.getThread(input.threadId);
        if (before.transferredTo !== undefined) return before;
        if (before.lastActivityAt > input.exportedAt) {
          return yield* refuse(
            "This thread carried on after it was exported, so its copy there is behind. Carry on in one of the two; moving it again makes another copy there.",
          );
        }
        const rested = yield* runtimes.restSession(input.threadId);
        if (rested === "working") {
          return yield* refuse(
            "This thread started a turn after it was exported, so its copy there is behind. Carry on in one of the two; moving it again makes another copy there.",
          );
        }
        const at = yield* Clock.currentTimeMillis;
        const settled = yield* store.updateThread(input.threadId, (thread) => ({
          ...thread,
          parked: true,
          transferredTo: {
            name: input.to,
            at,
            ...(input.url === undefined ? {} : { url: input.url }),
            ...(input.server === undefined ? {} : { server: input.server }),
            ...(by === undefined ? {} : { by }),
          },
        }));
        yield* hub.publish({ type: "thread.upsert", thread: settled });
        return settled;
      });

    const settledThere: ThreadTransferShape["settledThere"] = (threadId) =>
      Effect.gen(function* () {
        yield* requireOn;
        const thread = yield* store.updateThread(threadId, (was) => {
          if (was.transferredFrom?.leftOpen === undefined) return was;
          const { leftOpen: _settled, ...from } = was.transferredFrom;
          return { ...was, transferredFrom: from };
        });
        yield* hub.publish({ type: "thread.upsert", thread });
        return thread;
      });

    return ThreadTransfer.of({
      exportThread,
      importThread,
      importThreadFor,
      settleThread,
      settledThere,
    });
  });

export class ThreadTransfer extends Context.Service<ThreadTransfer, ThreadTransferShape>()(
  "@gram/server/ThreadTransfer",
) {
  static readonly layerWith = (
    options: ThreadTransferOptions,
  ): Layer.Layer<
    ThreadTransfer,
    never,
    ThreadStore | ThreadRuntimes | CheckoutService | EventHub | ServerConfig
  > => Layer.effect(ThreadTransfer, make(options));
  static readonly layer = ThreadTransfer.layerWith({});
}
