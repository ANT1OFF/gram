import type { ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { readOutbox as readStoredOutbox } from "../orchestration/outbox.ts";
import type { ThreadStore } from "../persistence/thread-store.ts";
import type { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { placedOn, threadsLetGo, type UseThread } from "./hosted-machine-use.ts";
import type { FinalCheck } from "./signed-in-forget.ts";

/** What `threadsSnapshot` reads: from the thread store alone, so it can run inside its fence. */
export type SnapshotStore = Pick<
  ThreadStore["Service"],
  "listWorkspaces" | "getOutbox" | "listThreadsForClaims" | "listThreadWakes"
>;

/** Every thread, and those with a wake pending: a worker's (its workspace's outbox) or a plain one's. */
export interface ThreadsSnapshot {
  readonly threads: ReadonlyArray<UseThread>;
  readonly waking: ReadonlySet<ThreadId>;
}

/**
 * Reads every thread, archived ones included, and every wake pending, from the thread store
 * alone. Undefined, so nothing is let go, when any of it can't be read: a thread's row, archived
 * or not, or a workspace's outbox.
 */
export const threadsSnapshot = (store: SnapshotStore): Effect.Effect<ThreadsSnapshot | undefined> =>
  Effect.gen(function* () {
    const waking = new Set<ThreadId>();
    for (const workspace of yield* store.listWorkspaces) {
      const outbox = readStoredOutbox(yield* store.getOutbox(workspace.workspace.id));
      if (outbox._tag === "unreadable") return undefined;
      for (const wake of outbox.state.wakes ?? []) waking.add(wake.threadId);
    }
    const claims = yield* store.listThreadsForClaims;
    if (claims.unknown.length > 0 || claims.unknownParked.length > 0) return undefined;
    for (const wake of yield* store.listThreadWakes) waking.add(wake.threadId);
    return { threads: claims.threads, waking };
  });

/**
 * Of `threads`, those with anything going on in their session: a turn, a start, background work
 * or a subagent running (`working`), a queued message or a request waiting.
 */
export const busyThreads = (
  runtimes: Pick<ThreadRuntimes["Service"], "working" | "summaryOf">,
  threads: ReadonlyArray<UseThread>,
): Effect.Effect<ReadonlySet<ThreadId>> =>
  Effect.gen(function* () {
    const busy = new Set<ThreadId>(yield* runtimes.working);
    for (const thread of threads) {
      if (busy.has(thread.id)) continue;
      const summary = yield* runtimes.summaryOf(thread.id);
      if (
        summary !== undefined &&
        (summary.status === "running" ||
          summary.status === "starting" ||
          summary.queue.length > 0 ||
          summary.pendingRequests.length > 0)
      )
        busy.add(thread.id);
    }
    return busy;
  });

/** What `forgetReleased` reads, and the fence its last read and the removal run in. */
export interface ForgetDeps {
  readonly store: SnapshotStore;
  readonly runtimes: Pick<ThreadRuntimes["Service"], "working" | "summaryOf">;
  /**
   * Runs its effect where no write to the thread store lands until it is done: one write
   * transaction on the store's own client, which every write waits for, an unarchive included.
   * Nothing that takes another lock may run in it.
   */
  readonly fence: <A>(effect: Effect.Effect<A>) => Effect.Effect<A>;
  readonly now?: () => number;
}

/**
 * Forgets each of `candidates` (hosted worker machines whose release was told, offline) that the
 * threads let go (`threadsLetGo`), once its server says it is stopped (`forget`, the signed-in
 * `forgetStopped`). The sessions are asked first, outside the fence; the threads and wakes are
 * read again inside it, after that answer, with the removal in the same fence: an unarchive, a
 * wake or a watch either lands before that read, which keeps the machine, or after its removal.
 */
export const forgetReleased = (
  candidates: ReadonlyArray<{ readonly id: string; readonly joinedAt?: number | undefined }>,
  deps: ForgetDeps,
  forget: (id: string, final: FinalCheck) => Effect.Effect<boolean>,
) =>
  Effect.gen(function* () {
    if (candidates.length === 0) return;
    const now = deps.now ?? Date.now;
    const first = yield* threadsSnapshot(deps.store);
    if (first === undefined) return;
    const busy = yield* busyThreads(
      deps.runtimes,
      first.threads.filter((thread) => candidates.some((machine) => placedOn(thread, machine.id))),
    );
    const letGo = (machine: (typeof candidates)[number], snapshot: ThreadsSnapshot) =>
      threadsLetGo(machine, snapshot.threads, snapshot.waking, (id) => busy.has(id), now());
    for (const machine of candidates) {
      if (!letGo(machine, first)) continue;
      yield* forget(machine.id, (remove) =>
        deps.fence(
          Effect.map(
            threadsSnapshot(deps.store),
            (fresh) => fresh !== undefined && letGo(machine, fresh) && remove(),
          ),
        ),
      );
    }
  });
