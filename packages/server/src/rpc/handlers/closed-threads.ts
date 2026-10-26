import {
  InvalidState,
  NotFound,
  type Checkout,
  type CheckoutRequest,
  type ClosedThread,
  type ReopenedClosedThread,
  type Thread,
} from "@gram/contracts";
import { samePath } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { resolveFolder } from "../../fs/folders.ts";
import { Orchestration, type ReopenFields } from "../../orchestration/service.ts";
import { type ClosedWorker, ThreadStore } from "../../persistence/thread-store.ts";
import { heldCheckoutPaths, makeThreadCreator } from "../../runtime/create-in-checkout.ts";
import { CheckoutService } from "../../runtime/hooks.ts";
import { ThreadRuntimes } from "../../runtime/thread-runtimes.ts";
import type { Handlers } from "./common.ts";

/**
 * `threads.closed.list`: the last closed threads, newest first, each marked with what's changed since
 * it closed. `threads.closed.reopen`: the newest one, taken off the list and opened again from its
 * stored record. `resolve` checks a checkout folder; tests swap it to simulate errors.
 */
export const makeClosedThreadHandlers = (
  resolve: (path: string) => Effect.Effect<string, NotFound | InvalidState> = resolveFolder,
) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const runtimes = yield* ThreadRuntimes;
    const checkouts = yield* CheckoutService;
    // Absent in runtime-only test layers, where no thread is in a workspace.
    const orchestration = Option.getOrUndefined(yield* Effect.serviceOption(Orchestration));
    const creator = makeThreadCreator({ store, checkouts, runtimes });

    const withProblems = (closed: ReadonlyArray<ClosedThread>) =>
      Effect.gen(function* () {
        const open = new Map(
          (yield* store.listThreads).flatMap((t) =>
            t.agentSessionId === undefined ? [] : [[t.agentSessionId, t.id] as const],
          ),
        );
        return yield* Effect.forEach(closed, (entry) =>
          Effect.gen(function* () {
            const session = entry.thread.agentSessionId;
            const openThreadId = session === undefined ? undefined : open.get(session);
            if (openThreadId !== undefined) {
              return { ...entry, problem: "sessionOpen" as const, openThreadId };
            }
            // Only a folder that's definitely gone counts. A permission error (EPERM while Windows
            // finishes a delete or antivirus holds the folder, EACCES on a share) is left to the
            // reopen, which shows the real error.
            const missing = yield* resolve(entry.thread.checkout.path).pipe(
              Effect.match({
                onFailure: (error) => error instanceof NotFound,
                onSuccess: () => false,
              }),
            );
            return missing ? { ...entry, problem: "folderMissing" as const } : entry;
          }),
        );
      });

    /**
     * The checkout a closed thread comes back in. One whose folder is gone comes back in it as it
     * was, for the folder-missing flow to restore, unless another thread holds that path now.
     */
    const checkoutFor = (thread: Thread, folderMissing: boolean) =>
      Effect.gen(function* () {
        const { checkout } = thread;
        const projectRoot =
          checkout.kind === "worktree" ? (checkout.repoRoot ?? checkout.path) : checkout.path;
        if (folderMissing) {
          const held = heldCheckoutPaths(yield* store.listThreads);
          if (held.some((path) => samePath(path, checkout.path))) {
            return yield* new InvalidState({ message: "That checkout is already open elsewhere." });
          }
          return { projectRoot, checkout };
        }
        // Folders first, so a typo reads "Folder not found" rather than a git or platform failure.
        const root = yield* resolve(projectRoot);
        const request: CheckoutRequest =
          checkout.kind === "worktree"
            ? { kind: "existingWorktree", path: yield* resolve(checkout.path) }
            : { kind: "current" };
        return { projectRoot: root, checkout: yield* creator.prepare(request, root) };
      });

    /** A worker's worktrees in other repos that are still there and nobody else holds. */
    const extrasOf = (thread: Thread) =>
      Effect.gen(function* () {
        const held = heldCheckoutPaths(yield* store.listThreads);
        return yield* Effect.filter(thread.extraCheckouts ?? [], (extra: Checkout) =>
          held.some((path) => samePath(path, extra.path))
            ? Effect.succeed(false)
            : checkouts.present(extra.path),
        );
      });

    /** The closed thread again under its own id, with its conversation, from its stored record. */
    const reopenFrom = (thread: Thread, folderMissing: boolean) => (fields: ReopenFields) =>
      Effect.gen(function* () {
        const where = yield* checkoutFor(thread, folderMissing);
        const extraCheckouts = yield* extrasOf(thread);
        // A worker's other worktrees are its directory grants too: one it can't have back goes
        // from both, and grants of its own, such as folders it was given to read, stay.
        const rejected = (thread.extraCheckouts ?? []).filter(
          (extra) => !extraCheckouts.some((kept) => samePath(kept.path, extra.path)),
        );
        const additionalDirectories = (thread.additionalDirectories ?? []).filter(
          (dir) => !rejected.some((extra) => samePath(extra.path, dir)),
        );
        return yield* runtimes.create({
          id: thread.id,
          projectRoot: where.projectRoot,
          checkout: where.checkout,
          model: thread.model,
          mode: thread.mode,
          title: thread.title,
          restoreClosedHistory: true,
          kept: {
            userNamed: thread.userNamed,
            labels: thread.labels,
            pinned: thread.pinned,
            ...(thread.agentNamed === undefined ? {} : { agentNamed: thread.agentNamed }),
            ...(thread.boundPr === undefined ? {} : { boundPr: thread.boundPr }),
            ...(thread.extraPrs === undefined ? {} : { extraPrs: thread.extraPrs }),
          },
          // A session that never received a message has no transcript to continue.
          ...(thread.agentSessionId === undefined || thread.agentSessionUnused === true
            ? {}
            : {
                resumeSessionId: thread.agentSessionId,
                ...(thread.codexHome === undefined ? {} : { codexHome: thread.codexHome }),
              }),
          ...(additionalDirectories.length === 0 ? {} : { additionalDirectories }),
          ...(extraCheckouts.length === 0 ? {} : { extraCheckouts }),
          ...fields,
          // A missing folder reopens cold: there's nowhere to run a provider.
          ...(folderMissing ? { deferOpen: true } : {}),
        });
      });

    /** A taken entry opened again; one whose session another thread shows is only named. */
    const reopenTaken = (entry: ClosedThread, workers: ReadonlyArray<ClosedWorker>) =>
      Effect.gen(function* () {
        const [closed = entry] = yield* withProblems([entry]);
        if (closed.problem === "sessionOpen") return { closed } satisfies ReopenedClosedThread;
        const { thread } = closed;
        const create = reopenFrom(thread, closed.problem === "folderMissing");
        const reopened =
          orchestration === undefined
            ? { thread: yield* create({}), membership: undefined }
            : yield* orchestration.reopen(thread, workers, create);
        return {
          closed,
          thread: reopened.thread,
          ...(reopened.membership === undefined ? {} : { membership: reopened.membership }),
        } satisfies ReopenedClosedThread;
      }).pipe(Effect.map((result): ReopenedClosedThread | null => result));

    return {
      "threads.closed.list": () => store.listClosed.pipe(Effect.flatMap(withProblems)),
      "threads.closed.reopen": () =>
        // Taken and guarded with nothing able to interrupt in between, so an entry off the list
        // either comes back as a thread or goes back on the list, a defect or an interruption too.
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const taken = yield* store.takeNewestClosed;
            if (taken === undefined) return null;
            const { closed: entry, workers } = taken;
            const putBack = store.getThread(entry.thread.id).pipe(
              Effect.option,
              Effect.flatMap((made) =>
                Option.isSome(made)
                  ? Effect.void
                  : store.rememberClosed(entry.thread, entry.closedAt, workers),
              ),
            );
            return yield* restore(reopenTaken(entry, workers)).pipe(Effect.onError(() => putBack));
          }),
        ),
    } satisfies Partial<Handlers>;
  });

export const closedThreadHandlers = makeClosedThreadHandlers();
