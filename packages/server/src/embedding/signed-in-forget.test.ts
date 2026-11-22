// Forgetting a hosted worker machine's registration once nothing here needs it: what the release
// pass lets go, and the signed-in service's own check under the name's lock. A fake app and server
// over the port, and fake threads; no network, no real machine.

import { describe, expect, it } from "@effect/vitest";
import {
  type Checkout,
  HostId,
  type Thread,
  type ThreadId,
  type WorkspaceId,
} from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { generateHostKey } from "../host/machine-keys.ts";
import { memoryMachineStore } from "../host/paired-machines.ts";
import { RemoteHosts } from "../host/remote-hosts.ts";
import { fakeApp, NAME, ORIGIN, provisionRelayed } from "./signed-in-fixtures.ts";
import { forgetStoppedSignedIn } from "./signed-in-forget.ts";
import {
  bridgeWorkerMachines,
  SignedInWorkers,
  SignedInWorkersLive,
  WorkerMachinePort,
  type WorkerMachinePortShape,
} from "./signed-in-workers.ts";
import {
  forgetReleased,
  type ReleaseMachine,
  type ThreadsNowDeps,
} from "./worker-machine-release.ts";

const on = (hostId: string) => ({ path: "/w", hostId: HostId.make(hostId) }) as unknown as Checkout;
const threadOn = (id: string, hostId: string, fields: Partial<Thread> = {}) =>
  ({ id: id as ThreadId, parked: true, checkout: on(hostId), ...fields }) as unknown as Thread;

const machine = (id: string, fields: Partial<ReleaseMachine> = {}): ReleaseMachine => ({
  id,
  name: `worker-${id.padStart(10, "0")}`,
  onDemand: "worker",
  via: ORIGIN,
  viaAccount: "a",
  joinedAt: 0,
  ...fields,
});

const WORKSPACE = "ws-1" as WorkspaceId;

/** The threads, wakes, ledger, outbox and sessions as `threadsNow` reads them, all changeable. */
interface World {
  threads: ReadonlyArray<Thread>;
  unknown?: ReadonlyArray<ThreadId>;
  unknownParked?: ReadonlyArray<ThreadId>;
  plainWakes?: ReadonlyArray<ThreadId>;
  workerWakes?: ReadonlyArray<ThreadId>;
  busy?: ReadonlyArray<{ readonly id: ThreadId; readonly summary: Record<string, unknown> }>;
  outbox?: string;
  ledgerUnread?: boolean;
}

const depsOf = (world: World): ThreadsNowDeps => ({
  store: {
    listWorkspaces: Effect.sync(() => [{ workspace: { id: WORKSPACE } }] as never),
    getOutbox: () => Effect.sync(() => world.outbox),
    listThreadsForClaims: Effect.sync(() => ({
      threads: world.threads,
      unknown: world.unknown ?? [],
      unknownParked: world.unknownParked ?? [],
    })),
    listThreadWakes: Effect.sync(() =>
      (world.plainWakes ?? []).map((threadId) => ({ threadId }) as never),
    ),
  },
  ledger: () =>
    Effect.sync(() =>
      world.ledgerUnread === true
        ? Option.none()
        : Option.some({
            features: [
              {
                workers: (world.workerWakes ?? []).map((threadId) => ({
                  threadId,
                  wakes: [{}],
                })),
              },
            ] as never,
          }),
    ),
  runtimes: {
    summaryOf: (id) =>
      Effect.sync(
        () =>
          ({
            status: "idle",
            queue: [],
            pendingRequests: [],
            ...world.busy?.find((each) => each.id === id)?.summary,
          }) as never,
      ),
  },
});

const passOver = (machines: ReadonlyArray<ReleaseMachine>, world: World, notReleased = [""]) =>
  Effect.gen(function* () {
    const forgot: string[] = [];
    const told = new Map(
      machines.map((each) => [each.id, { released: !notReleased.includes(each.id) }]),
    );
    yield* forgetReleased(machines, told, depsOf(world), (id, letGo) =>
      Effect.flatMap(letGo, (go) => Effect.sync(() => (go && forgot.push(id), go))),
    );
    return forgot;
  });

const live = (answer: (call: string) => { status: number; body: unknown }) =>
  Effect.gen(function* () {
    const hosts = yield* RemoteHosts.make(memoryMachineStore());
    const { id } = provisionRelayed(hosts, NAME);
    const app = fakeApp({ answer: ({ call }) => answer(call) });
    const context = yield* Layer.build(
      SignedInWorkersLive.pipe(
        Layer.provide(Layer.succeed(WorkerMachinePort)(bridgeWorkerMachines(app.port))),
        Layer.provide(Layer.succeed(RemoteHosts)(hosts)),
      ),
    );
    const signedIn = yield* SignedInWorkers.pipe(Effect.provide(context));
    return { hosts, id, app, forget: signedIn.forgetStopped! };
  });

/** A port whose calls wait, once asked, until `answer` is given. */
const heldPort = (base: WorkerMachinePortShape) =>
  Effect.gen(function* () {
    const asked = yield* Deferred.make<void>();
    const answer = yield* Deferred.make<void>();
    const port: WorkerMachinePortShape = {
      ...base,
      call: (origin, call, body, options) =>
        Deferred.succeed(asked, undefined).pipe(
          Effect.andThen(Deferred.await(answer)),
          Effect.andThen(base.call(origin, call, body, options)),
        ),
    };
    return { port, asked, answer };
  });

const stoppedApp = () =>
  bridgeWorkerMachines(
    fakeApp({ answer: () => ({ status: 200, body: { phase: "stopped" } }) }).port,
  );

describe("the release pass lets a hosted machine go", () => {
  it.effect(
    "only once every thread on it is archived, with nothing going on, waiting or watched",
    () =>
      Effect.gen(function* () {
        const ids = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
        const forgot = yield* passOver(
          [...ids.map((id) => machine(id)), machine("11", { onlineSince: 1 })],
          {
            threads: [
              threadOn("idle", "1"),
              threadOn("running", "2"),
              threadOn("plain-wake", "3"),
              threadOn("worker-wake", "4"),
              threadOn("not-archived", "5", { parked: false }),
              threadOn("idle-not-told", "6"),
              threadOn("run-watch", "7", { runWatches: [{}] as never }),
              threadOn("background", "8"),
              threadOn("subagent", "9"),
              threadOn("queued", "10"),
              threadOn("idle-online", "11"),
            ],
            busy: [
              { id: "running" as ThreadId, summary: { status: "running" } },
              { id: "background" as ThreadId, summary: { background: [{}] } },
              { id: "subagent" as ThreadId, summary: { activity: {} } },
              { id: "queued" as ThreadId, summary: { queue: [{}] } },
            ],
            plainWakes: ["plain-wake" as ThreadId],
            workerWakes: ["worker-wake" as ThreadId],
          },
          ["6"],
        );
        expect(forgot).toEqual(["1"]);
      }),
  );

  it.effect("none while a thread's row, archived or not, a ledger or an outbox can't be read", () =>
    Effect.gen(function* () {
      const threads = [threadOn("idle", "1")];
      for (const world of [
        { threads, unknown: ["x" as ThreadId] },
        { threads, unknownParked: ["x" as ThreadId] },
        { threads, ledgerUnread: true },
        { threads, outbox: "not an outbox" },
      ])
        expect(yield* passOver([machine("1")], world)).toEqual([]);
      expect(yield* passOver([machine("1")], { threads })).toEqual(["1"]);
    }),
  );
});

describe("a signed-in hosted machine's registration is forgotten", () => {
  it.live("once its server says it is stopped, and nothing is asked of it but its status", () =>
    Effect.gen(function* () {
      const { hosts, id, app, forget } = yield* live((call) =>
        call === "status" ? { status: 200, body: { phase: "stopped" } } : { status: 200, body: {} },
      );
      expect(yield* forget(id, Effect.succeed(true))).toBe(true);
      expect(hosts.list()).toEqual([]);
      expect(app.calls.filter((each) => each.call !== "status")).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live("not on an answer that doesn't say it is stopped", () =>
    Effect.gen(function* () {
      for (const answer of [
        { status: 200, body: {} },
        { status: 200, body: "not json" },
        { status: 200, body: { phase: "running" } },
        { status: 503, body: { phase: "stopped" } },
        { status: 404, body: { code: "not_found" } },
      ]) {
        const { hosts, id, forget } = yield* live(() => answer);
        expect(yield* forget(id, Effect.succeed(true))).toBe(false);
        expect(hosts.list().map((each) => each.id)).toEqual([id]);
      }
    }).pipe(Effect.scoped),
  );

  it.live(
    "not when something wants it started, or a start of it goes out, while its status is asked",
    () =>
      Effect.gen(function* () {
        for (const meanwhile of ["wanted", "started"] as const) {
          const hosts = yield* RemoteHosts.make(memoryMachineStore());
          const { id } = provisionRelayed(hosts, NAME);
          const { port, asked, answer } = yield* heldPort(stoppedApp());
          const sent = new Map<string, number>();
          const pass = yield* Effect.forkScoped(
            forgetStoppedSignedIn(port, hosts, { sent }, id, Effect.succeed(true)),
          );
          yield* Deferred.await(asked);
          if (meanwhile === "wanted")
            yield* Effect.forkScoped(hosts.stops.wanting(HostId.make(id), Effect.never));
          else sent.set(NAME, 2);
          yield* Effect.yieldNow;
          yield* Deferred.succeed(answer, undefined);
          expect(yield* Fiber.join(pass)).toBe(false);
          expect(hosts.list().map((each) => each.id)).toEqual([id]);
        }
      }).pipe(Effect.scoped),
  );

  it.live("not when its worker is unarchived while its status is asked, through both stages", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      const { id } = provisionRelayed(hosts, NAME);
      const registered = hosts.list().find((each) => each.id === id)!;
      const unrelayed: string[] = [];
      const held = yield* heldPort(stoppedApp());
      const { asked, answer } = held;
      const port = { ...held.port, unrelay: (name: string) => unrelayed.push(name) };
      const world: World = { threads: [threadOn("worker", id)] };
      const pass = yield* Effect.forkScoped(
        forgetReleased(
          [{ ...registered, joinedAt: 0 }],
          new Map([[id, { released: true }]]),
          depsOf(world),
          (each, letGo) => forgetStoppedSignedIn(port, hosts, {}, each, letGo),
        ),
      );
      yield* Deferred.await(asked);
      // `thread.park(false)`: the row changes, and no wake or want is queued.
      world.threads = [threadOn("worker", id, { parked: false })];
      yield* Deferred.succeed(answer, undefined);
      yield* Fiber.join(pass);
      expect(hosts.list().map((each) => each.id)).toEqual([id]);
      // Kept, not forgotten and registered again: its relay was never ended.
      expect(unrelayed).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live("registers it again, as it was, when a thread takes it up as it is forgotten", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      const { id } = provisionRelayed(hosts, NAME);
      const before = hosts.machines.get(id)!;
      let reads = 0;
      // Let go when read under the lock; taken up by the read just after it was forgotten.
      const letGo = Effect.sync(() => (reads += 1) === 1);
      expect(yield* forgetStoppedSignedIn(stoppedApp(), hosts, {}, id, letGo)).toBe(false);
      expect(reads).toBe(2);
      const after = hosts.machines.get(id)!;
      expect({ ...after, joinedAt: 0, confirmedAt: 0 }).toEqual({
        ...before,
        joinedAt: 0,
        confirmedAt: 0,
      });
    }),
  );

  it.effect("never for one with a start on its way, or one kept from before sign-ins were", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      const app = fakeApp({ answer: () => ({ status: 200, body: { phase: "stopped" } }) });
      const port = bridgeWorkerMachines(app.port);
      const go = Effect.succeed(true);
      const { id } = provisionRelayed(hosts, NAME);
      expect(yield* forgetStoppedSignedIn(port, hosts, { starting: new Set([NAME]) }, id, go)).toBe(
        false,
      );
      const legacy = hosts.machines.provision({
        name: "worker-abcdef0123",
        publicKey: generateHostKey().publicKey,
        platform: "linux",
        onDemand: "worker",
        via: ORIGIN,
      });
      if (legacy.kind !== "provisioned") throw new Error(legacy.message);
      expect(yield* forgetStoppedSignedIn(port, hosts, {}, legacy.machine.id, go)).toBe(false);
      expect(app.calls).toEqual([]);
      expect(hosts.list()).toHaveLength(2);
    }),
  );
});
