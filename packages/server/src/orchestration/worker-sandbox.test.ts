// The sandbox planner's machine bring-ups, single-flight by name, with a fake app answering for a
// hosted server: no network, and no machine is ever started.

import { describe, expect, it } from "@effect/vitest";
import { type ThreadId } from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { signedInSource, type WorkerMachinePortShape } from "../embedding/signed-in-workers.ts";
import { workerMachineName } from "../embedding/worker-machines.ts";
import { makeWorkerSandbox } from "./worker-sandbox.ts";

const SERVER = { origin: "https://hosted.example.test", server: "Example hosted" };
const CALLER = "t-orchestrator" as ThreadId;
const INPUT = {
  title: "Heavy build",
  feature: "heavy-build",
  project: "shop",
  clientRequestId: "heavy-1",
};
const NAME = workerMachineName(CALLER, INPUT.clientRequestId);
const SANDBOX = { own: true, reason: "A long build." };

/**
 * A planner over a fake hosted server whose machine is online here as soon as it is started, and
 * gone once stopped. `threads` and `stop` wait on what is given, as a slow read or call would.
 */
const setup = (gates: {
  readonly threads?: Effect.Effect<void>;
  readonly stop?: Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const calls: string[] = [];
    let online = false;
    const machine = {
      id: "m-0123456789abcdef01234567",
      name: NAME,
      onDemand: "worker",
      via: SERVER.origin,
      onlineSince: 1,
    };
    const port: WorkerMachinePortShape = {
      available: true,
      server: () => Effect.succeed({ ok: true as const, server: SERVER }),
      call: (_origin, call) =>
        Effect.gen(function* () {
          calls.push(call);
          if (call === "stop") yield* gates.stop ?? Effect.void;
          if (call === "start") online = true;
          if (call === "stop") online = false;
          const status = call === "start" ? 202 : call === "choices" ? 404 : 200;
          return { ok: true as const, status, body: {} };
        }),
      relay: () => undefined,
      unrelay: () => undefined,
      relays: () => undefined,
      onDial: () => undefined,
    };
    const hosts = {
      list: () => (online ? [machine] : []),
      remove: () => false,
      machines: {
        provision: () => {
          throw new Error("not registered here");
        },
      },
    };
    const source = signedInSource(SERVER, { port, hosts });
    const plan = yield* makeWorkerSandbox({
      orchestration: {} as never,
      store: {
        getThread: () => Effect.succeed({ checkout: { kind: "main", path: "/repo" } }),
        // No thread is placed on it yet: the first try's worker isn't stored.
        listThreads: (gates.threads ?? Effect.void).pipe(Effect.as([])),
      } as never,
      onDemand: undefined,
      signedIn: { port, source: Effect.succeed({ source, server: SERVER }) } as never,
      workerHosts: undefined,
      // Only the fields the planner reads of a joined machine.
      joined: () => hosts.list() as never,
    });
    return { plan, calls };
  });

/** A try's prepare in a scope of its own, which the test closes as that try ends. */
const prepared = (plan: Effect.Success<ReturnType<typeof setup>>["plan"]) =>
  Effect.gen(function* () {
    const planned = yield* plan(CALLER, INPUT, SANDBOX);
    const scope = yield* Scope.make();
    const ready =
      planned?.prepare === undefined ? {} : yield* planned.prepare.pipe(Scope.provide(scope));
    return { ready, scope };
  });

describe("a worker's machine brought up for a spawn", () => {
  it.effect("is held by a retry that comes once it is online, while the first still places", () =>
    Effect.gen(function* () {
      const { plan, calls } = yield* setup({});
      const first = yield* prepared(plan);
      // A retry of the same request, once the machine is online, while the first places its worker.
      const retry = yield* prepared(plan);
      // The first try is cancelled before its worker is stored: the retry still holds the machine.
      yield* first.ready.abandon ?? Effect.void;
      yield* Scope.close(first.scope, Exit.void);
      expect(calls).not.toContain("stop");
      yield* Scope.close(retry.scope, Exit.void);
    }).pipe(Effect.scoped),
  );

  for (const [during, gate] of [
    ["reads which threads are placed on it", "threads"],
    ["waits for its stop", "stop"],
  ] as const)
    it.effect(`keeps a retry out while a give-back that ${during} goes on`, () =>
      Effect.gen(function* () {
        const held = yield* Deferred.make<void>();
        const { plan, calls } = yield* setup({ [gate]: Deferred.await(held) });
        const first = yield* prepared(plan);
        // The first try is cancelled with no other try holding it: it gives its machine back.
        const giving = yield* Effect.forkScoped(first.ready.abandon ?? Effect.void);
        // Held in its stop: the stop is on its way before the retry comes.
        if (gate === "stop") while (!calls.includes("stop")) yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        // A retry of the same request comes meanwhile.
        const retrying = yield* Effect.forkScoped(prepared(plan));
        for (let each = 0; each < 20; each += 1) yield* Effect.yieldNow;
        expect(retrying.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(held, undefined);
        yield* Fiber.join(giving);
        yield* Scope.close(first.scope, Exit.void);
        const retry = yield* Fiber.join(retrying);
        // It never took the machine being stopped: it asked for one again, after the stop.
        expect(calls.lastIndexOf("start")).toBeGreaterThan(calls.indexOf("stop"));
        yield* Scope.close(retry.scope, Exit.void);
      }).pipe(Effect.scoped),
    );
});
