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
  effectiveCheckout,
  embeddingOn,
  InvalidState,
  type NotFound,
  type Thread,
  type ThreadNotFound,
  type ThreadStatus,
} from "@gram/contracts";
import {
  type ExportThreadInput,
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
  restoreWipWorktree,
  sanitizeBranch,
  snapshotWip,
  WIP_PUSH_PROTOCOLS,
  wipCaughtUp,
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
import { registerRepo } from "../fs/folders.ts";
import { migrations } from "../persistence/migrations.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { makeClosedReopener } from "../rpc/handlers/closed-threads.ts";
import type { CheckoutService } from "../runtime/hooks.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
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
  /** The thread here becomes a read-only, archived copy saying where it went. */
  settleThread(
    input: SettleThreadInput,
  ): Effect.Effect<Thread, NotFound | ThreadNotFound | InvalidState>;
}

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
        if (checkout.hostId !== undefined) {
          return yield* refuse(
            "This thread runs on another machine; only a thread on this one can be moved from here.",
          );
        }
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
              if (caughtUp) return undefined;
            }
            yield* pushWip(checkout.path, snapshot, "origin", protocols);
            return snapshot;
          }),
        );
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
          repository: { name: cut(project.name, 2_000), remote: cut(remote, 2_000) },
          ...(checkout.branch === undefined ? {} : { branch: cut(checkout.branch, 2_000) }),
          ...(checkout.base === undefined ? {} : { base: cut(checkout.base, 2_000) }),
          ...(kept === undefined
            ? {}
            : { wip: { ref: kept.ref, commit: kept.commit, uncommitted: kept.uncommitted } }),
          notes,
        } satisfies ThreadBundle);
      });

    /**
     * A new worktree of the repository at `top` holding what the bundle kept: the edits from the
     * named ref at the named commit, or the branch's tip at the remote when nothing else was kept.
     */
    const placeWork = (top: string, bundle: ThreadBundle) =>
      withGit(
        "The thread's edits couldn't be put back here",
        Effect.gen(function* () {
          const branch = bundle.branch === undefined ? undefined : sanitizeBranch(bundle.branch);
          if (bundle.branch !== undefined && branch !== bundle.branch) {
            return yield* refuse("The bundle's branch isn't a branch name git takes.");
          }
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
              : branch !== undefined
                ? yield* fetchBranchTip(top, branch, "origin", protocols)
                : undefined;
          if (kept === undefined) {
            return yield* refuse(
              "The repository's remote doesn't hold the thread's edits. Move it again from the other server.",
            );
          }
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

    // One at a time: two imports of one thread would each make a worktree before either was refused.
    const importing = yield* Semaphore.make(1);
    const importOne: ThreadTransferShape["importThread"] = (input) =>
      Effect.gen(function* () {
        yield* requireOn;
        const { bundle } = input;
        if (bundle.app.schema > SCHEMA) {
          return yield* refuse(
            `This thread was exported by a newer Gram (${cut(bundle.app.version, 40)}) than this server runs. Update this server, then move it again.`,
          );
        }
        const conflict = yield* store.movedThreadConflict(
          bundle.thread.id,
          bundle.turns.map((turn) => turn.id),
        );
        if (conflict !== undefined) return yield* refuse(conflict);
        const { project } = yield* registerRepo(store, input.root);
        const here = yield* remoteOf(project.root);
        if (here === undefined || here !== bundle.repository.remote) {
          return yield* refuse(
            `${project.root} isn't a clone of ${cut(bundle.repository.remote, 200)}. Give the folder of that repository here.`,
          );
        }
        const top = project.root;
        const placed = yield* placeWork(top, bundle);
        const { dir } = placed;
        const notes: Array<string> = [...bundle.notes];
        if (placed.detached && bundle.branch !== undefined) {
          notes.push(
            `${bundle.branch} is checked out in another folder here, so the thread's folder holds its work on a detached HEAD.`,
          );
        }
        if (placed.ahead && bundle.branch !== undefined) {
          notes.push(
            `${bundle.branch} here already had all of the thread's work, and is used as it is.`,
          );
        }
        if (bundle.wip?.uncommitted === true) {
          notes.push("Its uncommitted edits are back as uncommitted files.");
        }
        const settings = yield* store.getSettings;
        const now = yield* Clock.currentTimeMillis;
        const { role: _role, workspaceId: _workspace, ...thread } = portableThread(bundle.thread);
        yield* store
          .stageMovedThread({
            thread: {
              ...thread,
              projectId: project.id,
              // This server's rules from here on: never a mode the bundle names.
              mode: settings.agents.defaultMode,
              checkout: {
                kind: "worktree",
                path: dir,
                repoRoot: top,
                ...(bundle.branch === undefined || placed.detached
                  ? {}
                  : { branch: bundle.branch }),
                ...(bundle.base === undefined ? {} : { base: bundle.base }),
              },
              transferredFrom: { name: input.from, at: now },
            },
            closedAt: now,
            messages: bundle.messages,
            turns: bundle.turns,
            plan: bundle.plan,
            turnPlan: bundle.turnPlan,
          })
          .pipe(
            // Nothing of it kept: the folder made for it goes too.
            Effect.onError(() =>
              withGit("", removeWorktreeDir(top, dir, true)).pipe(Effect.ignore),
            ),
          );
        const opened = yield* openMoved(bundle.thread.id);
        return { thread: opened, notes } satisfies ImportThreadResult;
      });
    const importThread: ThreadTransferShape["importThread"] = (input) =>
      importing.withPermits(1)(importOne(input));

    const settleThread: ThreadTransferShape["settleThread"] = (input) =>
      Effect.gen(function* () {
        yield* requireOn;
        const before = yield* store.getThread(input.threadId);
        if (before.transferredTo !== undefined) return before;
        const rested = yield* runtimes.restSession(input.threadId);
        if (rested === "working") {
          return yield* refuse(
            "This thread started a turn after it was exported, so its copy there is behind. Move it again.",
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
          },
        }));
        yield* hub.publish({ type: "thread.upsert", thread: settled });
        return settled;
      });

    return ThreadTransfer.of({ exportThread, importThread, settleThread });
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
