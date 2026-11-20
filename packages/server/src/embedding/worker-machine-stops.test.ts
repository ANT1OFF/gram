// Stops a hosted server never confirmed, kept and asked again, and a start and a stop of one name
// that never overlap, with a fake app over the port: no network, no real machine.

import { describe, expect, it } from "@effect/vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { makeKeyedLock } from "../git/keyed-lock.ts";
import { fakeApp, NAME, ORIGIN, SERVER } from "./signed-in-fixtures.ts";
import {
  bridgeWorkerMachines,
  fileOwedStops,
  memoryOwedStops,
  OWED_MOST,
  type NameLocks,
  RECLAIMED_AFTER_MISSES,
  stopHoldUntil,
  STOPS_FILE_MOST,
  settleOwedStops,
  signedInSource,
  UNSETTLED_START_MS,
  wakeSignedIn,
  type WorkerMachinePortShape,
} from "./signed-in-workers.ts";

describe("stops a server never confirmed", () => {
  const unregistered = {
    list: () => [],
    remove: () => false,
    machines: {
      provision: () => {
        throw new Error("not registered here");
      },
    },
  };

  it.effect(
    "for a start whose outcome wasn't known, aren't settled by a 404 until no start can still come",
    () =>
      Effect.gen(function* () {
        // The server doesn't know the machine yet: its start may still be on its way.
        const app = fakeApp({
          answer: ({ call }) =>
            call === "stop"
              ? { status: 404, body: { code: "not_found" } }
              : { status: 200, body: {} },
        });
        const bridged = bridgeWorkerMachines(app.port);
        // Its start reaches the server, and the answer is lost.
        const port: WorkerMachinePortShape = {
          ...bridged,
          call: (origin, call, body) =>
            call === "start"
              ? Effect.succeed({ ok: false as const, why: "no answer" })
              : bridged.call(origin, call, body),
        };
        const owed = memoryOwedStops();
        let clock = 1_000;
        const source = signedInSource(SERVER, {
          port,
          hosts: unregistered,
          owed,
          stopRetryMs: 0,
          now: () => clock,
        });
        yield* source.start({ name: NAME, orchestrator: "o", title: "Heavy" });
        yield* source.abandon(NAME, { unsettled: true });
        expect(owed.list()).toEqual([
          {
            origin: ORIGIN,
            name: NAME,
            since: 1_000,
            unsettled: true,
            start: true,
            attempt: expect.any(String),
          },
        ]);
        // Still within the time a start may take: however many 404s, they settle nothing.
        const misses = new Map<string, number>();
        const pass = (at: number) =>
          settleOwedStops(
            port,
            owed,
            () => false,
            () => at,
            undefined,
            () => false,
            misses,
          );
        for (let each = 0; each < RECLAIMED_AFTER_MISSES; each += 1)
          yield* pass(clock + UNSETTLED_START_MS - 1);
        expect(owed.list()).toHaveLength(1);
        clock += UNSETTLED_START_MS;
        yield* pass(clock);
        expect(owed.list()).toEqual([]);
      }),
  );

  it.effect("keep a stop owed through a 404 until it comes passes in a row, not_found alone", () =>
    Effect.gen(function* () {
      // As a server answers every call while it has no cell manager, then once it has one again.
      const away = { status: 404, body: { code: "not_found", message: "No cell manager here." } };
      const answers = [away, away, away, { status: 200, body: { stopped: true } }];
      const app = fakeApp({ answer: () => answers.shift() ?? { status: 503, body: {} } });
      const port = bridgeWorkerMachines(app.port);
      const owed = memoryOwedStops();
      const source = signedInSource(SERVER, { port, hosts: unregistered, owed, stopRetryMs: 0 });
      // Given back while the server answers 404 to each of its attempts: owed, not let go.
      yield* source.abandon(NAME);
      expect(owed.list()).toHaveLength(1);
      // Asked again once the server is back: stopped there, and only then settled.
      yield* settleOwedStops(port, owed);
      expect(app.calls.map((each) => each.call)).toEqual(["stop", "stop", "stop", "stop"]);
      expect(owed.list()).toEqual([]);
      // A 404 with no not_found never settles one; not_found does only passes in a row.
      for (const [body, settles] of [
        [{}, false],
        [{ code: "not_found" }, true],
      ] as const) {
        const answer = fakeApp({ answer: () => ({ status: 404, body }) });
        const left = memoryOwedStops();
        left.add({ origin: ORIGIN, name: NAME, since: 0 });
        const misses = new Map<string, number>();
        const settle = settleOwedStops(
          bridgeWorkerMachines(answer.port),
          left,
          () => false,
          Date.now,
          undefined,
          () => false,
          misses,
        );
        for (let each = 1; each < RECLAIMED_AFTER_MISSES; each += 1) yield* settle;
        expect(left.list()).toHaveLength(1);
        yield* settle;
        expect(left.list()).toHaveLength(settles ? 0 : 1);
      }
    }),
  );

  it.effect("read a 2xx that says nothing was stopped as no such machine, through the grace", () =>
    Effect.gen(function* () {
      // As a server answers a stop of a name it holds nothing for yet.
      let stopped = false;
      const app = fakeApp({
        answer: ({ call }) =>
          call === "stop" ? { status: 200, body: { stopped } } : { status: 200, body: {} },
      });
      const bridged = bridgeWorkerMachines(app.port);
      // Its start reaches the server, and the answer is lost.
      const port: WorkerMachinePortShape = {
        ...bridged,
        call: (origin, call, body) =>
          call === "start"
            ? Effect.succeed({ ok: false as const, why: "no answer" })
            : bridged.call(origin, call, body),
      };
      const owed = memoryOwedStops();
      const source = signedInSource(SERVER, {
        port,
        hosts: unregistered,
        owed,
        stopRetryMs: 0,
        now: () => 1_000,
      });
      yield* source.start({ name: NAME, orchestrator: "o", title: "Heavy" });
      yield* source.abandon(NAME, { unsettled: true });
      expect(owed.list()).toEqual([
        {
          origin: ORIGIN,
          name: NAME,
          since: 1_000,
          unsettled: true,
          start: true,
          attempt: expect.any(String),
        },
      ]);
      yield* settleOwedStops(
        port,
        owed,
        () => false,
        () => 2_000,
      );
      expect(owed.list()).toHaveLength(1);
      // The start made it after all, and this stop ends it: settled.
      stopped = true;
      yield* settleOwedStops(
        port,
        owed,
        () => false,
        () => 3_000,
      );
      expect(owed.list()).toEqual([]);
    }),
  );

  it.live("send a retry's start only once a stop of its name already on its way is answered", () =>
    Effect.gen(function* () {
      const log: string[] = [];
      const { port: base } = {
        port: bridgeWorkerMachines(fakeApp({ answer: () => ({ status: 200, body: {} }) }).port),
      };
      // The server takes its time over the stop it was sent.
      const port: WorkerMachinePortShape = {
        ...base,
        call: (_origin, call) =>
          Effect.gen(function* () {
            log.push(`${call} sent`);
            if (call === "stop") yield* Effect.sleep("200 millis");
            log.push(`${call} answered`);
            return {
              ok: true as const,
              status: call === "start" ? 202 : 200,
              body: { stopped: true },
            };
          }),
      };
      const owed = memoryOwedStops();
      const locks: NameLocks = makeKeyedLock<string>();
      const starting = new Set<string>();
      owed.add({ origin: ORIGIN, name: NAME, since: 0 });
      const source = signedInSource(SERVER, { port, hosts: unregistered, owed, starting, locks });
      const settling = yield* Effect.forkScoped(
        settleOwedStops(port, owed, (name) => starting.has(name), Date.now, locks),
      );
      while (!log.includes("stop sent")) yield* Effect.sleep("5 millis");
      // A retry of the spawn that owed it: its start waits for the stop already on its way.
      yield* source.start({ name: NAME, orchestrator: "o", title: "Retry" });
      yield* Fiber.join(settling);
      expect(log).toEqual(["stop sent", "stop answered", "start sent", "start answered"]);
    }).pipe(Effect.scoped),
  );

  it.live("hold a name after a stop no one answered, whatever later attempts are answered", () =>
    Effect.gen(function* () {
      const log: string[] = [];
      const seen = { stops: 0 };
      const base = bridgeWorkerMachines(
        fakeApp({ answer: () => ({ status: 202, body: {} }) }).port,
      );
      // The first stop times out, and may still reach the server; the next two are throttled.
      const port: WorkerMachinePortShape = {
        ...base,
        call: (_origin, call) =>
          Effect.sync(() => {
            log.push(call);
            if (call !== "stop") return { ok: true as const, status: 202, body: {} };
            seen.stops += 1;
            return seen.stops === 1
              ? { ok: false as const, why: "no answer" }
              : { ok: true as const, status: 429, body: {} };
          }),
      };
      const locks: NameLocks = makeKeyedLock<string>();
      const source = signedInSource(SERVER, {
        port,
        hosts: unregistered,
        owed: memoryOwedStops(),
        starting: new Set(),
        locks,
        stopRetryMs: 0,
        unansweredHoldMs: 1_000,
      });
      yield* Effect.forkScoped(source.abandon(NAME));
      while (seen.stops < 3) yield* Effect.sleep("5 millis");
      // A retry of the same spawn, right after the third stop was answered.
      yield* Effect.forkScoped(source.start({ name: NAME, orchestrator: "o", title: "Retry" }));
      yield* Effect.sleep("200 millis");
      // Still held for the first stop, which may yet delete what the retry would start.
      expect(log).toEqual(["stop", "stop", "stop"]);
    }).pipe(Effect.scoped),
  );

  it.live("hold a name after a give-back cancelled while its stop was on its way", () =>
    Effect.gen(function* () {
      const log: string[] = [];
      const answer = yield* Deferred.make<void>();
      const base = bridgeWorkerMachines(
        fakeApp({ answer: () => ({ status: 202, body: {} }) }).port,
      );
      // The stop is posted and waits; its answer, when it comes, is lost.
      const port: WorkerMachinePortShape = {
        ...base,
        call: (_origin, call) =>
          Effect.gen(function* () {
            log.push(call);
            if (call !== "stop") return { ok: true as const, status: 202, body: {} };
            yield* Deferred.await(answer);
            return { ok: false as const, why: "no answer" };
          }),
      };
      const source = signedInSource(SERVER, {
        port,
        hosts: unregistered,
        owed: memoryOwedStops(),
        starting: new Set(),
        locks: makeKeyedLock<string>(),
        stopRetryMs: 0,
        unansweredHoldMs: 1_000,
      });
      const giving = yield* Effect.forkScoped(source.abandon(NAME));
      while (!log.includes("stop")) yield* Effect.sleep("5 millis");
      // Its caller gives up as the stop is on its way, and a retry of the spawn comes at once.
      yield* Effect.forkScoped(Fiber.interrupt(giving));
      yield* Effect.sleep("20 millis");
      yield* Effect.forkScoped(source.start({ name: NAME, orchestrator: "o", title: "Retry" }));
      yield* Deferred.succeed(answer, undefined);
      yield* Effect.sleep("200 millis");
      // The stop may still land: the retry's start waits out its hold.
      expect(log.filter((each) => each === "start")).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live("hold a name across a restart after a stop no one answered", () =>
    Effect.gen(function* () {
      const log: string[] = [];
      const base = bridgeWorkerMachines(
        fakeApp({ answer: () => ({ status: 202, body: {} }) }).port,
      );
      // Every stop is posted and its answer lost; a start is answered.
      const port: WorkerMachinePortShape = {
        ...base,
        call: (_origin, call) =>
          Effect.sync(() => {
            log.push(call);
            return call === "stop"
              ? { ok: false as const, why: "no answer" }
              : { ok: true as const, status: 202, body: {} };
          }),
      };
      const dir = mkdtempSync(join(tmpdir(), "gram-held-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
      const before = signedInSource(SERVER, {
        port,
        hosts: unregistered,
        owed: fileOwedStops(dir),
        starting: new Set(),
        stopRetryMs: 0,
        unansweredHoldMs: 0,
      });
      yield* before.abandon(NAME);
      // This Gram restarts: nothing in memory, only what is on disk.
      const after = signedInSource(SERVER, {
        port,
        hosts: unregistered,
        owed: fileOwedStops(dir),
        starting: new Set(),
        locks: makeKeyedLock<string>(),
      });
      yield* Effect.forkScoped(after.start({ name: NAME, orchestrator: "o", title: "Retry" }));
      yield* Effect.sleep("200 millis");
      // The stops may still land: the retry's start waits out their hold.
      expect(log).toEqual(["stop", "stop", "stop"]);
    }).pipe(Effect.scoped),
  );

  it.live("hold a name for as long as the server may still act on a stop it took", () =>
    Effect.gen(function* () {
      const log: string[] = [];
      const base = bridgeWorkerMachines(
        fakeApp({ answer: () => ({ status: 202, body: {} }) }).port,
      );
      // Every stop is taken there and its answer lost; a start is answered.
      const port: WorkerMachinePortShape = {
        ...base,
        call: (_origin, call) =>
          Effect.sync(() => {
            log.push(call);
            return call === "stop"
              ? { ok: false as const, why: "no answer" }
              : { ok: true as const, status: 202, body: {} };
          }),
      };
      let clock = Date.now();
      const owed = memoryOwedStops(
        [],
        () => true,
        () => clock,
      );
      const deps = {
        port,
        hosts: unregistered,
        owed,
        starting: new Set<string>(),
        now: () => clock,
      };
      yield* signedInSource(SERVER, { ...deps, stopRetryMs: 0, unansweredHoldMs: 0 }).abandon(NAME);
      // Two minutes on, after a restart: the server's call down may still be waiting to act.
      clock += 2 * 60_000;
      const after = signedInSource(SERVER, { ...deps, locks: makeKeyedLock<string>() });
      yield* Effect.forkScoped(after.start({ name: NAME, orchestrator: "o", title: "Retry" }));
      yield* Effect.sleep("200 millis");
      expect(log).toEqual(["stop", "stop", "stop"]);
    }).pipe(Effect.scoped),
  );

  it.live(
    "keep a name through every attempt of a stop, so a retry's start never falls between them",
    () =>
      Effect.gen(function* () {
        const log: string[] = [];
        const seen = { stops: 0 };
        const base = bridgeWorkerMachines(
          fakeApp({ answer: () => ({ status: 200, body: {} }) }).port,
        );
        // The first stop fails on the way; the next goes through.
        const port: WorkerMachinePortShape = {
          ...base,
          call: (_origin, call) =>
            Effect.sync(() => {
              log.push(call);
              if (call === "stop") seen.stops += 1;
              return call === "stop" && seen.stops === 1
                ? { ok: true as const, status: 503, body: {} }
                : {
                    ok: true as const,
                    status: call === "start" ? 202 : 200,
                    body: { stopped: true },
                  };
            }),
        };
        const locks: NameLocks = makeKeyedLock<string>();
        const source = signedInSource(SERVER, {
          port,
          hosts: unregistered,
          owed: memoryOwedStops(),
          starting: new Set(),
          locks,
          stopRetryMs: 200,
        });
        const givingBack = yield* Effect.forkScoped(source.abandon(NAME));
        while (seen.stops === 0) yield* Effect.sleep("5 millis");
        // A retry of the same spawn, in the gap before the stop is tried again.
        yield* source.start({ name: NAME, orchestrator: "o", title: "Retry" });
        yield* Fiber.join(givingBack);
        expect(log).toEqual(["stop", "stop", "start"]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "give back, after a restart, a machine whose retry was refused once its stop failed",
    () =>
      Effect.gen(function* () {
        // The first start goes through with its answer lost; three stops are answered 503; the
        // retry is refused; after a restart the server stops it.
        let stops = 0;
        let starts = 0;
        const app = fakeApp({
          answer: ({ call }) => {
            if (call === "start") return { status: 403, body: {} };
            stops += 1;
            return stops <= 3
              ? { status: 503, body: {} }
              : { status: 200, body: { stopped: true } };
          },
        });
        const bridged = bridgeWorkerMachines(app.port);
        // The first start reaches the server, and its answer never comes back.
        const port: WorkerMachinePortShape = {
          ...bridged,
          call: (origin, call, body) =>
            call === "start" && (starts += 1) === 1
              ? Effect.succeed({ ok: false as const, why: "no answer" })
              : bridged.call(origin, call, body),
        };
        const dir = mkdtempSync(join(tmpdir(), "gram-owed-"));
        try {
          const source = signedInSource(SERVER, {
            port,
            hosts: unregistered,
            owed: fileOwedStops(dir),
            starting: new Set(),
            stopRetryMs: 0,
            unansweredHoldMs: 0,
          });
          const first = yield* source.start({ name: NAME, orchestrator: "o", title: "Heavy" });
          expect(first).toMatchObject({ kind: "refused", unknown: true });
          // Given back as a start of unknown outcome: its stops fail, so it is owed.
          yield* source.abandon(NAME, { unsettled: true });
          // A retry of its name is refused.
          expect(
            (yield* source.start({ name: NAME, orchestrator: "o", title: "Heavy" })).kind,
          ).toBe("refused");
          // Started again, with what was kept on disk, past the grace a start of unknown outcome has.
          const kept = fileOwedStops(dir);
          expect(kept.list().length).toBeGreaterThan(0);
          yield* settleOwedStops(
            port,
            kept,
            () => false,
            () => Date.now() + UNSETTLED_START_MS,
          );
          // Stopped there after the restart, each owing of the name settled: nothing left owed.
          expect(stops).toBeGreaterThan(3);
          expect(kept.list()).toEqual([]);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }),
  );

  it.live("admit no start past the most owed, however a settled stop and a start interleave", () =>
    Effect.gen(function* () {
      const answer = yield* Deferred.make<void>();
      const removed = yield* Deferred.make<void>();
      const app = fakeApp({
        answer: ({ call }) =>
          call === "start" ? { status: 202, body: {} } : { status: 200, body: { stopped: true } },
      });
      const bridged = bridgeWorkerMachines(app.port);
      const stop = { asked: false };
      const port: WorkerMachinePortShape = {
        ...bridged,
        call: (origin, call, body) =>
          call === "stop"
            ? Effect.sync(() => (stop.asked = true)).pipe(
                Effect.andThen(Deferred.await(answer)),
                Effect.andThen(bridged.call(origin, call, body)),
              )
            : bridged.call(origin, call, body),
      };
      const kept = memoryOwedStops();
      // Told the moment NAME's owing is let go, as another start could come in just then.
      const owed: typeof kept = {
        ...kept,
        remove: (name, attempt) => {
          kept.remove(name, attempt);
          if (name === NAME) Deferred.doneUnsafe(removed, Effect.void);
        },
      };
      // Full: NAME among them.
      for (let each = 0; each < OWED_MOST - 1; each += 1)
        owed.add({
          origin: ORIGIN,
          name: `worker-${each.toString(16).padStart(10, "0")}`,
          since: 0,
        });
      owed.add({ origin: ORIGIN, name: NAME, since: 0 });
      const locks = makeKeyedLock<string>();
      const source = signedInSource(SERVER, {
        port,
        hosts: unregistered,
        owed,
        starting: new Set(),
        locks,
      });
      // NAME's stop is settled; a retry of NAME waits for its name meanwhile.
      const settling = yield* Effect.forkScoped(
        settleOwedStops(port, owed, () => false, Date.now, locks),
      );
      while (!stop.asked) yield* Effect.sleep("1 millis");
      const retry = yield* Effect.forkScoped(
        source.start({ name: NAME, orchestrator: "o", title: "Retry" }),
      );
      yield* Effect.sleep("5 millis");
      // Another name's start comes the moment NAME's owing is let go, before the retry has it.
      const other = yield* Effect.forkScoped(
        Deferred.await(removed).pipe(
          Effect.andThen(
            source.start({ name: "worker-abcdefabcd", orchestrator: "o", title: "B" }),
          ),
        ),
      );
      yield* Deferred.succeed(answer, undefined);
      yield* Fiber.join(settling);
      yield* Fiber.join(retry);
      yield* Fiber.join(other);
      // However it went: never more owed than are kept, and every start sent is owed.
      expect(owed.list().length).toBeLessThanOrEqual(OWED_MOST);
      const owedNames = new Set(owed.list().map((each) => each.name));
      for (const sent of app.calls.filter((each) => each.call === "start"))
        expect(owedNames.has(sent.body["name"] as string)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("owe a machine its stop on each server that may hold it", () =>
    Effect.gen(function* () {
      const asked: Array<{ readonly origin: string; readonly call: string }> = [];
      const app = fakeApp({
        answer: ({ call }) =>
          call === "start" ? { status: 202, body: {} } : { status: 200, body: { stopped: true } },
      });
      const bridged = bridgeWorkerMachines(app.port);
      const port: WorkerMachinePortShape = {
        ...bridged,
        call: (origin, call, body) =>
          Effect.sync(() => asked.push({ origin, call })).pipe(
            Effect.andThen(bridged.call(origin, call, body)),
          ),
      };
      const owed = memoryOwedStops();
      // Owed its stop on the first server; the retry asks another.
      owed.add({ origin: ORIGIN, name: NAME, since: 0 });
      const other = { origin: "https://other.example.test", server: "Other hosted" };
      const source = signedInSource(other, {
        port,
        hosts: unregistered,
        owed,
        starting: new Set(),
      });
      expect((yield* source.start({ name: NAME, orchestrator: "o", title: "Retry" })).kind).toBe(
        "started",
      );
      // After a restart, each server is asked to stop its own.
      yield* settleOwedStops(port, owed, () => false);
      expect(
        asked
          .filter((each) => each.call === "stop")
          .map((each) => each.origin)
          .toSorted(),
      ).toEqual([ORIGIN, other.origin].toSorted());
    }),
  );

  it.effect("keep owing a retry whose start got no answer, past an older owing's grace", () =>
    Effect.gen(function* () {
      let started = false;
      const app = fakeApp({
        answer: () => ({ status: 200, body: { stopped: false } }),
      });
      const bridged = bridgeWorkerMachines(app.port);
      // The retry's start gets no answer: it may still reach the server.
      const port: WorkerMachinePortShape = {
        ...bridged,
        call: (origin, call, body) =>
          call === "start"
            ? Effect.sync(() => (started = true)).pipe(
                Effect.as({ ok: false as const, why: "no answer" }),
              )
            : bridged.call(origin, call, body),
      };
      const owed = memoryOwedStops();
      // An older owing of the name, one kept before attempt ids, long past any grace.
      owed.add({ origin: ORIGIN, name: NAME, since: 0 });
      const source = signedInSource(SERVER, {
        port,
        hosts: unregistered,
        owed,
        starting: new Set(),
      });
      yield* source.start({ name: NAME, orchestrator: "o", title: "Retry" });
      expect(started).toBe(true);
      // Restarted at once: the server knows no such machine yet, as the start may still come.
      yield* settleOwedStops(port, owed, () => false);
      expect(owed.list().map((each) => each.name)).toEqual([NAME]);
    }),
  );

  it.effect("send no start whose owing couldn't be written", () =>
    Effect.gen(function* () {
      const app = fakeApp({ answer: () => ({ status: 202, body: {} }) });
      const dir = mkdtempSync(join(tmpdir(), "gram-owed-"));
      try {
        const owed = fileOwedStops(dir);
        owed.add({ origin: ORIGIN, name: "worker-aaaaaaaaaa", since: 0 });
        // The folder can't be written now: a full or read-only disk.
        chmodSync(join(dir, "remote-access"), 0o500);
        const source = signedInSource(SERVER, {
          port: bridgeWorkerMachines(app.port),
          hosts: unregistered,
          owed,
          starting: new Set(),
        });
        const started = yield* source.start({ name: NAME, orchestrator: "o", title: "Heavy" });
        expect(started.kind).toBe("refused");
        expect(app.calls).toEqual([]);
        chmodSync(join(dir, "remote-access"), 0o700);
        // What was owed before is still there.
        expect(
          fileOwedStops(dir)
            .list()
            .map((each) => each.name),
        ).toEqual(["worker-aaaaaaaaaa"]);
      } finally {
        chmodSync(join(dir, "remote-access"), 0o700);
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("send no stop whose hold couldn't be written down, and owe it instead", () =>
    Effect.gen(function* () {
      const app = fakeApp({ answer: () => ({ status: 200, body: { stopped: true } }) });
      const dir = mkdtempSync(join(tmpdir(), "gram-owed-"));
      try {
        const owed = fileOwedStops(dir);
        owed.add({ origin: ORIGIN, name: "worker-aaaaaaaaaa", since: 0 });
        // The folder can't be written now: a full or read-only disk.
        chmodSync(join(dir, "remote-access"), 0o500);
        const port = bridgeWorkerMachines(app.port);
        const source = signedInSource(SERVER, { port, hosts: unregistered, owed, stopRetryMs: 0 });
        // Neither a give-back's stop nor an owed one goes out with no hold kept for it.
        yield* source.abandon(NAME);
        yield* settleOwedStops(port, owed);
        expect(app.calls).toEqual([]);
        expect(owed.list().map((each) => each.name)).toContain("worker-aaaaaaaaaa");
      } finally {
        chmodSync(join(dir, "remote-access"), 0o700);
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("give back nothing for a start cancelled before it was admitted", () =>
    Effect.gen(function* () {
      const app = fakeApp({ answer: () => ({ status: 503, body: {} }) });
      const owed = memoryOwedStops();
      // Owed on another server: nothing of this start's was written here, nor sent.
      owed.add({ origin: "https://other.example.test", name: NAME, since: 0 });
      const source = signedInSource(SERVER, {
        port: bridgeWorkerMachines(app.port),
        hosts: unregistered,
        owed,
        starting: new Set(),
        stopRetryMs: 0,
        unansweredHoldMs: 0,
      });
      yield* source.abandon(NAME, { unsettled: true });
      expect(app.calls).toEqual([]);
      expect(owed.list()).toHaveLength(1);
    }),
  );

  it.live("keep owing a start a server answered busy, then refused", () =>
    Effect.gen(function* () {
      const answers = [503, 429];
      const app = fakeApp({
        answer: ({ call }) =>
          call === "start"
            ? { status: answers.shift() ?? 403, body: { code: "unavailable" } }
            : { status: 200, body: {} },
      });
      const owed = memoryOwedStops();
      const source = signedInSource(SERVER, {
        port: bridgeWorkerMachines(app.port),
        hosts: unregistered,
        owed,
        starting: new Set(),
        startRetryMs: 1,
      });
      // The 503 may have reached its machines: the start's outcome isn't known.
      const started = yield* source.start({ name: NAME, orchestrator: "o", title: "Heavy" });
      expect(started).toMatchObject({ kind: "refused", unknown: true });
      expect(owed.list().map((each) => each.name)).toEqual([NAME]);
    }),
  );

  it.effect("keep owing a start a server answered with a 5xx it never asks again", () =>
    Effect.gen(function* () {
      // As a server answers a start that failed after its machine's record was written.
      const app = fakeApp({
        answer: ({ call }) =>
          call === "start"
            ? { status: 502, body: { code: "unavailable" } }
            : { status: 200, body: { stopped: false } },
      });
      const owed = memoryOwedStops();
      const source = signedInSource(SERVER, {
        port: bridgeWorkerMachines(app.port),
        hosts: unregistered,
        owed,
        starting: new Set(),
        stopRetryMs: 0,
      });
      const started = yield* source.start({ name: NAME, orchestrator: "o", title: "Heavy" });
      // Its machine may be there: given back as a start of unknown outcome, never let go of.
      expect(started).toMatchObject({ kind: "refused", unknown: true });
      expect(app.calls.map((each) => each.call)).toEqual(["start"]);
      expect(owed.list().map((each) => each.name)).toEqual([NAME]);
      // Given back, the server knows none yet: still owed, through the start's grace.
      yield* source.abandon(NAME, { unsettled: true });
      expect(owed.list().map((each) => each.name)).toEqual([NAME]);
    }),
  );

  it.live("keep owing a start first answered 503, however a later answer refuses it", () =>
    Effect.gen(function* () {
      for (const after of [
        // Released there, and its take-back answered not_found.
        { start: { status: 409, body: { code: "released" } }, release: 404 },
        // Over the person's total.
        { start: { status: 409, body: { code: "over_total" } }, release: 200 },
      ]) {
        const starts = [{ status: 503, body: { code: "unavailable" } }, after.start];
        const app = fakeApp({
          answer: ({ call }) =>
            call === "start"
              ? (starts.shift() ?? after.start)
              : { status: after.release, body: { code: "not_found" } },
        });
        const owed = memoryOwedStops();
        const source = signedInSource(SERVER, {
          port: bridgeWorkerMachines(app.port),
          hosts: unregistered,
          owed,
          starting: new Set(),
          startRetryMs: 1,
        });
        const started = yield* source.start({ name: NAME, orchestrator: "o", title: "Heavy" });
        // The 503 may have reached its machines: given back, and owed until a stop settles it.
        expect(started).toMatchObject({ kind: "refused", unknown: true });
        expect(owed.list().map((each) => each.name)).toEqual([NAME]);
      }
    }),
  );

  it.effect("take a server's rate limit as passing, and wake again later", () =>
    Effect.gen(function* () {
      const app = fakeApp({ answer: () => ({ status: 429, body: {} }) });
      expect(yield* wakeSignedIn(bridgeWorkerMachines(app.port), { name: NAME, via: ORIGIN })).toBe(
        "retry",
      );
    }),
  );

  it.effect("owe each start once, its failed give-back kept on its owing", () =>
    Effect.gen(function* () {
      // Its starts go through; its stops never do.
      const app = fakeApp({
        answer: ({ call }) => ({ status: call === "start" ? 202 : 503, body: {} }),
      });
      const owed = memoryOwedStops();
      const source = signedInSource(SERVER, {
        port: bridgeWorkerMachines(app.port),
        hosts: unregistered,
        owed,
        starting: new Set(),
        stopRetryMs: 0,
        unansweredHoldMs: 0,
      });
      for (let each = 0; each < 10; each += 1) {
        yield* source.start({ name: NAME, orchestrator: "o", title: "Again" });
        yield* source.abandon(NAME);
      }
      // One owing for each start, each its own attempt: no second for its give-back.
      expect(owed.list().map((each) => each.name)).toEqual(Array.from({ length: 10 }, () => NAME));
      expect(new Set(owed.list().map((each) => each.attempt)).size).toBe(10);
    }),
  );

  it.effect("start no machine there is no room to owe a stop for, and lose none on a restart", () =>
    Effect.gen(function* () {
      const app = fakeApp({ answer: () => ({ status: 202, body: {} }) });
      const dir = mkdtempSync(join(tmpdir(), "gram-owed-"));
      try {
        // Full: as many machines owed a stop as are kept, each a start of unknown outcome.
        const owed = fileOwedStops(dir);
        for (let each = 0; each < OWED_MOST; each += 1)
          owed.add({
            origin: ORIGIN,
            name: `worker-${each.toString(16).padStart(10, "0")}`,
            since: 0,
            unsettled: true,
            start: true,
            attempt: `00000000-0000-4000-8000-${each.toString(16).padStart(12, "0")}`,
          });
        const source = signedInSource(SERVER, {
          port: bridgeWorkerMachines(app.port),
          hosts: unregistered,
          owed,
          starting: new Set(),
        });
        // One more is refused, not started where nothing could give it back.
        const started = yield* source.start({ name: NAME, orchestrator: "o", title: "One more" });
        expect(started.kind).toBe("refused");
        expect(app.calls).toEqual([]);
        // Restarted: every machine owed a stop is still owed one.
        expect(fileOwedStops(dir).list()).toHaveLength(OWED_MOST);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("read back every owing past the most, and admit no start until they drain", () =>
    Effect.gen(function* () {
      const app = fakeApp({ answer: () => ({ status: 202, body: {} }) });
      const dir = mkdtempSync(join(tmpdir(), "gram-owed-"));
      try {
        const owed = fileOwedStops(dir);
        for (let each = 0; each < OWED_MOST + 20; each += 1)
          owed.add({
            origin: ORIGIN,
            name: `worker-${each.toString(16).padStart(10, "0")}`,
            since: 0,
            attempt: `00000000-0000-4000-8000-${each.toString(16).padStart(12, "0")}`,
          });
        const kept = fileOwedStops(dir);
        expect(kept.list()).toHaveLength(OWED_MOST + 20);
        const source = signedInSource(SERVER, {
          port: bridgeWorkerMachines(app.port),
          hosts: unregistered,
          owed: kept,
          starting: new Set(),
        });
        expect((yield* source.start({ name: NAME, orchestrator: "o", title: "More" })).kind).toBe(
          "refused",
        );
        expect(app.calls).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it("keep only the holds whose time is not up, however many passes asked again", () => {
    let clock = 1_700_000_000_000;
    const owed = memoryOwedStops(
      [],
      () => true,
      () => clock,
    );
    // Thirty-two machines owed a stop, asked every ten minutes while no stop is answered.
    for (let pass = 0; pass < 150; pass += 1) {
      for (let each = 0; each < 32; each += 1)
        owed.holds.hold(
          ORIGIN,
          `worker-${each.toString(16).padStart(10, "0")}`,
          stopHoldUntil(clock),
        );
      clock += 10 * 60_000;
    }
    // None of them can still act there by now: none is kept, and what is written stays small.
    expect(owed.heldList()).toHaveLength(0);
    owed.holds.hold(ORIGIN, NAME, stopHoldUntil(clock));
    expect(owed.heldList()).toHaveLength(1);
  });

  it("keep the owings of a file grown past its bound with holds long over, and shrink it", () => {
    const dir = mkdtempSync(join(tmpdir(), "gram-owed-"));
    try {
      // As the file was left before holds were pruned: two owings and thousands of old holds.
      const file = join(dir, "remote-access", "worker-machine-stops.json");
      mkdirSync(join(dir, "remote-access"), { mode: 0o700 });
      const holds = Array.from({ length: 8_000 }, (_, each) => ({
        id: `old-${each}`,
        origin: ORIGIN,
        name: NAME,
        until: 1,
      }));
      const owings = [NAME, "worker-aaaaaaaaaa"].map((name) => ({
        origin: ORIGIN,
        name,
        since: 1,
      }));
      writeFileSync(file, JSON.stringify({ version: 1, owed: owings, holds }), { mode: 0o600 });
      expect(statSync(file).size).toBeGreaterThan(STOPS_FILE_MOST);
      const owed = fileOwedStops(dir);
      // Read all the same: every stop still owed is kept.
      expect(owed.list().map((each) => each.name)).toEqual([NAME, "worker-aaaaaaaaaa"]);
      // Written back with only what still holds, well within what is read back.
      owed.remove("worker-aaaaaaaaaa");
      expect(statSync(file).size).toBeLessThan(STOPS_FILE_MOST);
      expect(
        fileOwedStops(dir)
          .list()
          .map((each) => each.name),
      ).toEqual([NAME]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("set aside a file it can't read, never write over it", () => {
    const dir = mkdtempSync(join(tmpdir(), "gram-owed-"));
    try {
      const file = join(dir, "remote-access", "worker-machine-stops.json");
      mkdirSync(join(dir, "remote-access"), { mode: 0o700 });
      writeFileSync(file, "{ not json", { mode: 0o600 });
      fileOwedStops(dir).add({ origin: ORIGIN, name: NAME, since: 1 });
      // What it held is kept beside the new one, for a person to read.
      const aside = readdirSync(join(dir, "remote-access")).filter((each) =>
        each.startsWith("worker-machine-stops.json.unreadable-"),
      );
      expect(aside).toHaveLength(1);
      expect(readFileSync(join(dir, "remote-access", aside[0]!), "utf8")).toBe("{ not json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("write no more than can be read back, so a restart keeps what was written", () => {
    const dir = mkdtempSync(join(tmpdir(), "gram-owed-"));
    try {
      // Owings with origins long enough that all of them would be past what is read back.
      const origin = `https://${"a".repeat(3_000)}.example.test`;
      const owed = fileOwedStops(dir);
      for (let each = 0; each < OWED_MOST; each += 1)
        owed.add({
          origin,
          name: `worker-${each.toString(16).padStart(10, "0")}`,
          since: 1_700_000_000_000,
          attempt: `00000000-0000-4000-8000-${each.toString(16).padStart(12, "0")}`,
        });
      // Each write that would go past it is refused; what was written last is still read.
      expect(fileOwedStops(dir).list().length).toBeGreaterThan(100);
      // And a stop whose hold can't be written down isn't sent.
      expect(owed.holds.hold(origin, NAME, stopHoldUntil(Date.now()))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keep every owing across a restart, a full list with long origins included", () => {
    const dir = mkdtempSync(join(tmpdir(), "gram-owed-"));
    try {
      const origin = `https://${"a".repeat(180)}.example.test`;
      const owed = fileOwedStops(dir);
      for (let each = 0; each < OWED_MOST; each += 1)
        owed.add({
          origin,
          name: `worker-${each.toString(16).padStart(10, "0")}`,
          since: 1_700_000_000_000,
          unsettled: true,
          start: true,
          attempt: `00000000-0000-4000-8000-${each.toString(16).padStart(12, "0")}`,
        });
      expect(fileOwedStops(dir).list()).toHaveLength(OWED_MOST);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const [refusal, answer] of [
    ["not allowed", { status: 403, body: {} }],
    ["over the total", { status: 409, body: { code: "over_total" } }],
  ] as const)
    it.effect(`keep an earlier stop owed when a retry of its name is refused as ${refusal}`, () =>
      Effect.gen(function* () {
        const app = fakeApp({
          answer: ({ call }) =>
            call === "start" ? answer : { status: 200, body: { stopped: true } },
        });
        const port = bridgeWorkerMachines(app.port);
        const owed = memoryOwedStops();
        // The first try's machine couldn't be stopped: owed, an older record with no attempt.
        owed.add({ origin: ORIGIN, name: NAME, since: 0 });
        const source = signedInSource(SERVER, {
          port,
          hosts: unregistered,
          owed,
          starting: new Set(),
        });
        // A retry of its name is refused: it made nothing, but the first machine is still there.
        expect(
          (yield* source.start({ name: NAME, orchestrator: "o", title: "Retry" })).kind,
        ).not.toBe("started");
        expect(owed.list()).toEqual([{ origin: ORIGIN, name: NAME, since: 0 }]);
        yield* settleOwedStops(port, owed, () => false);
        expect(app.calls.map((each) => each.call)).toEqual(["start", "stop"]);
        expect(owed.list()).toEqual([]);
      }),
    );

  it.live("keep a retry's start owed when an older stop of its name is settled meanwhile", () =>
    Effect.gen(function* () {
      // The older stop is answered late, saying the server holds no machine of that name.
      const answer = yield* Deferred.make<void>();
      const app = fakeApp({
        answer: ({ call }) =>
          call === "start" ? { status: 202, body: {} } : { status: 200, body: { stopped: false } },
      });
      const bridged = bridgeWorkerMachines(app.port);
      const stop = { asked: false };
      const port: WorkerMachinePortShape = {
        ...bridged,
        call: (origin, call, body) =>
          call === "stop"
            ? Effect.sync(() => (stop.asked = true)).pipe(
                Effect.andThen(Deferred.await(answer)),
                Effect.andThen(bridged.call(origin, call, body)),
              )
            : bridged.call(origin, call, body),
      };
      const owed = memoryOwedStops();
      const locks = makeKeyedLock<string>();
      const starting = new Set<string>();
      // An old debt of the name, past its grace: the pass holds the name and asks its stop.
      owed.add({ origin: ORIGIN, name: NAME, since: 0 });
      const settling = yield* Effect.forkScoped(
        settleOwedStops(port, owed, () => false, Date.now, locks),
      );
      while (!stop.asked) yield* Effect.sleep("1 millis");
      yield* Effect.sleep("5 millis");
      // A retry's start of the name waits for the name meanwhile.
      const source = signedInSource(SERVER, { port, hosts: unregistered, owed, starting, locks });
      const retrying = yield* Effect.forkScoped(
        source.start({ name: NAME, orchestrator: "o", title: "Retry" }),
      );
      yield* Effect.sleep("5 millis");
      yield* Deferred.succeed(answer, undefined);
      yield* Fiber.join(settling);
      expect((yield* Fiber.join(retrying)).kind).toBe("started");
      // The retry's own start is still owed, so a restart before it registers gives it back.
      expect(owed.list()).toEqual([
        {
          origin: ORIGIN,
          name: NAME,
          since: expect.any(Number),
          unsettled: true,
          start: true,
          attempt: expect.any(String),
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("give back a machine started just before this Gram stopped, once it is back", () =>
    Effect.gen(function* () {
      const app = fakeApp({
        answer: ({ call }) => ({ status: call === "start" ? 202 : 200, body: { stopped: true } }),
      });
      const port = bridgeWorkerMachines(app.port);
      const dir = mkdtempSync(join(tmpdir(), "gram-owed-"));
      try {
        // The start is sent, and this Gram stops before the machine is registered here.
        const source = signedInSource(SERVER, {
          port,
          hosts: unregistered,
          owed: fileOwedStops(dir),
          starting: new Set(),
        });
        expect((yield* source.start({ name: NAME, orchestrator: "o", title: "Heavy" })).kind).toBe(
          "started",
        );
        // Started again: nothing registered, no start on its way, what was kept on disk.
        const kept = fileOwedStops(dir);
        yield* settleOwedStops(port, kept, () => false);
        expect(app.calls.map((each) => each.call)).toEqual(["start", "stop"]);
        expect(kept.list()).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("never stop a machine a later start took the name of", () =>
    Effect.gen(function* () {
      // Its stops never go through; a start does.
      const app = fakeApp({
        answer: ({ call }) => ({ status: call === "start" ? 202 : 503, body: {} }),
      });
      const port = bridgeWorkerMachines(app.port);
      const owed = memoryOwedStops();
      const starting = new Set<string>();
      const source = signedInSource(SERVER, {
        port,
        hosts: unregistered,
        owed,
        starting,
        stopRetryMs: 0,
      });
      // The first try's machine couldn't be stopped: owed.
      yield* source.abandon(NAME);
      expect(owed.list().map((each) => each.name)).toEqual([NAME]);
      // A retry of the same spawn asks for the same name: the machine is its now. The old stop is
      // kept beside the start's own, both while the start is on its way, should it be refused.
      yield* source.start({ name: NAME, orchestrator: "o", title: "Retry" });
      expect(owed.list()).toEqual([
        { origin: ORIGIN, name: NAME, since: expect.any(Number), attempt: expect.any(String) },
        {
          origin: ORIGIN,
          name: NAME,
          since: expect.any(Number),
          unsettled: true,
          start: true,
          attempt: expect.any(String),
        },
      ]);
      const started = app.calls.length;
      yield* settleOwedStops(
        port,
        owed,
        (name) => starting.has(name),
        Date.now,
        undefined,
        (name) => starting.has(name),
      );
      expect(app.calls.slice(started)).toEqual([]);
      // Owed again, then claimed by a start on its way: settling stops nothing.
      owed.add({ origin: ORIGIN, name: NAME, since: 0 });
      const before = app.calls.length;
      yield* settleOwedStops(port, owed, (name) => starting.has(name));
      expect(app.calls.slice(before)).toEqual([]);
      expect(owed.list()).toEqual([]);
    }),
  );

  it.effect(
    "are owed for a machine never registered here, and settled once the server confirms",
    () =>
      Effect.gen(function* () {
        const hosts = {
          list: () => [],
          remove: () => false,
          machines: {
            provision: () => {
              throw new Error("not registered here");
            },
          },
        };
        let stopStatus = 503;
        const app = fakeApp({
          answer: ({ call }) => ({ status: call === "stop" ? stopStatus : 200, body: {} }),
        });
        const port = bridgeWorkerMachines(app.port);
        const owed = memoryOwedStops();
        const source = signedInSource(SERVER, { port, hosts, owed, stopRetryMs: 0 });
        yield* source.abandon(NAME);
        expect(owed.list()).toEqual([
          { origin: ORIGIN, name: NAME, since: expect.any(Number), attempt: expect.any(String) },
        ]);
        yield* settleOwedStops(port, owed);
        expect(owed.list()).toHaveLength(1);
        stopStatus = 200;
        yield* settleOwedStops(port, owed);
        expect(owed.list()).toEqual([]);
      }),
  );
});
