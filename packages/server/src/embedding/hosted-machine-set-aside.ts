import type { ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { readOutbox as readStoredOutbox } from "../orchestration/outbox.ts";
import type { ThreadStore } from "../persistence/thread-store.ts";
import type { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { placedOn, threadsLetGo, type UseThread } from "./hosted-machine-use.ts";
import type { FinalCheck } from "./signed-in-set-aside.ts";

/** What `threadsSnapshot` reads: the thread store alone. */
export type SnapshotStore = Pick<
  ThreadStore["Service"],
  | "listWorkspaces"
  | "getOutbox"
  | "listThreadsForClaims"
  | "listThreadWakes"
  | "listQueue"
  | "listRequests"
>;

/**
 * Every thread, and those that keep their machine for what is stored of them (`keeping`): a wake
 * pending (a worker's, in its workspace's outbox, or a plain one's), a queued message or a request
 * waiting.
 */
export interface ThreadsSnapshot {
  readonly threads: ReadonlyArray<UseThread>;
  readonly keeping: ReadonlySet<ThreadId>;
}

/**
 * Reads every thread, archived ones included, every wake pending, and the queued messages and
 * waiting requests of each thread `onThem` holds placed on a machine looked at, from the thread
 * store alone. Undefined, so nothing is set aside, when any of it can't be read: a thread's row,
 * archived or not, or a workspace's outbox, or one standing in for an unreadable one.
 */
export const threadsSnapshot = (
  store: SnapshotStore,
  onThem: (thread: UseThread) => boolean,
): Effect.Effect<ThreadsSnapshot | undefined> =>
  Effect.gen(function* () {
    const keeping = new Set<ThreadId>();
    for (const workspace of yield* store.listWorkspaces) {
      const outbox = readStoredOutbox(yield* store.getOutbox(workspace.workspace.id));
      if (outbox._tag === "unreadable") return undefined;
      if (outbox._tag === "read" && outbox.setAside !== undefined) return undefined;
      for (const wake of outbox.state.wakes ?? []) keeping.add(wake.threadId);
    }
    const claims = yield* store.listThreadsForClaims;
    if (claims.unknown.length > 0 || claims.unknownParked.length > 0) return undefined;
    for (const wake of yield* store.listThreadWakes) keeping.add(wake.threadId);
    for (const thread of claims.threads) {
      if (keeping.has(thread.id) || !onThem(thread)) continue;
      const queued = yield* store.listQueue(thread.id);
      const requests = yield* store.listRequests(thread.id);
      if (queued.length > 0 || requests.length > 0) keeping.add(thread.id);
    }
    return { threads: claims.threads, keeping };
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

/** What `setAsideReleased` reads. */
export interface SetAsideDeps {
  readonly store: SnapshotStore;
  readonly runtimes: Pick<ThreadRuntimes["Service"], "working" | "summaryOf">;
  readonly now?: () => number;
}

type Looked = { readonly id: string; readonly joinedAt?: number | undefined };

/**
 * Sets aside each of `candidates` (hosted worker machines whose release was told, offline) that
 * the threads let go (`threadsLetGo`), once its server says it is stopped (`setAside`, the
 * signed-in `setAside.stopped`), with what is stored of the threads read again after that answer
 * (`FinalCheck`). And takes back (`takeBack`) each machine set aside (`asideNow`) that the threads
 * no longer let go: a thread unarchived, a wake, a watch or a message since, or nothing readable.
 * Sessions are asked once, before any status call, and never under a machine's name's lock.
 * Nothing is removed: a machine set aside as something took it up is taken back by that want,
 * dial or start, or by this pass.
 */
export const setAsideReleased = (
  candidates: ReadonlyArray<Looked>,
  asideNow: ReadonlyArray<Looked>,
  deps: SetAsideDeps,
  setAside: (id: string, final: FinalCheck) => Effect.Effect<boolean>,
  takeBack: (id: string) => void,
) =>
  Effect.gen(function* () {
    if (candidates.length === 0 && asideNow.length === 0) return;
    const now = deps.now ?? Date.now;
    const machines = [...candidates, ...asideNow];
    const onThem = (thread: UseThread) => machines.some((machine) => placedOn(thread, machine.id));
    const first = yield* threadsSnapshot(deps.store, onThem);
    const busy =
      first === undefined
        ? new Set<ThreadId>()
        : yield* busyThreads(deps.runtimes, first.threads.filter(onThem));
    const letGo = (machine: Looked, snapshot: ThreadsSnapshot | undefined) =>
      snapshot !== undefined &&
      threadsLetGo(machine, snapshot.threads, snapshot.keeping, (id) => busy.has(id), now());
    for (const machine of asideNow) if (!letGo(machine, first)) takeBack(machine.id);
    if (first === undefined) return;
    for (const machine of candidates) {
      if (!letGo(machine, first)) continue;
      yield* setAside(machine.id, (setAsideNow) =>
        Effect.map(
          threadsSnapshot(deps.store, (thread) => placedOn(thread, machine.id)),
          (fresh) => letGo(machine, fresh) && setAsideNow(),
        ),
      );
    }
  });
