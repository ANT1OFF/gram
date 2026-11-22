// Forgetting a hosted worker machine's registration once nothing here needs it: what the release
// pass lets go, and the signed-in service's own check under the name's lock, with its last read
// and the removal in the thread store's write transaction. A fake app and server over the port,
// fake or in-memory threads; no network, no real machine.

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
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { generateHostKey } from "../host/machine-keys.ts";
import { memoryMachineStore } from "../host/paired-machines.ts";
import { RemoteHosts } from "../host/remote-hosts.ts";
import { emptyOutbox, OUTBOX_VERSION } from "../orchestration/outbox.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { SqlClient } from "../platform/unstable.ts";
import { type ForgetDeps, forgetReleased, type SnapshotStore } from "./hosted-machine-forget.ts";
import { fakeApp, NAME, ORIGIN, provisionRelayed } from "./signed-in-fixtures.ts";
import { forgetStoppedSignedIn } from "./signed-in-forget.ts";
import {
  bridgeWorkerMachines,
  SignedInWorkers,
  SignedInWorkersLive,
  WorkerMachinePort,
  type WorkerMachinePortShape,
} from "./signed-in-workers.ts";

const on = (hostId: string) => ({ path: "/w", hostId: HostId.make(hostId) }) as unknown as Checkout;
const threadOn = (id: string, hostId: string, fields: Partial<Thread> = {}) =>
  ({ id: id as ThreadId, parked: true, checkout: on(hostId), ...fields }) as unknown as Thread;

const WORKSPACE = "ws-1" as WorkspaceId;

/** The threads, wakes, outbox and sessions as the release pass reads them, all changeable. */
interface World {
  threads: ReadonlyArray<Thread>;
  unknown?: ReadonlyArray<ThreadId>;
  unknownParked?: ReadonlyArray<ThreadId>;
  plainWakes?: ReadonlyArray<ThreadId>;
  workerWakes?: ReadonlyArray<ThreadId>;
  working?: ReadonlyArray<ThreadId>;
  summaries?: ReadonlyArray<{ readonly id: ThreadId; readonly summary: Record<string, unknown> }>;
  outbox?: string;
}

const outboxWith = (wakes: ReadonlyArray<ThreadId>) =>
  JSON.stringify({
    version: OUTBOX_VERSION,
    ...emptyOutbox,
    wakes: wakes.map((threadId, index) => ({
      id: `wake-${index}`,
      threadId,
      at: 0,
      note: "",
      setAt: 0,
    })),
  });

const storeOf = (world: World): SnapshotStore => ({
  listWorkspaces: Effect.sync(() => [{ workspace: { id: WORKSPACE } }] as never),
  getOutbox: () =>
    Effect.sync(
      () =>
        world.outbox ??
        (world.workerWakes === undefined ? undefined : outboxWith(world.workerWakes)),
    ),
  listThreadsForClaims: Effect.sync(() => ({
    threads: world.threads,
    unknown: world.unknown ?? [],
    unknownParked: world.unknownParked ?? [],
  })),
  listThreadWakes: Effect.sync(() =>
    (world.plainWakes ?? []).map((threadId) => ({ threadId }) as never),
  ),
});

const runtimesOf = (world: World): ForgetDeps["runtimes"] => ({
  working: Effect.sync(() => [...(world.working ?? [])]),
  summaryOf: (id) =>
    Effect.sync(
      () =>
        ({
          status: "idle",
          queue: [],
          pendingRequests: [],
          ...world.summaries?.find((each) => each.id === id)?.summary,
        }) as never,
    ),
});

const depsOf = (world: World, fence: ForgetDeps["fence"] = (effect) => effect): ForgetDeps => ({
  store: storeOf(world),
  runtimes: runtimesOf(world),
  fence,
});

/** The pass over `ids` (all settled long since), noting each one `final` would remove. */
const passOver = (ids: ReadonlyArray<string>, world: World) =>
  Effect.gen(function* () {
    const forgot: string[] = [];
    yield* forgetReleased(
      ids.map((id) => ({ id, joinedAt: 0 })),
      depsOf(world),
      (id, final) => final(() => (forgot.push(id), true)),
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

/** A port answering stopped that notes each relay it ends. */
const notingPort = (unrelayed: string[]): WorkerMachinePortShape => ({
  ...stoppedApp(),
  unrelay: (name) => unrelayed.push(name),
});

const removeNow = (remove: () => boolean) => Effect.sync(remove);

describe("the release pass lets a hosted machine go", () => {
  it.effect(
    "only once every thread on it is archived, with nothing going on, waiting or watched",
    () =>
      Effect.gen(function* () {
        const forgot = yield* passOver(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"], {
          threads: [
            threadOn("idle", "1"),
            threadOn("turn", "2"),
            threadOn("plain-wake", "3"),
            threadOn("worker-wake", "4"),
            threadOn("not-archived", "5", { parked: false }),
            threadOn("run-watch", "6", { runWatches: [{}] as never }),
            threadOn("subagent", "7"),
            threadOn("queued", "8"),
            threadOn("request", "9"),
            threadOn("starting", "10"),
          ],
          working: ["turn" as ThreadId, "subagent" as ThreadId],
          summaries: [
            { id: "queued" as ThreadId, summary: { queue: [{}] } },
            { id: "request" as ThreadId, summary: { pendingRequests: [{}] } },
            { id: "starting" as ThreadId, summary: { status: "starting" } },
          ],
          plainWakes: ["plain-wake" as ThreadId],
          workerWakes: ["worker-wake" as ThreadId],
        });
        expect(forgot).toEqual(["1"]);
      }),
  );

  it.effect("none while a thread's row, archived or not, or an outbox can't be read", () =>
    Effect.gen(function* () {
      const threads = [threadOn("idle", "1")];
      for (const world of [
        { threads, unknown: ["x" as ThreadId] },
        { threads, unknownParked: ["x" as ThreadId] },
        { threads, outbox: "not an outbox" },
      ])
        expect(yield* passOver(["1"], world)).toEqual([]);
      expect(yield* passOver(["1"], { threads })).toEqual(["1"]);
    }),
  );

  it.effect("none, and nothing removed, when a read before or inside the fence dies", () =>
    Effect.gen(function* () {
      for (const dieOn of [1, 2]) {
        const hosts = yield* RemoteHosts.make(memoryMachineStore());
        const { id } = provisionRelayed(hosts, NAME);
        const unrelayed: string[] = [];
        const world: World = { threads: [threadOn("idle", id)] };
        let reads = 0;
        const store: SnapshotStore = {
          ...storeOf(world),
          listThreadsForClaims: Effect.suspend(() =>
            (reads += 1) === dieOn
              ? Effect.die(new Error("SQLITE_IOERR"))
              : storeOf(world).listThreadsForClaims,
          ),
        };
        const exit = yield* Effect.exit(
          forgetReleased(
            [{ id, joinedAt: 0 }],
            { store, runtimes: runtimesOf(world), fence: (effect) => effect },
            (each, final) => forgetStoppedSignedIn(notingPort(unrelayed), hosts, {}, each, final),
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(reads).toBe(dieOn);
        expect(hosts.list().map((each) => each.id)).toEqual([id]);
        expect(hosts.machines.get(id)).toBeDefined();
        expect(unrelayed).toEqual([]);
      }
    }),
  );
});

const withStore = <A, E, R>(
  body: (store: ThreadStore["Service"], sql: SqlClient.SqlClient) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const sql = yield* SqlClient.SqlClient;
    return yield* body(store, sql);
  }).pipe(Effect.provide(ThreadStore.layerSqlite(":memory:")));

/** An archived worker of the store's on `hostId`. */
const archivedOn = (store: ThreadStore["Service"], hostId: string) =>
  Effect.gen(function* () {
    const project = yield* store.ensureProject({ root: "/work/fenced", name: "fenced" });
    const thread = {
      id: "thread-fenced" as ThreadId,
      projectId: project.id,
      title: "a worker",
      userNamed: false,
      model: { agent: "claude", model: "fake-opus" },
      mode: "default",
      checkout: { kind: "main", path: "/work/fenced", hostId: HostId.make(hostId) },
      labels: [],
      pinned: false,
      parked: true,
      unread: false,
      createdAt: 1,
      lastActivityAt: 2,
    } as unknown as Thread;
    yield* store.insertThread(thread);
    return thread.id;
  });

const setUp = (store: ThreadStore["Service"]) =>
  Effect.gen(function* () {
    const hosts = yield* RemoteHosts.make(memoryMachineStore());
    const { id } = provisionRelayed(hosts, NAME);
    const threadId = yield* archivedOn(store, id);
    const order: string[] = [];
    const unrelayed: string[] = [];
    const noting = {
      list: hosts.list,
      stops: hosts.stops,
      remove: (each: HostId) => (order.push("removed"), hosts.remove(each)),
    };
    const unarchive = store
      .updateThread(threadId, (thread) => ({ ...thread, parked: false }))
      .pipe(
        Effect.tap(() => Effect.sync(() => order.push("unarchived"))),
        Effect.orDie,
      );
    return { hosts, id, threadId, order, unrelayed, noting, unarchive };
  });

describe("an unarchive and the removal, in the thread store's own fence", () => {
  it.live("an unarchive tried while the fence is held lands only after the one removal", () =>
    withStore((store, sql) =>
      Effect.gen(function* () {
        const { hosts, id, threadId, order, unrelayed, noting, unarchive } = yield* setUp(store);
        const entered = yield* Deferred.make<void>();
        const fence: ForgetDeps["fence"] = (effect) =>
          Effect.orDie(
            sql.withTransaction(
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined);
                yield* Effect.sleep("50 millis");
                return yield* effect;
              }),
            ),
          );
        const pass = yield* Effect.forkScoped(
          forgetReleased(
            [{ id, joinedAt: 0 }],
            { store, runtimes: runtimesOf({ threads: [] }), fence },
            (each, final) => forgetStoppedSignedIn(notingPort(unrelayed), noting, {}, each, final),
          ),
        );
        yield* Deferred.await(entered);
        const pending = yield* Effect.forkScoped(unarchive);
        yield* Fiber.join(pass);
        yield* Fiber.join(pending);
        // The unarchive waited for the fence: it never lands between the last read and the removal.
        expect(order).toEqual(["removed", "unarchived"]);
        expect(hosts.list()).toEqual([]);
        expect(unrelayed).toEqual([NAME]);
        expect((yield* store.getThread(threadId)).parked).toBe(false);
      }).pipe(Effect.scoped),
    ),
  );

  it.live("an unarchive that lands before the fence keeps the machine, never removed", () =>
    withStore((store, sql) =>
      Effect.gen(function* () {
        const { hosts, id, order, unrelayed, noting, unarchive } = yield* setUp(store);
        const fence: ForgetDeps["fence"] = (effect) =>
          unarchive.pipe(Effect.andThen(Effect.orDie(sql.withTransaction(effect))));
        yield* forgetReleased(
          [{ id, joinedAt: 0 }],
          { store, runtimes: runtimesOf({ threads: [] }), fence },
          (each, final) => forgetStoppedSignedIn(notingPort(unrelayed), noting, {}, each, final),
        );
        expect(order).toEqual(["unarchived"]);
        expect(hosts.list().map((each) => each.id)).toEqual([id]);
        expect(unrelayed).toEqual([]);
      }),
    ),
  );
});

describe("a signed-in hosted machine's registration is forgotten", () => {
  it.live("once its server says it is stopped, and nothing is asked of it but its status", () =>
    Effect.gen(function* () {
      const { hosts, id, app, forget } = yield* live((call) =>
        call === "status" ? { status: 200, body: { phase: "stopped" } } : { status: 200, body: {} },
      );
      expect(yield* forget(id, removeNow)).toBe(true);
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
        expect(yield* forget(id, removeNow)).toBe(false);
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
            forgetStoppedSignedIn(port, hosts, { sent }, id, removeNow),
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
      const unrelayed: string[] = [];
      const held = yield* heldPort(stoppedApp());
      const port = { ...held.port, unrelay: (name: string) => unrelayed.push(name) };
      const world: World = { threads: [threadOn("worker", id)] };
      const pass = yield* Effect.forkScoped(
        forgetReleased([{ id, joinedAt: 0 }], depsOf(world), (each, final) =>
          forgetStoppedSignedIn(port, hosts, {}, each, final),
        ),
      );
      yield* Deferred.await(held.asked);
      // `thread.park(false)`: the row changes, and no wake or want is queued.
      world.threads = [threadOn("worker", id, { parked: false })];
      yield* Deferred.succeed(held.answer, undefined);
      yield* Fiber.join(pass);
      expect(hosts.list().map((each) => each.id)).toEqual([id]);
      expect(unrelayed).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("never for one with a start on its way, or one kept from before sign-ins were", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      const app = fakeApp({ answer: () => ({ status: 200, body: { phase: "stopped" } }) });
      const port = bridgeWorkerMachines(app.port);
      const { id } = provisionRelayed(hosts, NAME);
      expect(
        yield* forgetStoppedSignedIn(port, hosts, { starting: new Set([NAME]) }, id, removeNow),
      ).toBe(false);
      const legacy = hosts.machines.provision({
        name: "worker-abcdef0123",
        publicKey: generateHostKey().publicKey,
        platform: "linux",
        onDemand: "worker",
        via: ORIGIN,
      });
      if (legacy.kind !== "provisioned") throw new Error(legacy.message);
      expect(yield* forgetStoppedSignedIn(port, hosts, {}, legacy.machine.id, removeNow)).toBe(
        false,
      );
      expect(app.calls).toEqual([]);
      expect(hosts.list()).toHaveLength(2);
    }),
  );
});
