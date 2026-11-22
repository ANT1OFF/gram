// Setting a hosted worker machine aside once nothing here needs it, and taking it back: what the
// release pass sets aside, the signed-in service's own check under the name's lock, and that a
// machine set aside is kept whole, neither relayed nor counted, and taken back by whatever needs
// it. A fake app and server over the port, fake threads; no network, no real machine.

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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileMachineStore, memoryMachineStore } from "../host/paired-machines.ts";
import { generateHostKey } from "../host/machine-keys.ts";
import { RemoteHosts } from "../host/remote-hosts.ts";
import { emptyOutbox, OUTBOX_VERSION } from "../orchestration/outbox.ts";
import {
  type SetAsideDeps,
  setAsideReleased,
  type SnapshotStore,
} from "./hosted-machine-set-aside.ts";
import { fakeApp, NAME, ORIGIN, provisionRelayed } from "./signed-in-fixtures.ts";
import { noRoomWords, RELAYED_MOST, relaysOf, restingBy } from "./signed-in-room.ts";
import { setAsideStoppedSignedIn } from "./signed-in-set-aside.ts";
import {
  bridgeWorkerMachines,
  SignedInWorkers,
  SignedInWorkersLive,
  signedInSource,
  WorkerMachinePort,
  type WorkerMachinePortShape,
} from "./signed-in-workers.ts";

const on = (hostId: string) => ({ path: "/w", hostId: HostId.make(hostId) }) as unknown as Checkout;
const threadOn = (id: string, hostId: string, fields: Partial<Thread> = {}) =>
  ({ id: id as ThreadId, parked: true, checkout: on(hostId), ...fields }) as unknown as Thread;

const WORKSPACE = "ws-1" as WorkspaceId;

/** The threads and what is stored and running of them, as the release pass reads them. */
interface World {
  threads: ReadonlyArray<Thread>;
  unknown?: ReadonlyArray<ThreadId>;
  unknownParked?: ReadonlyArray<ThreadId>;
  plainWakes?: ReadonlyArray<ThreadId>;
  workerWakes?: ReadonlyArray<ThreadId>;
  queued?: ReadonlyArray<ThreadId>;
  requests?: ReadonlyArray<ThreadId>;
  working?: ReadonlyArray<ThreadId>;
  summaries?: ReadonlyArray<{ readonly id: ThreadId; readonly summary: Record<string, unknown> }>;
  outbox?: string;
}

const outboxWith = (wakes: ReadonlyArray<ThreadId>, setAside?: string) =>
  JSON.stringify({
    version: OUTBOX_VERSION,
    ...(setAside === undefined ? {} : { setAside }),
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
  listQueue: (id) => Effect.sync(() => ((world.queued ?? []).includes(id) ? [{}] : []) as never),
  listRequests: (id) =>
    Effect.sync(() => ((world.requests ?? []).includes(id) ? [{}] : []) as never),
});

const depsOf = (world: World): SetAsideDeps => ({
  store: storeOf(world),
  runtimes: {
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
  },
});

/** The pass over `ids` (settled long since), noting what it sets aside and takes back. */
const passOver = (ids: ReadonlyArray<string>, world: World, aside: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const setAside: string[] = [];
    const takenBack: string[] = [];
    yield* setAsideReleased(
      ids.map((id) => ({ id, joinedAt: 0 })),
      aside.map((id) => ({ id, joinedAt: 0 })),
      depsOf(world),
      (id, final) => final(() => (setAside.push(id), true)),
      (id) => takenBack.push(id),
    );
    return { setAside, takenBack };
  });

const live = (answer: (call: string) => { status: number; body: unknown }) =>
  Effect.gen(function* () {
    const hosts = yield* RemoteHosts.make(memoryMachineStore());
    const { id } = provisionRelayed(hosts, NAME);
    const told: Array<ReadonlyArray<{ readonly name: string }>> = [];
    const app = fakeApp({ answer: ({ call }) => answer(call) });
    const port = {
      ...bridgeWorkerMachines(app.port),
      relays: (machines: ReadonlyArray<{ origin: string; name: string }>) => {
        told.push(machines);
      },
    };
    const context = yield* Layer.build(
      SignedInWorkersLive.pipe(
        Layer.provide(Layer.succeed(WorkerMachinePort)(port)),
        Layer.provide(Layer.succeed(RemoteHosts)(hosts)),
      ),
    );
    const signedIn = yield* SignedInWorkers.pipe(Effect.provide(context));
    return { hosts, id, app, told, aside: signedIn.setAside! };
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

const now = (setAside: () => boolean) => Effect.sync(setAside);

const isAside = (hosts: RemoteHosts["Service"], id: string) =>
  hosts.machines.get(id)?.setAside !== undefined;

describe("the release pass sets a hosted machine aside", () => {
  it.effect(
    "only once every thread on it is archived, with nothing going on, stored or watched",
    () =>
      Effect.gen(function* () {
        const ids = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];
        const { setAside } = yield* passOver(ids, {
          threads: [
            threadOn("idle", "1"),
            threadOn("turn", "2"),
            threadOn("plain-wake", "3"),
            threadOn("worker-wake", "4"),
            threadOn("not-archived", "5", { parked: false }),
            threadOn("run-watch", "6", { runWatches: [{}] as never }),
            threadOn("subagent", "7"),
            threadOn("queued-now", "8"),
            threadOn("request-now", "9"),
            threadOn("starting", "10"),
            threadOn("queued-stored", "11"),
            threadOn("request-stored", "12"),
          ],
          working: ["turn" as ThreadId, "subagent" as ThreadId],
          summaries: [
            { id: "queued-now" as ThreadId, summary: { queue: [{}] } },
            { id: "request-now" as ThreadId, summary: { pendingRequests: [{}] } },
            { id: "starting" as ThreadId, summary: { status: "starting" } },
          ],
          plainWakes: ["plain-wake" as ThreadId],
          workerWakes: ["worker-wake" as ThreadId],
          queued: ["queued-stored" as ThreadId],
          requests: ["request-stored" as ThreadId],
        });
        expect(setAside).toEqual(["1"]);
      }),
  );

  it.effect("none, and every one set aside taken back, while something can't be read", () =>
    Effect.gen(function* () {
      const threads = [threadOn("idle", "1"), threadOn("idle-too", "2")];
      for (const world of [
        { threads, unknown: ["x" as ThreadId] },
        { threads, unknownParked: ["x" as ThreadId] },
        { threads, outbox: "not an outbox" },
        { threads, outbox: outboxWith([], "an unreadable outbox it took the place of") },
      ])
        expect(yield* passOver(["1"], world, ["2"])).toEqual({ setAside: [], takenBack: ["2"] });
      expect(yield* passOver(["1"], { threads }, ["2"])).toEqual({
        setAside: ["1"],
        takenBack: [],
      });
    }),
  );

  it.effect(
    "takes one set aside back once a thread on it is unarchived, or a message is queued",
    () =>
      Effect.gen(function* () {
        const aside = ["1", "2", "3"];
        const { takenBack } = yield* passOver(
          [],
          {
            threads: [
              threadOn("unarchived", "1", { parked: false }),
              threadOn("queued", "2"),
              threadOn("idle", "3"),
            ],
            queued: ["queued" as ThreadId],
          },
          aside,
        );
        expect(takenBack).toEqual(["1", "2"]);
      }),
  );

  it.effect(
    "sets nothing aside, and keeps the machine whole, when a read before or after its status dies",
    () =>
      Effect.gen(function* () {
        for (const dieOn of [1, 2]) {
          const hosts = yield* RemoteHosts.make(memoryMachineStore());
          const { id } = provisionRelayed(hosts, NAME);
          const before = hosts.machines.get(id);
          const unrelayed: string[] = [];
          const world: World = { threads: [threadOn("idle", id)] };
          let reads = 0;
          const deps = depsOf(world);
          const store: SnapshotStore = {
            ...deps.store,
            listThreadsForClaims: Effect.suspend(() =>
              (reads += 1) === dieOn
                ? Effect.die(new Error("SQLITE_IOERR"))
                : deps.store.listThreadsForClaims,
            ),
          };
          const port = { ...stoppedApp(), unrelay: (name: string) => unrelayed.push(name) };
          const exit = yield* Effect.exit(
            setAsideReleased(
              [{ id, joinedAt: 0 }],
              [],
              { ...deps, store },
              (each, final) => setAsideStoppedSignedIn(port, hosts, {}, each, final),
              () => undefined,
            ),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          expect(reads).toBe(dieOn);
          expect(hosts.machines.get(id)).toEqual(before);
          expect(unrelayed).toEqual([]);
        }
      }),
  );
});

describe("a signed-in hosted machine set aside", () => {
  it.live(
    "is kept whole, ends its relay and leaves the list carried, once its server says it is stopped",
    () =>
      Effect.gen(function* () {
        const { hosts, id, app, told, aside } = yield* live((call) =>
          call === "status"
            ? { status: 200, body: { phase: "stopped" } }
            : { status: 200, body: {} },
        );
        const before = hosts.machines.get(id)!;
        expect(yield* aside.stopped(id, now)).toBe(true);
        // Registered as it was, key, id and all: only marked set aside.
        const { setAside, ...kept } = hosts.machines.get(id)!;
        expect(setAside).toBeTypeOf("number");
        expect(kept).toEqual(before);
        expect(hosts.list().map((each) => each.id)).toEqual([id]);
        // Neither stopped nor released there.
        expect(app.calls.filter((each) => each.call !== "status")).toEqual([]);
        yield* Effect.sleep("20 millis");
        expect(told.at(-1)?.map((each) => each.name) ?? []).toEqual([]);
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
        const { hosts, id, aside } = yield* live(() => answer);
        expect(yield* aside.stopped(id, now)).toBe(false);
        expect(isAside(hosts, id)).toBe(false);
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
            setAsideStoppedSignedIn(port, hosts, { sent }, id, now),
          );
          yield* Deferred.await(asked);
          if (meanwhile === "wanted")
            yield* Effect.forkScoped(hosts.stops.wanting(HostId.make(id), Effect.never));
          else sent.set(NAME, 2);
          yield* Effect.yieldNow;
          yield* Deferred.succeed(answer, undefined);
          expect(yield* Fiber.join(pass)).toBe(false);
          expect(isAside(hosts, id)).toBe(false);
        }
      }).pipe(Effect.scoped),
  );

  it.live("not when its worker is unarchived while its status is asked, through both stages", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      const { id } = provisionRelayed(hosts, NAME);
      const held = yield* heldPort(stoppedApp());
      const world: World = { threads: [threadOn("worker", id)] };
      const pass = yield* Effect.forkScoped(
        setAsideReleased(
          [{ id, joinedAt: 0 }],
          [],
          depsOf(world),
          (each, final) => setAsideStoppedSignedIn(held.port, hosts, {}, each, final),
          () => undefined,
        ),
      );
      yield* Deferred.await(held.asked);
      // `thread.park(false)`: the row changes, and no wake or want is queued.
      world.threads = [threadOn("worker", id, { parked: false })];
      yield* Deferred.succeed(held.answer, undefined);
      yield* Fiber.join(pass);
      expect(isAside(hosts, id)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.live(
    "is taken back by a session that wants it, as an unarchived worker's does, and woken",
    () =>
      Effect.gen(function* () {
        const { hosts, id, app, aside } = yield* live((call) =>
          call === "status"
            ? { status: 200, body: { phase: "stopped" } }
            : { status: call === "start" ? 202 : 200, body: {} },
        );
        expect(yield* aside.stopped(id, now)).toBe(true);
        // Its record is all there, so the session finds the machine and waits for it.
        yield* Effect.forkScoped(hosts.stops.wanting(HostId.make(id), Effect.never));
        while (!app.calls.some((each) => each.call === "start")) yield* Effect.sleep("5 millis");
        expect(isAside(hosts, id)).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.live("is taken back by a start of its name: a spawn that reuses it", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      const { id } = provisionRelayed(hosts, NAME);
      hosts.machines.setAside(id, 1);
      const source = signedInSource(
        { origin: ORIGIN, server: "Example hosted", account: hosts.list()[0]!.viaAccount! },
        {
          port: stoppedApp(),
          hosts,
          everyMs: 10,
          timeoutMs: 50,
          asleep: new Set([NAME]),
        },
      );
      yield* source.arrive(NAME);
      expect(isAside(hosts, id)).toBe(false);
    }),
  );
});

describe("a machine set aside takes no relay and no room", () => {
  it.live("after a restart it isn't relayed, and stays so when its server says it runs", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      const { id } = provisionRelayed(hosts, NAME);
      const other = provisionRelayed(hosts, "worker-abcdef0123");
      hosts.machines.setAside(id, 1);
      const told: Array<ReadonlyArray<{ readonly name: string }>> = [];
      // Its server says running: the pass takes it out of asleep, as for any machine.
      const app = fakeApp({ answer: () => ({ status: 200, body: { phase: "running" } }) });
      const port = {
        ...bridgeWorkerMachines(app.port),
        relays: (machines: ReadonlyArray<{ origin: string; name: string }>) => {
          told.push(machines);
        },
      };
      yield* Layer.build(
        SignedInWorkersLive.pipe(
          Layer.provide(Layer.succeed(WorkerMachinePort)(port)),
          Layer.provide(Layer.succeed(RemoteHosts)(hosts)),
        ),
      );
      while (app.calls.filter((each) => each.call === "status").length < 2)
        yield* Effect.sleep("5 millis");
      yield* Effect.sleep("20 millis");
      expect(told.length).toBeGreaterThan(0);
      for (const each of told)
        expect(each.map((machine) => machine.name)).toEqual([
          hosts.list().find((machine) => machine.id === other.id)!.name,
        ]);
    }).pipe(Effect.scoped),
  );

  it("isn't counted toward the most carried, asleep or not", () => {
    const machines = Array.from({ length: RELAYED_MOST }, (_, index) => ({
      id: `m${index}`,
      name: `worker-${index.toString(16).padStart(10, "0")}`,
      via: ORIGIN,
      onDemand: "worker",
    }));
    expect(
      noRoomWords(
        machines,
        restingBy(new Set(), () => false),
      ),
    ).toBeDefined();
    expect(
      noRoomWords(
        machines,
        restingBy(new Set(), (id) => id === "m0"),
      ),
    ).toBeUndefined();
  });

  it.effect("is relayed by no list", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      const { id } = provisionRelayed(hosts, NAME);
      hosts.machines.setAside(id, 1);
      expect(
        relaysOf(
          hosts,
          restingBy(new Set(), (each) => isAside(hosts, each)),
        ),
      ).toEqual([]);
      hosts.machines.setAside(id, undefined);
      expect(
        relaysOf(
          hosts,
          restingBy(new Set(), (each) => isAside(hosts, each)),
        ),
      ).toHaveLength(1);
    }),
  );
});

describe("the mark a machine is set aside by", () => {
  it.effect("is kept as written, read back from the file, and only on a relayed host", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-set-aside-"));
      const hosts = yield* RemoteHosts.make(fileMachineStore(dir));
      const { id } = provisionRelayed(hosts, NAME);
      hosts.machines.setAside(id, 7);
      const again = yield* RemoteHosts.make(fileMachineStore(dir));
      expect(again.machines.get(id)?.setAside).toBe(7);
      // Taken back: the record is as it was before it was set aside.
      hosts.machines.setAside(id, undefined);
      const back = yield* RemoteHosts.make(fileMachineStore(dir));
      expect(back.machines.get(id)).toBeDefined();
      expect(back.machines.get(id)?.setAside).toBeUndefined();
      const joined = hosts.machines.provision({
        name: "plain-host",
        publicKey: generateHostKey().publicKey,
        platform: "linux",
        onDemand: "worker",
        owner: "someone",
      });
      if (joined.kind !== "provisioned") throw new Error(joined.message);
      hosts.machines.setAside(joined.machine.id, 7);
      expect(hosts.machines.get(joined.machine.id)?.setAside).toBeUndefined();
    }),
  );
});
