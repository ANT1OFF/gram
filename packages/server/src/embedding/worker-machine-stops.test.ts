// Stops a hosted server never confirmed, kept and asked again, and a start and a stop of one name
// that never overlap, with a fake app over the port: no network, no real machine.

import { describe, expect, it } from "@effect/vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
  type NameLocks,
  settleOwedStops,
  signedInSource,
  UNSETTLED_START_MS,
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
          answer: ({ call }) => ({ status: call === "stop" ? 404 : 200, body: {} }),
        });
        const port = bridgeWorkerMachines(app.port);
        const owed = memoryOwedStops();
        let clock = 1_000;
        const source = signedInSource(SERVER, {
          port,
          hosts: unregistered,
          owed,
          stopRetryMs: 0,
          now: () => clock,
        });
        yield* source.abandon(NAME, { unsettled: true });
        expect(owed.list()).toEqual([
          {
            origin: ORIGIN,
            name: NAME,
            since: 1_000,
            unsettled: true,
            attempt: expect.any(String),
          },
        ]);
        // Still within the time a start may take: the 404 settles nothing.
        yield* settleOwedStops(
          port,
          owed,
          () => false,
          () => clock + UNSETTLED_START_MS - 1,
        );
        expect(owed.list()).toHaveLength(1);
        clock += UNSETTLED_START_MS;
        yield* settleOwedStops(
          port,
          owed,
          () => false,
          () => clock,
        );
        expect(owed.list()).toEqual([]);
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
      const port = bridgeWorkerMachines(app.port);
      const owed = memoryOwedStops();
      const source = signedInSource(SERVER, {
        port,
        hosts: unregistered,
        owed,
        stopRetryMs: 0,
        now: () => 1_000,
      });
      yield* source.abandon(NAME, { unsettled: true });
      expect(owed.list()).toEqual([
        { origin: ORIGIN, name: NAME, since: 1_000, unsettled: true, attempt: expect.any(String) },
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
