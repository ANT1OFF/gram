// Stops a hosted server never confirmed, kept and asked again, and a start and a stop of one name
// that never overlap, with a fake app over the port: no network, no real machine.

import { describe, expect, it } from "@effect/vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
          { origin: ORIGIN, name: NAME, since: 1_000, unsettled: true },
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
      expect(owed.list()).toEqual([{ origin: ORIGIN, name: NAME, since: 1_000, unsettled: true }]);
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
      // gone; only the start's own is owed, kept while the start is on its way.
      yield* source.start({ name: NAME, orchestrator: "o", title: "Retry" });
      expect(owed.list()).toEqual([
        { origin: ORIGIN, name: NAME, since: expect.any(Number), unsettled: true, start: true },
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
        expect(owed.list()).toEqual([{ origin: ORIGIN, name: NAME, since: expect.any(Number) }]);
        yield* settleOwedStops(port, owed);
        expect(owed.list()).toHaveLength(1);
        stopStatus = 200;
        yield* settleOwedStops(port, owed);
        expect(owed.list()).toEqual([]);
      }),
  );
});
