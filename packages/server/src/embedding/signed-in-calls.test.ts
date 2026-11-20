// One worker machine's calls to a hosted server: what each answer to a start means, a wake of a
// machine that work here wants, and the names sent; with a fake app over the port, no network and
// no real machine.

import { describe, expect, it } from "@effect/vitest";
import { HostId, HostUnavailable, type ThreadId } from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { memoryMachineStore } from "../host/paired-machines.ts";
import { RemoteHosts } from "../host/remote-hosts.ts";
import { awaitedMachines } from "../host/worker-host.ts";
import { fakeApp, NAME, ORIGIN, provisionRelayed, SERVER } from "./signed-in-fixtures.ts";
import {
  bridgeWorkerMachines,
  forgetReclaimed,
  isHostedWorkerName,
  SignedInWorkersLive,
  signedInSource,
  START_ATTEMPTS,
  tellSignedInRelease,
  WAKE_RETRY_MS,
  wakeSignedIn,
  WorkerMachinePort,
  type WorkerMachinePortShape,
} from "./signed-in-workers.ts";
import { releaseTeller } from "./worker-machine-release.ts";
import { workerMachineName } from "./worker-machines.ts";

describe("a hosted server's answers about one machine", () => {
  const noMachines = {
    list: () => [],
    remove: () => false,
    machines: {
      provision: () => {
        throw new Error("not registered here");
      },
    },
  };

  it.effect("starts a machine still released once more, after taking the release back", () =>
    Effect.gen(function* () {
      let released = true;
      const app = fakeApp({
        answer: ({ call, body }) => {
          if (call === "release" && body["released"] === false) released = false;
          return call === "start" && released
            ? { status: 409, body: { code: "released" } }
            : { status: call === "start" ? 202 : 200, body: {} };
        },
      });
      const source = signedInSource(SERVER, {
        port: bridgeWorkerMachines(app.port),
        hosts: noMachines,
      });
      expect(yield* source.start({ name: NAME, orchestrator: "o", title: "Again" })).toEqual({
        kind: "started",
        name: NAME,
      });
      expect(app.calls.map((each) => each.call)).toEqual(["start", "release", "start"]);
    }),
  );

  it.effect("asks again at most once, however the server answers the second time", () =>
    Effect.gen(function* () {
      const app = fakeApp({
        answer: ({ call }) =>
          call === "start"
            ? { status: 409, body: { code: "released" } }
            : { status: 200, body: {} },
      });
      const source = signedInSource(SERVER, {
        port: bridgeWorkerMachines(app.port),
        hosts: noMachines,
      });
      const started = yield* source.start({ name: NAME, orchestrator: "o", title: "Again" });
      expect(started.kind).toBe("refused");
      expect(app.calls.map((each) => each.call)).toEqual(["start", "release", "start"]);
    }),
  );

  it.live("asks again, after a wait, a start the server is unavailable for", () =>
    Effect.gen(function* () {
      let unavailable = 2;
      const app = fakeApp({
        answer: ({ call }) =>
          call === "start" && unavailable-- > 0
            ? { status: 503, body: { code: "unavailable" } }
            : { status: call === "start" ? 202 : 200, body: {} },
      });
      const source = signedInSource(SERVER, {
        port: bridgeWorkerMachines(app.port),
        hosts: noMachines,
        startRetryMs: 5,
      });
      expect(yield* source.start({ name: NAME, orchestrator: "o", title: "Again" })).toEqual({
        kind: "started",
        name: NAME,
      });
      expect(app.calls.map((each) => each.call)).toEqual(["start", "start", "start"]);
    }),
  );

  it.live("refuses a start the server stays unavailable for, as one that may have started", () =>
    Effect.gen(function* () {
      const app = fakeApp({
        answer: () => ({ status: 503, body: { code: "unavailable" } }),
      });
      const source = signedInSource(SERVER, {
        port: bridgeWorkerMachines(app.port),
        hosts: noMachines,
        startRetryMs: 5,
      });
      const started = yield* source.start({ name: NAME, orchestrator: "o", title: "Again" });
      // Not over the total, nor gone; and a 503 may come back for a call that reached its
      // machines, so it is given back as a start whose outcome isn't known.
      expect(started).toMatchObject({ kind: "refused", unknown: true });
      expect(app.calls.map((each) => each.call)).toEqual(
        Array.from({ length: START_ATTEMPTS }, () => "start"),
      );
    }),
  );

  it.live("asks a start three times in all, a release taken back between them included", () =>
    Effect.gen(function* () {
      // 503, 503, released; taken back; then 503 for good.
      const starts = [503, 503, 409];
      const app = fakeApp({
        answer: ({ call }) => {
          if (call !== "start") return { status: 200, body: {} };
          const status = starts.shift() ?? 503;
          return { status, body: { code: status === 409 ? "released" : "unavailable" } };
        },
      });
      const source = signedInSource(SERVER, {
        port: bridgeWorkerMachines(app.port),
        hosts: noMachines,
        startRetryMs: 5,
      });
      yield* source.start({ name: NAME, orchestrator: "o", title: "Again" });
      // The three asks, and the one more a take-back allows: never three more after it.
      expect(app.calls.map((each) => each.call)).toEqual([
        "start",
        "start",
        "start",
        "release",
        "start",
      ]);
    }),
  );

  it.effect("spends a name whose release can't be taken back, and starts nothing again", () =>
    Effect.gen(function* () {
      // Released and already due for reclaim there: the take-back is answered not_found.
      const app = fakeApp({
        answer: ({ call }) =>
          call === "start"
            ? { status: 409, body: { code: "released" } }
            : { status: 404, body: { code: "not_found" } },
      });
      const source = signedInSource(SERVER, {
        port: bridgeWorkerMachines(app.port),
        hosts: noMachines,
      });
      const started = yield* source.start({ name: NAME, orchestrator: "o", title: "Again" });
      expect(started).toMatchObject({ kind: "refused" });
      expect(started).not.toHaveProperty("unknown");
      expect(app.calls.map((each) => each.call)).toEqual(["start", "release"]);
    }),
  );

  it.effect("reads a release the server answers not_found as a machine gone, and forgets it", () =>
    Effect.gen(function* () {
      const app = fakeApp({ answer: () => ({ status: 404, body: { code: "not_found" } }) });
      const gone: string[] = [];
      const tell = releaseTeller(undefined, bridgeWorkerMachines(app.port), (machine) =>
        Effect.sync(() => gone.push(machine.name)),
      )!;
      const machine = {
        id: "m-0123456789abcdef01234567",
        name: NAME,
        onDemand: "worker",
        via: ORIGIN,
      };
      // Taken as told: nothing to tell again of a machine reclaimed there.
      expect((yield* tell(machine, true).pipe(Effect.result))._tag).toBe("Success");
      expect(gone).toEqual([NAME]);
    }),
  );

  it.live("asks again, after a wait, a release the server is too busy for", () =>
    Effect.gen(function* () {
      let busy = 2;
      const app = fakeApp({
        answer: () =>
          busy-- > 0
            ? { status: 503, body: { code: "busy" } }
            : { status: 200, body: { known: true, released: true } },
      });
      const told = yield* tellSignedInRelease(
        bridgeWorkerMachines(app.port),
        { name: NAME, via: ORIGIN },
        true,
        { retryMs: 5 },
      );
      expect(told).toBe("applied");
      expect(app.calls).toHaveLength(3);
    }),
  );
});

describe("a worker machine that work here wants", () => {
  it.live("is started when a worker resumes on it paused, and never for a dial", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      const { id } = provisionRelayed(hosts, NAME);
      // Paused there while the desktop was away: stopped until a start of its name.
      let phase = "stopped";
      const app = fakeApp({
        answer: ({ call }) => {
          if (call === "start") phase = "starting";
          return call === "status"
            ? { status: 200, body: { phase } }
            : { status: call === "start" ? 202 : 200, body: {} };
        },
      });
      const port = bridgeWorkerMachines(app.port);
      yield* Layer.build(
        SignedInWorkersLive.pipe(
          Layer.provide(Layer.succeed(WorkerMachinePort)(port)),
          Layer.provide(Layer.succeed(RemoteHosts)(hosts)),
        ),
      );
      // The relays are told and the reclaimed pass asks after it: nothing starts it.
      yield* Effect.sleep("50 millis");
      expect(app.calls.map((each) => each.call)).not.toContain("start");
      // A worker placed on it resumes: its session waits for the machine, as it opens.
      const forSession = awaitedMachines(
        (hostId) => Effect.fail(new HostUnavailable({ hostId, message: "away" })),
        hosts,
        { getSettings: Effect.succeed({ experimental: { embedding: true } } as never) },
        60_000,
      );
      const opening = yield* Effect.forkScoped(forSession(HostId.make(id), "t-1" as ThreadId));
      while (!app.calls.some((each) => each.call === "start")) yield* Effect.sleep("10 millis");
      expect(app.calls.filter((each) => each.call === "start").map((each) => each.body)).toEqual([
        { name: NAME },
      ]);
      yield* Fiber.interrupt(opening);
    }).pipe(Effect.scoped),
  );

  it.live("sends no start once the last session waiting for it has gone", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      const { id } = provisionRelayed(hosts, NAME);
      const app = fakeApp({
        answer: ({ call }) =>
          call === "status"
            ? { status: 200, body: { phase: "stopped" } }
            : { status: 202, body: {} },
      });
      const bridged = bridgeWorkerMachines(app.port);
      // Every status answer waits until let through.
      const through = yield* Deferred.make<void>();
      const asked = { count: 0 };
      const port: WorkerMachinePortShape = {
        ...bridged,
        call: (origin, call, body) =>
          call === "status"
            ? Effect.sync(() => (asked.count += 1)).pipe(
                Effect.andThen(Deferred.await(through)),
                Effect.andThen(bridged.call(origin, call, body)),
              )
            : bridged.call(origin, call, body),
      };
      yield* Layer.build(
        SignedInWorkersLive.pipe(
          Layer.provide(Layer.succeed(WorkerMachinePort)(port)),
          Layer.provide(Layer.succeed(RemoteHosts)(hosts)),
        ),
      );
      const forSession = awaitedMachines(
        (hostId) => Effect.fail(new HostUnavailable({ hostId, message: "away" })),
        hosts,
        { getSettings: Effect.succeed({ experimental: { embedding: true } } as never) },
        60_000,
      );
      const opening = yield* Effect.forkScoped(forSession(HostId.make(id), "t-1" as ThreadId));
      // The pass's status read and the wake's are both on their way.
      while (asked.count < 2) yield* Effect.sleep("10 millis");
      // The only session waiting gives up, then the server answers: stopped.
      yield* Fiber.interrupt(opening);
      yield* Deferred.succeed(through, undefined);
      yield* Effect.sleep("100 millis");
      expect(app.calls.map((each) => each.call)).not.toContain("start");
    }).pipe(Effect.scoped),
  );

  it.effect("wakes it once a passing error has passed, while it is still wanted", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      const { id } = provisionRelayed(hosts, NAME);
      // The pass's read and the wake's first are a passing 503; then it says stopped.
      let reads = 0;
      const app = fakeApp({
        answer: ({ call }) => {
          if (call !== "status") return { status: 202, body: {} };
          reads += 1;
          return reads <= 2
            ? { status: 503, body: { code: "unavailable" } }
            : { status: 200, body: { phase: "stopped" } };
        },
      });
      yield* Layer.build(
        SignedInWorkersLive.pipe(
          Layer.provide(Layer.succeed(WorkerMachinePort)(bridgeWorkerMachines(app.port))),
          Layer.provide(Layer.succeed(RemoteHosts)(hosts)),
        ),
      );
      const forSession = awaitedMachines(
        (hostId) => Effect.fail(new HostUnavailable({ hostId, message: "away" })),
        hosts,
        { getSettings: Effect.succeed({ experimental: { embedding: true } } as never) },
        60_000,
      );
      const opening = yield* Effect.forkScoped(forSession(HostId.make(id), "t-1" as ThreadId));
      yield* TestClock.adjust("1 second");
      expect(reads).toBe(2);
      expect(app.calls.map((each) => each.call)).not.toContain("start");
      yield* TestClock.adjust(WAKE_RETRY_MS + 1_000);
      expect(app.calls.filter((each) => each.call === "start").map((each) => each.body)).toEqual([
        { name: NAME },
      ]);
      yield* Fiber.interrupt(opening);
    }).pipe(Effect.scoped),
  );

  it.effect("takes no status asked for before a start of its name as the machine's", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      provisionRelayed(hosts, NAME);
      const asleep = new Set<string>();
      const sent = new Map<string, number>();
      const unrelayed: string[] = [];
      let phase = "stopped";
      const through = yield* Deferred.make<void>();
      const asked = { count: 0 };
      const app = fakeApp({ answer: () => ({ status: 200, body: { phase } }) });
      const bridged = bridgeWorkerMachines(app.port);
      const port: WorkerMachinePortShape = {
        ...bridged,
        unrelay: (name) => unrelayed.push(name),
        call: (origin, call, body) =>
          Effect.sync(() => (asked.count += 1)).pipe(
            Effect.andThen(Deferred.await(through)),
            Effect.andThen(bridged.call(origin, call, body)),
          ),
      };
      const pass = yield* Effect.forkScoped(forgetReclaimed(port, hosts, new Map(), asleep, sent));
      while (asked.count < 1) yield* Effect.yieldNow;
      // A wake's start goes out while the pass's read is on its way, then the old answer comes.
      sent.set(NAME, 1);
      yield* Deferred.succeed(through, undefined);
      yield* Fiber.join(pass);
      expect([...asleep]).toEqual([]);
      expect(unrelayed).toEqual([]);
      // Asleep, then up again there: carried once more.
      asleep.add(NAME);
      phase = "running";
      yield* forgetReclaimed(port, hosts, new Map(), asleep, sent);
      expect([...asleep]).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live("takes a release back before it starts one, as a spawn's start does", () =>
    Effect.gen(function* () {
      let released = true;
      const app = fakeApp({
        answer: ({ call, body }) => {
          if (call === "release" && body["released"] === false) released = false;
          if (call === "status") return { status: 200, body: { phase: "stopped" } };
          return call === "start" && released
            ? { status: 409, body: { code: "released" } }
            : { status: call === "start" ? 202 : 200, body: {} };
        },
      });
      const woke = yield* wakeSignedIn(bridgeWorkerMachines(app.port), { name: NAME, via: ORIGIN });
      expect(woke).toBe("started");
      expect(app.calls.map((each) => each.call)).toEqual(["status", "start", "release", "start"]);
    }),
  );

  it.live("starts nothing the server doesn't say is stopped or failed", () =>
    Effect.gen(function* () {
      for (const answer of [
        { status: 404, body: { code: "not_found" } },
        { status: 200, body: { phase: "running" } },
        { status: 503, body: { code: "unavailable" } },
      ]) {
        const app = fakeApp({ answer: () => answer });
        yield* wakeSignedIn(bridgeWorkerMachines(app.port), { name: NAME, via: ORIGIN });
        expect(app.calls.map((each) => each.call)).toEqual(["status"]);
      }
    }),
  );
});

describe("worker machine names", () => {
  it("are always ones a hosted server takes", () => {
    for (let each = 0; each < 50; each += 1) {
      expect(isHostedWorkerName(workerMachineName("o", undefined))).toBe(true);
      expect(isHostedWorkerName(workerMachineName("o", `request-${each}`))).toBe(true);
    }
  });

  it.effect("send no call for a name a hosted server wouldn't take", () =>
    Effect.gen(function* () {
      const app = fakeApp({ answer: () => ({ status: 202, body: {} }) });
      const port = bridgeWorkerMachines(app.port);
      const source = signedInSource(SERVER, {
        port,
        hosts: {
          list: () => [],
          remove: () => false,
          machines: { provision: () => ({}) as never },
        },
      });
      const started = yield* source.start({
        name: "worker-zzzzzzzzzz",
        orchestrator: "o",
        title: "x",
      });
      expect(started.kind).toBe("refused");
      expect(yield* wakeSignedIn(port, { name: "worker-ABC", via: ORIGIN })).toBe("refused");
      expect(app.calls).toEqual([]);
    }),
  );
});
