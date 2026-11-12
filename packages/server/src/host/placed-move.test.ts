// A session waiting for its thread's machine to be started, when the thread is moved meanwhile
// onto another machine (`thread-profiles/start.ts`, `moveOne`): it opens there instead of waiting
// out the old machine's wake.
import { describe, expect, it } from "@effect/vitest";
import type { AgentHost } from "@gram/agents";
import {
  type Checkout,
  HostId,
  HostUnavailable,
  LOCAL_HOST_ID,
  type Thread,
  ThreadId,
  ThreadNotFound,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import { TestClock } from "effect/testing";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { placedHost } from "./placed.ts";
import type { WorkerHost } from "./worker-host.ts";

const GONE = HostId.make("m-000000000000000000000001");
const NEXT = HostId.make("m-000000000000000000000002");
const ID = ThreadId.make("t-moved");
const PATH = "/sandbox/repos/.threads/t-moved";

const opening = (id: HostId, opened: Array<string>, onOpen?: () => void): WorkerHost =>
  ({
    id,
    sessions: AgentHosts.of({
      get: () =>
        Effect.succeed({
          kind: "claude",
          open: (options: { readonly threadId: string; readonly cwd?: string }) =>
            Effect.sync(() => {
              opened.push(`${id}:${options.threadId}:${options.cwd}`);
              onOpen?.();
              return {} as never;
            }),
        } as unknown as AgentHost),
    }),
  }) as unknown as WorkerHost;

const setup = (
  options: {
    /** Holds the old machine's wake until it is released. */
    readonly hold?: Deferred.Deferred<void>;
    /** Runs as a session opens on a machine. */
    readonly onOpen?: () => void;
  } = {},
) => {
  const opened: Array<string> = [];
  let checkout: Checkout = { kind: "main", path: PATH, hostId: GONE };
  const online = new Set<HostId>();
  const local = opening(LOCAL_HOST_ID, opened);
  const get = (id: HostId) =>
    Effect.suspend(() =>
      online.has(id)
        ? Effect.succeed(opening(id, opened, options.onOpen))
        : Effect.fail(new HostUnavailable({ hostId: id, message: "That machine is offline." })),
    );
  const placed = placedHost(
    {
      local,
      get,
      // As `awaitedMachines` waits for a stopped machine to be started.
      forSession: (id) =>
        (id === GONE && options.hold !== undefined
          ? Deferred.await(options.hold)
          : Effect.void
        ).pipe(Effect.andThen(get(id).pipe(Effect.retry(Schedule.spaced("500 millis"))))),
    },
    {
      listThreads: Effect.sync(() => [{ id: ID, checkout } as unknown as Thread]),
      getThread: (threadId) =>
        threadId === ID
          ? Effect.sync(() => ({ id: ID, checkout }) as unknown as Thread)
          : Effect.fail(new ThreadNotFound({ threadId })),
    },
  );
  return {
    placed,
    opened,
    online,
    move: (to: HostId) => {
      checkout = { ...checkout, hostId: to };
    },
  };
};

describe("a session waiting for a machine its thread was moved off", () => {
  it.effect("opens on the machine the thread was moved to", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { placed, opened, online, move } = setup();
        const agent = yield* placed.sessions.get("claude");
        const waiting = yield* Effect.forkScoped(
          Effect.scoped(agent.open({ threadId: ID, cwd: PATH } as never)),
        );
        yield* TestClock.adjust("5 seconds");
        expect(opened).toEqual([]);
        // The platform starts another machine and moves the thread onto it.
        online.add(NEXT);
        move(NEXT);
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(waiting);
        expect(opened).toEqual([`${NEXT}:${ID}:${PATH}`]);
      }),
    ),
  );

  it.effect("still opens on its own machine when that one comes back", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { placed, opened, online } = setup();
        const agent = yield* placed.sessions.get("claude");
        const waiting = yield* Effect.forkScoped(
          Effect.scoped(agent.open({ threadId: ID, cwd: PATH } as never)),
        );
        yield* TestClock.adjust("5 seconds");
        online.add(GONE);
        yield* TestClock.adjust("2 seconds");
        yield* Fiber.join(waiting);
        expect(opened).toEqual([`${GONE}:${ID}:${PATH}`]);
      }),
    ),
  );

  it.effect(
    "opens on the new machine when the old one's wake comes in after the move (REVIEW-477 3)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const hold = yield* Deferred.make<void>();
          const { placed, opened, online, move } = setup({ hold });
          const agent = yield* placed.sessions.get("claude");
          const waiting = yield* Effect.forkScoped(
            Effect.scoped(agent.open({ threadId: ID, cwd: PATH } as never)),
          );
          yield* TestClock.adjust("100 millis");
          // The move commits, then the old machine dials in before the next look for a move.
          online.add(NEXT);
          move(NEXT);
          online.add(GONE);
          yield* Deferred.succeed(hold, undefined);
          yield* TestClock.adjust("1 second");
          yield* Fiber.join(waiting);
          expect(opened).toEqual([`${NEXT}:${ID}:${PATH}`]);
        }),
      ),
  );

  it.effect("keeps no session opened on a machine the thread left while it opened", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let moveNow: (() => void) | undefined;
        const { placed, online, move } = setup({ onOpen: () => moveNow?.() });
        moveNow = () => move(NEXT);
        online.add(GONE);
        const agent = yield* placed.sessions.get("claude");
        const refused = yield* Effect.scoped(agent.open({ threadId: ID, cwd: PATH } as never)).pipe(
          Effect.flip,
        );
        expect(refused).toMatchObject({
          _tag: "AgentUnavailable",
          message: "The thread moved to another machine while its session opened.",
        });
      }),
    ),
  );
});
