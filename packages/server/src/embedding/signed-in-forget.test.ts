// Forgetting a hosted worker machine's registration once nothing here needs it: what the release
// pass lets go, and the signed-in service's own check under the name's lock. A fake app and server
// over the port; no network, no real machine.

import { describe, expect, it } from "@effect/vitest";
import { type Checkout, HostId, type Thread, type ThreadId } from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
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
import { forgetReleased, type ReleaseMachine } from "./worker-machine-release.ts";

const on = (hostId: string) => ({ path: "/w", hostId: HostId.make(hostId) }) as unknown as Checkout;
const threadOn = (id: string, hostId: string, parked = true) =>
  ({ id: id as ThreadId, parked, checkout: on(hostId) }) as unknown as Thread;

const machine = (id: string, fields: Partial<ReleaseMachine> = {}): ReleaseMachine => ({
  id,
  name: `worker-${id.padStart(10, "0")}`,
  onDemand: "worker",
  via: ORIGIN,
  viaAccount: "a",
  joinedAt: 0,
  ...fields,
});
const run = (options: {
  machines: ReadonlyArray<ReleaseMachine>;
  threads: ReadonlyArray<Thread>;
  unknown?: ReadonlyArray<ThreadId>;
  plainWakes?: ReadonlyArray<ThreadId>;
  workerWakes?: ReadonlyArray<ThreadId>;
  busy?: ReadonlyArray<ThreadId>;
  notReleased?: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const forgot: string[] = [];
    const told = new Map(
      options.machines.map((each) => [
        each.id,
        { released: !(options.notReleased ?? []).includes(each.id), at: 0 },
      ]),
    );
    yield* forgetReleased(
      options.machines,
      told,
      new Set(options.workerWakes ?? []),
      {
        listThreadsForClaims: Effect.succeed({
          threads: options.threads,
          unknown: options.unknown ?? [],
        }),
        listThreadWakes: Effect.succeed(
          (options.plainWakes ?? []).map((threadId) => ({ threadId }) as never),
        ),
      },
      {
        summaryOf: (id) =>
          Effect.succeed({
            status: (options.busy ?? []).includes(id) ? "running" : "idle",
            queue: [],
            pendingRequests: [],
          } as never),
      },
      (id) => Effect.sync(() => (forgot.push(id), true)),
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

describe("the release pass lets a hosted machine go", () => {
  it.effect("only once every thread on it is archived, idle and has no wake pending", () =>
    Effect.gen(function* () {
      const forgot = yield* run({
        machines: [
          machine("1"),
          machine("2"),
          machine("3"),
          machine("4"),
          machine("5"),
          machine("6"),
          machine("7", { onlineSince: 1 }),
        ],
        threads: [
          threadOn("idle", "1"),
          threadOn("running", "2"),
          threadOn("plain-wake", "3"),
          threadOn("worker-wake", "4"),
          threadOn("not-archived", "5", false),
          threadOn("idle-too", "6"),
          threadOn("idle-online", "7"),
        ],
        busy: ["running" as ThreadId],
        plainWakes: ["plain-wake" as ThreadId],
        workerWakes: ["worker-wake" as ThreadId],
        notReleased: ["6"],
      });
      expect(forgot).toEqual(["1"]);
    }),
  );

  it.effect("none while a thread's row can't be read", () =>
    Effect.gen(function* () {
      const forgot = yield* run({
        machines: [machine("1")],
        threads: [threadOn("idle", "1")],
        unknown: ["unreadable" as ThreadId],
      });
      expect(forgot).toEqual([]);
    }),
  );
});

describe("a signed-in hosted machine's registration is forgotten", () => {
  it.live("once its server says it is stopped, and nothing is asked of it but its status", () =>
    Effect.gen(function* () {
      const { hosts, id, app, forget } = yield* live((call) =>
        call === "status" ? { status: 200, body: { phase: "stopped" } } : { status: 200, body: {} },
      );
      expect(yield* forget(id)).toBe(true);
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
        expect(yield* forget(id)).toBe(false);
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
          const asked = yield* Deferred.make<void>();
          const answer = yield* Deferred.make<void>();
          const base = bridgeWorkerMachines(
            fakeApp({ answer: () => ({ status: 200, body: { phase: "stopped" } }) }).port,
          );
          const port: WorkerMachinePortShape = {
            ...base,
            call: (origin, call, body, options) =>
              Deferred.succeed(asked, undefined).pipe(
                Effect.andThen(Deferred.await(answer)),
                Effect.andThen(base.call(origin, call, body, options)),
              ),
          };
          const sent = new Map<string, number>();
          const pass = yield* Effect.forkScoped(forgetStoppedSignedIn(port, hosts, { sent }, id));
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

  it.effect("never for one with a start on its way, or one kept from before sign-ins were", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      const app = fakeApp({ answer: () => ({ status: 200, body: { phase: "stopped" } }) });
      const port = bridgeWorkerMachines(app.port);
      const { id } = provisionRelayed(hosts, NAME);
      expect(yield* forgetStoppedSignedIn(port, hosts, { starting: new Set([NAME]) }, id)).toBe(
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
      expect(yield* forgetStoppedSignedIn(port, hosts, {}, legacy.machine.id)).toBe(false);
      expect(app.calls).toEqual([]);
      expect(hosts.list()).toHaveLength(2);
    }),
  );
});
