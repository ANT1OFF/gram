import { describe, expect, it } from "@effect/vitest";
import type { HostId, Thread, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { makeQueueMethods, type QueueMethodsDeps } from "./message-queue.ts";
import * as Semaphore from "effect/Semaphore";

const GONE = "m-gone" as HostId;
const HERE = "m-here" as HostId;

/** A stored thread placed on `hostId`, as far as the boot's send reads one. */
const placed = (id: string, hostId: HostId | undefined) =>
  ({
    id: id as ThreadId,
    parked: false,
    checkout: hostId === undefined ? { path: `/w/${id}` } : { path: `/w/${id}`, hostId },
  }) as unknown as Thread;

/** The boot's send over stub deps, and which threads it drained. */
const bootWith = (threads: ReadonlyArray<Thread>, paired?: (id: HostId) => boolean) =>
  Effect.gen(function* () {
    const drained: Array<ThreadId> = [];
    const lock = yield* Semaphore.make(1);
    const deps = {
      store: {
        listThreads: Effect.succeed(threads),
        listQueue: () => Effect.succeed([{ id: "q1" }]),
      },
      runtimes: new Map(),
      getRuntime: (threadId: ThreadId) => Effect.succeed({ threadId, lock }),
      drainQueue: (rt: { readonly threadId: ThreadId }) =>
        Effect.sync(() => {
          drained.push(rt.threadId);
        }),
      scheduleAccount: () => Effect.void,
      interrupt: () => Effect.void,
      ...(paired === undefined ? {} : { paired }),
    } as unknown as QueueMethodsDeps;
    yield* makeQueueMethods(deps).sendQueuedAtBoot;
    return drained;
  });

describe("the boot's send of what was left queued", () => {
  it.effect("leaves the queue of a thread whose machine is no longer paired", () =>
    Effect.gen(function* () {
      const drained = yield* bootWith(
        [placed("on-gone", GONE), placed("on-here", HERE), placed("local", undefined)],
        (id) => id !== GONE,
      );
      expect(drained).toEqual(["on-here", "local"]);
    }),
  );

  it.effect("still sends the queue of a thread waiting for its machine to be named", () =>
    Effect.gen(function* () {
      const waiting = { ...placed("waiting", "awaited" as HostId), awaitingMachine: { since: 0 } };
      const drained = yield* bootWith([waiting as unknown as Thread], () => false);
      expect(drained).toEqual(["waiting"]);
    }),
  );

  it.effect("sends every queue when nothing says which machines are paired", () =>
    Effect.gen(function* () {
      const drained = yield* bootWith([placed("on-gone", GONE), placed("local", undefined)]);
      expect(drained).toEqual(["on-gone", "local"]);
    }),
  );
});
