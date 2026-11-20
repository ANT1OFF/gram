// The sandbox planner's machine bring-ups, single-flight by name, with a fake app answering for a
// hosted server: no network, and no machine is ever started.

import { describe, expect, it } from "@effect/vitest";
import { type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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

describe("a worker's machine brought up for a spawn", () => {
  it.effect("is held by a retry that comes once it is online, while the first still places", () =>
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
          Effect.sync(() => {
            calls.push(call);
            // Started there, and its host is online here at once.
            if (call === "start") online = true;
            return {
              ok: true as const,
              status: call === "start" ? 202 : call === "choices" ? 404 : 200,
              body: {},
            };
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
          listThreads: Effect.succeed([]),
        } as never,
        onDemand: undefined,
        signedIn: { port, source: Effect.succeed({ source, server: SERVER }) } as never,
        workerHosts: undefined,
        // Only the fields the planner reads of a joined machine.
        joined: () => hosts.list() as never,
      });
      const sandbox = { own: true, reason: "A long build." };
      const first = yield* plan(CALLER, INPUT, sandbox);
      const firstScope = yield* Scope.make();
      const firstPrepared = yield* first!.prepare!.pipe(Scope.provide(firstScope));
      // A retry of the same request, once the machine is online, while the first places its worker.
      const retry = yield* plan(CALLER, INPUT, sandbox);
      const retryScope = yield* Scope.make();
      if (retry?.prepare !== undefined) yield* retry.prepare.pipe(Scope.provide(retryScope));
      // The first try is cancelled before its worker is stored: the retry still holds the machine.
      yield* firstPrepared.abandon ?? Effect.void;
      yield* Scope.close(firstScope, Exit.void);
      expect(calls).not.toContain("stop");
      yield* Scope.close(retryScope, Exit.void);
    }).pipe(Effect.scoped),
  );
});
