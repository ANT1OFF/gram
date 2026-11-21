// The fences a desktop's late stop or release carries to a hosted server, through
// the port this Gram asks the app over: a fake app and server, no network, no real machine.

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { memoryMachineStore } from "../host/paired-machines.ts";
import { RemoteHosts } from "../host/remote-hosts.ts";
import { ACCOUNT, type Call, fakeApp, NAME, ORIGIN } from "./signed-in-fixtures.ts";
import {
  bridgeWorkerMachines,
  fencedCalls,
  memoryOwedStops,
  settleOwedStops,
  SignedInWorkers,
  SignedInWorkersLive,
  STOP_HOLD_MS,
  stopNotAfter,
  tellSignedInRelease,
  WorkerMachinePort,
} from "./signed-in-workers.ts";
import { RELEASE_REFUSED_WAIT_MS, releaseTeller } from "./worker-machine-release.ts";

/** The app over a server that answers each call in turn from `answers`, recording each. */
const appAnswering = (answers: Record<string, Array<{ status: number; body: unknown }>>) => {
  const app = fakeApp({
    answer: ({ call }) => answers[call]?.shift() ?? { status: 200, body: {} },
  });
  return { app, port: bridgeWorkerMachines(app.port) };
};

const bodiesOf = (calls: ReadonlyArray<Call>, call: string) =>
  calls.filter((each) => each.call === call).map((each) => each.body);

describe("a stop owed that its fence held back", () => {
  it.effect("is still owed, whether it came late or the name is another run now", () =>
    Effect.gen(function* () {
      for (const code of ["expired", "superseded"] as const) {
        const { app, port } = appAnswering({
          stop: [
            { status: 200, body: { stopped: false, code, message: "Nothing was done." } },
            { status: 200, body: { stopped: true } },
          ],
        });
        const owed = memoryOwedStops();
        owed.add({ origin: ORIGIN, name: NAME, since: 0, account: ACCOUNT });
        const now = 1_000_000;
        yield* settleOwedStops(
          port,
          owed,
          () => false,
          () => now,
        );
        // Nothing was done there, so it is owed still: never taken as no such machine.
        expect(
          owed.list().map((each) => each.name),
          code,
        ).toEqual([NAME]);
        // Sent with the latest time it may act, inside the hold its name is kept for.
        const [sent] = bodiesOf(app.calls, "stop");
        expect(sent?.["notAfter"]).toBe(stopNotAfter(now));
        expect(stopNotAfter(now)).toBeLessThan(now + STOP_HOLD_MS);
        // Asked again, and stopped: let go.
        yield* settleOwedStops(
          port,
          owed,
          () => false,
          () => now,
        );
        expect(owed.list(), code).toEqual([]);
      }
    }),
  );
});

describe("a stop or a release, as this Gram sends it", () => {
  it.effect("carries the run its name was last known to be, and that sign-in's alone", () =>
    Effect.gen(function* () {
      const { app, port: bare } = appAnswering({
        start: [{ status: 202, body: { name: NAME, sandboxId: "sbx_1", generation: 1 } }],
        stop: [{ status: 200, body: { stopped: false, code: "superseded" } }],
        status: [{ status: 200, body: { phase: "starting", sandboxId: "sbx_1", generation: 2 } }],
      });
      const port = fencedCalls(bare);
      const under = { account: ACCOUNT };
      yield* port.call(ORIGIN, "start", { name: NAME }, under);
      // Fenced to the run the start made.
      yield* port.call(ORIGIN, "stop", { name: NAME, notAfter: 5 }, under);
      // Another sign-in's call of the name knows no run of this one's.
      yield* port.call(ORIGIN, "stop", { name: NAME }, { account: "account-other-0123456789" });
      // Answered `superseded`: the run it held is no more, so the next goes by `notAfter` alone.
      yield* port.call(ORIGIN, "stop", { name: NAME, notAfter: 6 }, under);
      // A status names the run now: the release after it is fenced to that one.
      yield* port.call(ORIGIN, "status", { name: NAME }, under);
      yield* port.call(ORIGIN, "release", { name: NAME, released: true }, under);
      expect(bodiesOf(app.calls, "stop")).toEqual([
        { name: NAME, notAfter: 5, sandboxId: "sbx_1", generation: 1 },
        { name: NAME },
        { name: NAME, notAfter: 6 },
      ]);
      expect(bodiesOf(app.calls, "release")).toEqual([
        { name: NAME, released: true, sandboxId: "sbx_1", generation: 2 },
      ]);
    }),
  );

  it.live("is fenced so from the layer every source and the release pass ask through", () =>
    Effect.gen(function* () {
      const { app, port } = appAnswering({
        start: [{ status: 202, body: { name: NAME, sandboxId: "sbx_9", generation: 3 } }],
      });
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      const context = yield* Layer.build(
        SignedInWorkersLive.pipe(
          Layer.provide(Layer.succeed(WorkerMachinePort)(port)),
          Layer.provide(Layer.succeed(RemoteHosts)(hosts)),
        ),
      );
      yield* Effect.gen(function* () {
        const workers = yield* SignedInWorkers;
        yield* workers.port.call(ORIGIN, "start", { name: NAME }, { account: ACCOUNT });
        yield* workers.port.call(ORIGIN, "stop", { name: NAME }, { account: ACCOUNT });
      }).pipe(Effect.provide(context));
      expect(bodiesOf(app.calls, "stop")).toEqual([
        { name: NAME, sandboxId: "sbx_9", generation: 3 },
      ]);
    }).pipe(Effect.scoped),
  );
});

describe("a release the server's fence held back", () => {
  const machine = { name: NAME, via: ORIGIN, account: ACCOUNT };

  it.live("is asked again at once when it came late, and taken once it is applied", () =>
    Effect.gen(function* () {
      const { app, port } = appAnswering({
        release: [
          { status: 200, body: { known: true, applied: false, code: "expired" } },
          { status: 200, body: { known: true, released: true } },
        ],
      });
      expect(yield* tellSignedInRelease(port, machine, true, { retryMs: 1 })).toBe("applied");
      const sent = bodiesOf(app.calls, "release");
      expect(sent).toHaveLength(2);
      // Each with its own latest time, a minute or so from when it was asked.
      for (const body of sent) expect(body["notAfter"]).toBeGreaterThan(Date.now());
    }),
  );

  it.live("is not taken as told when the name is another run now", () =>
    Effect.gen(function* () {
      const { port } = appAnswering({
        release: [{ status: 200, body: { known: true, applied: false, code: "superseded" } }],
      });
      const told = yield* tellSignedInRelease(port, machine, true, { retryMs: 1 }).pipe(
        Effect.result,
      );
      // Told again next pass, decided afresh from what is at work then.
      expect(told._tag).toBe("Failure");
    }),
  );
});

describe("a release asked again", () => {
  const machine = { name: NAME, via: ORIGIN, account: ACCOUNT };

  it.live("carries the run it was decided for, and none once its name is a newer run", () =>
    Effect.gen(function* () {
      const busy = { status: 503, body: { code: "unavailable" } };
      const newer = { status: 200, body: { phase: "running", sandboxId: "sbx_1", generation: 2 } };
      const { app, port: bare } = appAnswering({
        start: [{ status: 202, body: { name: NAME, sandboxId: "sbx_1", generation: 1 } }],
        release: [busy, busy, busy],
        status: [newer, newer],
      });
      const port = fencedCalls(bare);
      yield* port.call(ORIGIN, "start", { name: NAME }, { account: ACCOUNT });
      const telling = yield* tellSignedInRelease(port, machine, true, { retryMs: 200 }).pipe(
        Effect.result,
        Effect.forkScoped,
      );
      while (bodiesOf(app.calls, "release").length === 0) yield* Effect.sleep(1);
      // While it waits to ask again, a status names a newer run of its name (a wake since).
      yield* port.call(ORIGIN, "status", { name: NAME }, { account: ACCOUNT });
      const told = yield* Fiber.join(telling);
      // Not told: the next pass decides it afresh, for the run its name is now.
      expect(told._tag).toBe("Failure");
      expect(
        bodiesOf(app.calls, "release").map((body) => [body["sandboxId"], body["generation"]]),
      ).toEqual([["sbx_1", 1]]);
      // Its status read again once it was held back.
      expect(app.calls.map((each) => each.call)).toEqual(["start", "release", "status", "status"]);
    }).pipe(Effect.scoped),
  );
});

describe("a release a server from before fences refuses as malformed", () => {
  it.effect("is never sent without its fences, and told again after a longer wait each time", () =>
    Effect.gen(function* () {
      const malformed = { status: 400, body: { code: "invalid_request" } };
      const { app, port } = appAnswering({
        release: [malformed, malformed, { status: 200, body: { known: true, released: true } }],
      });
      let now = 0;
      const tell = releaseTeller(undefined, fencedCalls(port), () => now)!;
      const relayed = {
        id: "m-1",
        name: NAME,
        onDemand: "worker",
        via: ORIGIN,
        viaAccount: ACCOUNT,
      };
      const told = () =>
        tell(relayed, true).pipe(
          Effect.result,
          Effect.map((result) => result._tag),
        );
      const sent = () => bodiesOf(app.calls, "release").length;
      expect(yield* told()).toBe("Failure");
      expect(sent()).toBe(1);
      // Not asked every pass: not told, so still to be told, but not sent until its wait is up.
      now += RELEASE_REFUSED_WAIT_MS - 1;
      expect(yield* told()).toBe("Failure");
      expect(sent()).toBe(1);
      now += 1;
      expect(yield* told()).toBe("Failure");
      expect(sent()).toBe(2);
      // Refused again: twice the wait.
      now += 2 * RELEASE_REFUSED_WAIT_MS - 1;
      expect(yield* told()).toBe("Failure");
      expect(sent()).toBe(2);
      now += 1;
      // The server since takes fences: told.
      expect(yield* told()).toBe("Success");
      for (const body of bodiesOf(app.calls, "release"))
        expect(typeof body["notAfter"]).toBe("number");
    }),
  );
});

describe("a stop that came after its time there", () => {
  it.effect("is logged, as a clock here behind the server's would have every one so", () =>
    Effect.gen(function* () {
      const lines: Array<string> = [];
      const logger = Logger.make(({ message }) => {
        lines.push(JSON.stringify(message));
      });
      const { port } = appAnswering({
        stop: [{ status: 200, body: { stopped: false, code: "expired" } }],
      });
      yield* fencedCalls(port)
        .call(ORIGIN, "stop", { name: NAME, notAfter: 1 }, { account: ACCOUNT })
        .pipe(Effect.provide(Logger.layer([logger])));
      expect(lines.some((line) => line.includes("clock may be behind"))).toBe(true);
    }),
  );
});
