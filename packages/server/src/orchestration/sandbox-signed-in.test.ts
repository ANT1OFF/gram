// `spawn_worker`'s `sandbox` in the desktop app, where the machine comes from a hosted server the
// app is signed in to (`embedding/signed-in-workers.ts`). A fake app answers for that server: no
// network, and no machine is ever started.

import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  NO_SIGNED_IN_SERVER,
  SignedInWorkers,
  signedInSource,
  type WorkerMachinePortShape,
} from "../embedding/signed-in-workers.ts";
import { AppToolError, DEFAULT_CHARTER, HostId, type Thread, type ThreadId } from "@gram/contracts";
import { makeKeyedLock } from "../git/keyed-lock.ts";
import { RemoteHosts, type RemoteHostsShape } from "../host/remote-hosts.ts";
import { makeStopMarks } from "../host/stop-marks.ts";
import { AppToolRegistry, bindAppTools } from "../app-tools/registry.ts";
import { workerMachineName } from "../embedding/worker-machines.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { Orchestration } from "./service.ts";
import { makeWorld, openOrchestrator, outboxOf, serverLayer, waitReal } from "./test-harness.ts";
import { UsageLimitReadings } from "../usage/limit-readings.ts";

const SERVER = { origin: "https://hosted.example.test", server: "Example hosted" };

const SANDBOX = {
  project: "shop",
  feature: "heavy-build",
  title: "Heavy build",
  brief: "Synthetic work",
  clientRequestId: "heavy-1",
  sandbox: { own: true, size: "large", reason: "A long build." },
};

/** A port to an app whose server answers each call with `answer`, recording what it was asked. */
const fakePort = (
  answer: (call: string) => { readonly status: number; readonly body: unknown },
) => {
  const calls: Array<{ readonly call: string; readonly body: unknown }> = [];
  const port: WorkerMachinePortShape = {
    available: true,
    server: () => Effect.succeed({ ok: true as const, server: SERVER }),
    call: (_origin, call, body) =>
      Effect.sync(() => {
        calls.push({ call, body });
        return { ok: true as const, ...answer(call) };
      }),
    relay: () => undefined,
    unrelay: () => undefined,
    relays: () => undefined,
    onDial: () => undefined,
    marks: () => Effect.succeed([]),
    onSignIns: () => undefined,
  };
  return { port, calls };
};

const signedIn = (service: SignedInWorkers["Service"]) => Layer.succeed(SignedInWorkers)(service);

/** One of the orchestrator's workers, placed on a machine: what makes it its own to share. */
const workerOn = (orchestrator: Thread, hostId: HostId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const { role: _role, ...rest } = orchestrator;
    yield* store.insertThread({
      ...rest,
      id: "t-on-its-machine" as ThreadId,
      spawnedBy: { threadId: orchestrator.id, feature: "earlier" },
      checkout: { ...orchestrator.checkout, hostId },
    });
  });

describe("sandbox from a signed-in hosted server", () => {
  it.effect(
    "is refused, naming the sign-in, while no server the app is signed in to offers it",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const { port } = fakePort(() => ({ status: 200, body: {} }));
        const context = yield* Layer.build(
          serverLayer(world).pipe(
            Layer.provide(
              signedIn({ port, source: Effect.succeed({ refused: NO_SIGNED_IN_SERVER }) }),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const store = yield* ThreadStore;
          const { session } = yield* openOrchestrator(world);
          const before = yield* store.listThreads;
          const result = yield* session.callTool("spawn_worker", SANDBOX).pipe(Effect.result);
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: {
              message: expect.stringMatching(
                /^Workers can't have machines of their own here: Sign in to a hosted server that offers worker machines \(Settings → Machines → Hosted servers\).*Leave out sandbox/,
              ),
            },
          });
          expect(yield* store.listThreads).toEqual(before);
        }).pipe(Effect.provide(context));
      }).pipe(Effect.scoped),
  );

  it.live("stops the machine it asked for when it never joins, and starts no worker", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      // The server starts it, and it never gets as far as making its key.
      const { port, calls } = fakePort((call) =>
        call === "choices"
          ? { status: 404, body: {} }
          : call === "status"
            ? { status: 200, body: { phase: "booting" } }
            : { status: 202, body: {} },
      );
      const hosts = {
        list: () => [],
        remove: () => false,
        machines: {
          provision: () => {
            throw new Error("not registered here");
          },
        },
      };
      const source = signedInSource(SERVER, { port, hosts, timeoutMs: 100, everyMs: 10 });
      const context = yield* Layer.build(
        serverLayer(world).pipe(
          Layer.provide(signedIn({ port, source: Effect.succeed({ source, server: SERVER }) })),
        ),
      );
      yield* Effect.gen(function* () {
        const store = yield* ThreadStore;
        const { session } = yield* openOrchestrator(world);
        const before = yield* store.listThreads;
        const result = yield* session.callTool("spawn_worker", SANDBOX).pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            message: expect.stringMatching(
              /^The machine worker-[a-z0-9]+ didn't join within \d+ minutes, so it was stopped/,
            ),
          },
        });
        const asked = calls.map((each) => each.call);
        expect(asked[0]).toBe("choices");
        expect(asked).toContain("start");
        expect(asked.at(-1)).toBe("stop");
        const started = calls.find((each) => each.call === "start")!.body as { name: string };
        expect(calls.at(-1)!.body).toEqual({ name: started.name, notAfter: expect.any(Number) });
        expect(yield* store.listThreads).toEqual(before);
        expect(existsSync(join(world.repo, ".worktrees"))).toBe(false);
      }).pipe(Effect.provide(context));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "refuses a model the server's machines don't run, before any machine is asked for",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const { port, calls } = fakePort((call) =>
          call === "choices"
            ? {
                status: 200,
                body: {
                  choices: [],
                  models: [{ agent: "claude", id: "hosted-only", label: "Hosted" }],
                },
              }
            : { status: 202, body: {} },
        );
        const hosts = {
          list: () => [],
          remove: () => false,
          machines: {
            provision: () => {
              throw new Error("not registered here");
            },
          },
        };
        const source = signedInSource(SERVER, { port, hosts });
        const context = yield* Layer.build(
          serverLayer(world).pipe(
            Layer.provide(signedIn({ port, source: Effect.succeed({ source, server: SERVER }) })),
          ),
        );
        yield* Effect.gen(function* () {
          const { session } = yield* openOrchestrator(world);
          const result = yield* session.callTool("spawn_worker", SANDBOX).pipe(Effect.result);
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: {
              message: expect.stringMatching(
                /^Example hosted's worker machines don't run \S+, so no machine was asked for\. They run claude:hosted-only \(Hosted\)/,
              ),
            },
          });
          expect(calls.map((each) => each.call)).toEqual(["choices"]);
        }).pipe(Effect.provide(context));
      }).pipe(Effect.scoped),
  );

  it.live("gives back a machine that came when the spawn is then refused", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      let started = false;
      const { port, calls } = fakePort((call) => {
        if (call === "start") started = true;
        return call === "choices" ? { status: 404, body: {} } : { status: 202, body: {} };
      });
      // It comes online as soon as it is asked for; this Gram's own machines don't know it, so
      // the placement after it is refused.
      const machine = {
        id: "m-0123456789abcdef01234567",
        name: "",
        onDemand: "worker",
        via: SERVER.origin,
        onlineSince: 1,
      };
      const hosts = {
        list: () => (started ? [machine] : []),
        remove: () => true,
        machines: {
          provision: () => {
            throw new Error("not registered here");
          },
        },
      };
      const source = signedInSource(SERVER, { port, hosts, timeoutMs: 1_000, everyMs: 10 });
      const context = yield* Layer.build(
        serverLayer(world).pipe(
          Layer.provide(
            signedIn({
              port,
              source: Effect.succeed({
                source: {
                  ...source,
                  start: (ask) => {
                    machine.name = ask.name;
                    return source.start(ask);
                  },
                },
                server: SERVER,
              }),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const { session } = yield* openOrchestrator(world);
        const result = yield* session.callTool("spawn_worker", SANDBOX).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(calls.map((each) => each.call)).toEqual(["choices", "start", "stop"]);
        expect(calls.at(-1)!.body).toEqual({ name: machine.name, notAfter: expect.any(Number) });
      }).pipe(Effect.provide(context));
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a named model its machine doesn't run rather than run another", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { port } = fakePort((call) =>
        call === "choices" ? { status: 404, body: {} } : { status: 200, body: {} },
      );
      // A worker machine from the server, online, whose Claude Code lists only fake-haiku.
      const machine = {
        id: HostId.make("m-0123456789abcdef01234567"),
        name: "worker-0123456789",
        confirmed: true,
        onDemand: "worker",
        via: SERVER.origin,
        onlineSince: 1,
        models: [{ id: "fake-haiku", displayName: "Fake Haiku", supportsEffort: false }],
      };
      const remote = Layer.succeed(RemoteHosts, {
        machines: { list: () => [], get: () => undefined },
        stops: makeStopMarks(),
        watch: () => () => undefined,
        list: () => [machine],
      } as unknown as RemoteHostsShape);
      const hosts = {
        list: () => [machine],
        remove: () => false,
        machines: {
          provision: () => {
            throw new Error("not registered here");
          },
        },
      };
      const source = signedInSource(SERVER, { port, hosts });
      const context = yield* Layer.build(
        serverLayer(world).pipe(
          Layer.provide(remote),
          Layer.provide(signedIn({ port, source: Effect.succeed({ source, server: SERVER }) })),
        ),
      );
      yield* Effect.gen(function* () {
        const { session, workspaceId, thread } = yield* openOrchestrator(world);
        yield* workerOn(thread, machine.id);
        yield* (yield* Orchestration).setCharter(workspaceId, {
          ...DEFAULT_CHARTER,
          autonomy: "publish",
          workerModels: [
            { agent: "claude", model: "fake-opus" },
            { agent: "claude", model: "fake-haiku" },
          ],
        });
        const result = yield* session
          .callTool("spawn_worker", {
            ...SANDBOX,
            model: "claude:fake-opus",
            sandbox: { shareWith: machine.name, reason: "Same build." },
          })
          .pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            message: expect.stringMatching(
              /fake-opus can't run there \(.*doesn't list fake-opus.*\), so no worker is spawned/,
            ),
          },
        });
      }).pipe(Effect.provide(context));
    }).pipe(Effect.scoped),
  );

  it.effect("starts no machine for a spawn whose approval is denied", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { port, calls } = fakePort((call) =>
        call === "choices" ? { status: 404, body: {} } : { status: 202, body: {} },
      );
      const hosts = {
        list: () => [],
        remove: () => false,
        machines: {
          provision: () => {
            throw new Error("not registered here");
          },
        },
      };
      const source = signedInSource(SERVER, { port, hosts });
      const context = yield* Layer.build(
        serverLayer(world).pipe(
          Layer.provide(signedIn({ port, source: Effect.succeed({ source, server: SERVER }) })),
        ),
      );
      yield* Effect.gen(function* () {
        const { thread } = yield* openOrchestrator(world);
        const registry = yield* AppToolRegistry;
        const gated = bindAppTools(
          registry.definitions.map((definition) =>
            definition.descriptor.name === "spawn_worker"
              ? { ...definition, alwaysAsks: true }
              : definition,
          ),
          thread.id,
          {
            approve: () =>
              Effect.fail(new AppToolError({ tool: "spawn_worker", message: "The user said no." })),
          },
        ).find((tool) => tool.descriptor.name === "spawn_worker")!;
        const result = yield* gated.run(SANDBOX).pipe(Effect.result);
        expect(result).toMatchObject({ _tag: "Failure" });
        // The choices were read for the card; nothing was started.
        expect(calls.map((each) => each.call)).toEqual(["choices"]);
      }).pipe(Effect.provide(context));
    }).pipe(Effect.scoped),
  );

  it.effect("stops a machine whose start got no answer", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const calls: Array<{ readonly call: string; readonly body: unknown }> = [];
      const { port } = fakePort(() => ({ status: 200, body: {} }));
      const lost: WorkerMachinePortShape = {
        ...port,
        call: (_origin, call, body) =>
          Effect.sync(() => {
            calls.push({ call, body });
            return call === "start"
              ? { ok: false as const, why: "The desktop app didn't answer." }
              : call === "choices"
                ? { ok: true as const, status: 404, body: {} }
                : { ok: true as const, status: 200, body: {} };
          }),
      };
      const hosts = {
        list: () => [],
        remove: () => false,
        machines: {
          provision: () => {
            throw new Error("not registered here");
          },
        },
      };
      const source = signedInSource(SERVER, { port: lost, hosts });
      const context = yield* Layer.build(
        serverLayer(world).pipe(
          Layer.provide(
            signedIn({ port: lost, source: Effect.succeed({ source, server: SERVER }) }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const { session } = yield* openOrchestrator(world);
        const result = yield* session.callTool("spawn_worker", SANDBOX).pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            message: expect.stringMatching(/couldn't be asked for: The desktop app didn't answer/),
          },
        });
        expect(calls.map((each) => each.call)).toEqual(["choices", "start", "stop"]);
      }).pipe(Effect.provide(context));
    }).pipe(Effect.scoped),
  );

  it.live("stops a machine whose spawn is stopped while its start is on its way", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const calls: Array<{ readonly call: string; readonly body: unknown }> = [];
      const { port } = fakePort(() => ({ status: 200, body: {} }));
      // The app has sent the start; its answer never comes back before the spawn is stopped.
      const slow: WorkerMachinePortShape = {
        ...port,
        call: (_origin, call, body) =>
          Effect.suspend(() => {
            calls.push({ call, body });
            return call === "start"
              ? Effect.never
              : call === "choices"
                ? Effect.succeed({ ok: true as const, status: 404, body: {} })
                : Effect.succeed({ ok: true as const, status: 200, body: {} });
          }),
      };
      const hosts = {
        list: () => [],
        remove: () => false,
        machines: {
          provision: () => {
            throw new Error("not registered here");
          },
        },
      };
      const source = signedInSource(SERVER, { port: slow, hosts });
      const context = yield* Layer.build(
        serverLayer(world).pipe(
          Layer.provide(
            signedIn({ port: slow, source: Effect.succeed({ source, server: SERVER }) }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const { session } = yield* openOrchestrator(world);
        const spawning = yield* Effect.forkScoped(session.callTool("spawn_worker", SANDBOX));
        while (!calls.some((each) => each.call === "start")) yield* Effect.sleep("10 millis");
        yield* Fiber.interrupt(spawning);
        expect(calls.map((each) => each.call)).toEqual(["choices", "start", "stop"]);
      }).pipe(Effect.provide(context));
    }).pipe(Effect.scoped),
  );

  it.live("a cancelled retry of the same request stops nothing the first try started", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const calls: Array<{ readonly call: string; readonly body: unknown }> = [];
      const { port } = fakePort(() => ({ status: 200, body: {} }));
      // The first try's start is on its way; its answer, a machine started, comes when told.
      const answer = yield* Deferred.make<void>();
      const slow: WorkerMachinePortShape = {
        ...port,
        call: (_origin, call, body) =>
          Effect.suspend(() => {
            calls.push({ call, body });
            return call === "start"
              ? Deferred.await(answer).pipe(
                  Effect.as({ ok: true as const, status: 202, body: { phase: "starting" } }),
                )
              : call === "choices"
                ? Effect.succeed({ ok: true as const, status: 404, body: {} })
                : Effect.succeed({ ok: true as const, status: 200, body: { phase: "starting" } });
          }),
      };
      const hosts = {
        list: () => [],
        remove: () => false,
        machines: {
          provision: () => {
            throw new Error("not registered here");
          },
        },
      };
      // The name's lock, as the app shares it: a second start of the name waits for the first.
      const source = signedInSource(SERVER, {
        port: slow,
        hosts,
        locks: makeKeyedLock<string>(),
        everyMs: 10,
      });
      const context = yield* Layer.build(
        serverLayer(world).pipe(
          Layer.provide(
            signedIn({ port: slow, source: Effect.succeed({ source, server: SERVER }) }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const { session } = yield* openOrchestrator(world);
        const first = yield* Effect.forkScoped(session.callTool("spawn_worker", SANDBOX));
        while (!calls.some((each) => each.call === "start")) yield* Effect.sleep("10 millis");
        // A retry of the same request (a reconnect, a tool call tried again) while it is at work.
        const retry = yield* Effect.forkScoped(session.callTool("spawn_worker", SANDBOX));
        yield* Effect.sleep("100 millis");
        const cancelled = yield* Effect.forkScoped(Fiber.interrupt(retry));
        yield* Effect.sleep("50 millis");
        // The server takes the first try's start: the machine is the first try's.
        yield* Deferred.succeed(answer, undefined);
        yield* Fiber.join(cancelled);
        yield* Effect.sleep("100 millis");
        expect(calls.map((each) => each.call)).not.toContain("stop");
        expect(calls.filter((each) => each.call === "start")).toHaveLength(1);
        yield* Fiber.interrupt(first);
      }).pipe(Effect.provide(context));
    }).pipe(Effect.scoped),
  );

  it.live("a cancelled first try stops nothing a retry of the same request still waits for", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const calls: Array<{ readonly call: string; readonly body: unknown }> = [];
      const { port } = fakePort(() => ({ status: 200, body: {} }));
      // Started there at once, and starting for as long as the tries wait.
      const answering: WorkerMachinePortShape = {
        ...port,
        call: (_origin, call, body) =>
          Effect.sync(() => {
            calls.push({ call, body });
            return call === "start"
              ? { ok: true as const, status: 202, body: { name: "x" } }
              : call === "choices"
                ? { ok: true as const, status: 404, body: {} }
                : { ok: true as const, status: 200, body: { phase: "starting" } };
          }),
      };
      const hosts = {
        list: () => [],
        remove: () => false,
        machines: {
          provision: () => {
            throw new Error("not registered here");
          },
        },
      };
      const source = signedInSource(SERVER, {
        port: answering,
        hosts,
        locks: makeKeyedLock<string>(),
        everyMs: 10,
      });
      const context = yield* Layer.build(
        serverLayer(world).pipe(
          Layer.provide(
            signedIn({ port: answering, source: Effect.succeed({ source, server: SERVER }) }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const { session } = yield* openOrchestrator(world);
        const first = yield* Effect.forkScoped(session.callTool("spawn_worker", SANDBOX));
        while (!calls.some((each) => each.call === "status")) yield* Effect.sleep("10 millis");
        // A retry of the same request while the first waits for its machine.
        const retry = yield* Effect.forkScoped(session.callTool("spawn_worker", SANDBOX));
        yield* Effect.sleep("100 millis");
        // The first try is cancelled: the retry still wants the machine.
        yield* Fiber.interrupt(first);
        yield* Effect.sleep("100 millis");
        expect(calls.map((each) => each.call)).not.toContain("stop");
        expect(calls.filter((each) => each.call === "start")).toHaveLength(1);
        // Once no try holds it, what was started is given back.
        yield* Fiber.interrupt(retry);
        while (!calls.some((each) => each.call === "stop")) yield* Effect.sleep("10 millis");
      }).pipe(Effect.provide(context));
    }).pipe(Effect.scoped),
  );

  it.effect("lets go of a held brief whose machine it gave back, and says to spawn again", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      let started = false;
      const { port, calls } = fakePort((call) => {
        if (call === "start") started = true;
        return call === "choices" ? { status: 404, body: {} } : { status: 202, body: {} };
      });
      // It comes online as soon as it is asked for, here and in this Gram's machines.
      const machine = {
        id: HostId.make("m-0123456789abcdef01234567"),
        name: "",
        confirmed: true,
        onDemand: "worker",
        via: SERVER.origin,
        onlineSince: 1,
      };
      const listed = () => (started ? [machine] : []);
      const remote = Layer.succeed(RemoteHosts, {
        machines: { list: () => [], get: () => undefined },
        stops: makeStopMarks(),
        watch: () => () => undefined,
        list: listed,
      } as unknown as RemoteHostsShape);
      const hosts = {
        list: listed,
        remove: () => true,
        machines: {
          provision: () => {
            throw new Error("not registered here");
          },
        },
      };
      const base = signedInSource(SERVER, { port, hosts });
      const source = {
        ...base,
        start: (ask: Parameters<typeof base.start>[0]) => {
          machine.name = ask.name;
          return base.start(ask);
        },
      };
      const context = yield* Layer.build(
        serverLayer(world).pipe(
          Layer.provide(remote),
          Layer.provide(signedIn({ port, source: Effect.succeed({ source, server: SERVER }) })),
        ),
      );
      yield* Effect.gen(function* () {
        const readings = yield* UsageLimitReadings;
        const { session, workspaceId } = yield* openOrchestrator(world);
        // A real refusal on the agent: a low-priority brief is held until it resets.
        yield* session.emit({
          type: "rateLimit",
          status: "rejected",
          window: "five_hour",
          resetsAt: (yield* Clock.currentTimeMillis) + 3_600_000,
        });
        yield* waitReal(
          "the refusal",
          readings.current.pipe(
            Effect.map((all) => all.some((each) => each.status === "rejected")),
          ),
        );
        const result = yield* session
          .callTool("spawn_worker", { ...SANDBOX, priority: "low" })
          .pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            message: expect.stringMatching(
              /A worker on a machine from a hosted server isn't held.*Its machine was given back\. Nothing is kept\./,
            ),
          },
        });
        expect(calls.map((each) => each.call)).toEqual(["choices", "start", "stop"]);
        expect((yield* outboxOf(workspaceId)).heldBriefs ?? []).toEqual([]);
      }).pipe(Effect.provide(context));
    }).pipe(Effect.scoped),
  );

  it.effect("lets go of a held brief for a shared machine, which stays for its other work", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { port, calls } = fakePort(() => ({ status: 404, body: {} }));
      const machine = {
        id: HostId.make("m-0123456789abcdef01234567"),
        name: "worker-0123456789",
        confirmed: true,
        onDemand: "worker",
        via: SERVER.origin,
        onlineSince: 1,
      };
      const remote = Layer.succeed(RemoteHosts, {
        machines: { list: () => [], get: () => undefined },
        stops: makeStopMarks(),
        watch: () => () => undefined,
        list: () => [machine],
      } as unknown as RemoteHostsShape);
      const hosts = {
        list: () => [machine],
        remove: () => true,
        machines: {
          provision: () => {
            throw new Error("not registered here");
          },
        },
      };
      const source = signedInSource(SERVER, { port, hosts });
      const context = yield* Layer.build(
        serverLayer(world).pipe(
          Layer.provide(remote),
          Layer.provide(signedIn({ port, source: Effect.succeed({ source, server: SERVER }) })),
        ),
      );
      yield* Effect.gen(function* () {
        const readings = yield* UsageLimitReadings;
        const { session, workspaceId, thread } = yield* openOrchestrator(world);
        yield* workerOn(thread, machine.id);
        yield* session.emit({
          type: "rateLimit",
          status: "rejected",
          window: "five_hour",
          resetsAt: (yield* Clock.currentTimeMillis) + 3_600_000,
        });
        yield* waitReal(
          "the refusal",
          readings.current.pipe(
            Effect.map((all) => all.some((each) => each.status === "rejected")),
          ),
        );
        const result = yield* session
          .callTool("spawn_worker", {
            ...SANDBOX,
            priority: "low",
            sandbox: { shareWith: machine.name, reason: "Same build." },
          })
          .pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            message: expect.stringMatching(
              /shared with your other workers and stays\. Nothing is kept\./,
            ),
          },
        });
        expect(calls.map((each) => each.call)).not.toContain("stop");
        expect((yield* outboxOf(workspaceId)).heldBriefs ?? []).toEqual([]);
      }).pipe(Effect.provide(context));
    }).pipe(Effect.scoped),
  );

  it.live(
    "never stops a machine an earlier spawn of the same id left registered, however long it stays offline",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const { port, calls } = fakePort((call) =>
          call === "choices" ? { status: 404, body: {} } : { status: 200, body: {} },
        );
        const machine = {
          id: HostId.make("m-0123456789abcdef01234567"),
          name: "",
          confirmed: true,
          onDemand: "worker",
          via: SERVER.origin,
        };
        const remote = Layer.succeed(RemoteHosts, {
          machines: { list: () => [], get: () => undefined },
          stops: makeStopMarks(),
          watch: () => () => undefined,
          list: () => [machine],
        } as unknown as RemoteHostsShape);
        const hosts = {
          list: () => [machine],
          remove: () => true,
          machines: {
            provision: () => {
              throw new Error("not registered here");
            },
          },
        };
        const source = signedInSource(SERVER, { port, hosts, timeoutMs: 100, everyMs: 10 });
        const context = yield* Layer.build(
          serverLayer(world).pipe(
            Layer.provide(remote),
            Layer.provide(signedIn({ port, source: Effect.succeed({ source, server: SERVER }) })),
          ),
        );
        yield* Effect.gen(function* () {
          const { session, thread } = yield* openOrchestrator(world);
          // The machine the first try of this spawn made: registered here, its disk holding that
          // try's work, offline now.
          machine.name = workerMachineName(thread.id, SANDBOX.clientRequestId);
          const result = yield* session.callTool("spawn_worker", SANDBOX).pipe(Effect.result);
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { message: expect.stringMatching(/left as it is/) },
          });
          expect(calls.map((each) => each.call)).not.toContain("stop");
          expect(calls.map((each) => each.call)).not.toContain("start");
        }).pipe(Effect.provide(context));
      }).pipe(Effect.scoped),
  );

  it.live("gives back no machine a thread is placed on, when the spawn fails after it came", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      let started = false;
      const { port, calls } = fakePort((call) => {
        if (call === "start") started = true;
        return call === "choices" ? { status: 404, body: {} } : { status: 202, body: {} };
      });
      const machine = {
        id: HostId.make("m-0123456789abcdef01234567"),
        name: "",
        onDemand: "worker",
        via: SERVER.origin,
        onlineSince: 1,
      };
      const hosts = {
        list: () => (started ? [machine] : []),
        remove: () => true,
        machines: {
          provision: () => {
            throw new Error("not registered here");
          },
        },
      };
      const base = signedInSource(SERVER, { port, hosts, timeoutMs: 1_000, everyMs: 10 });
      const source = {
        ...base,
        start: (ask: Parameters<typeof base.start>[0]) => {
          machine.name = ask.name;
          return base.start(ask);
        },
      };
      const context = yield* Layer.build(
        serverLayer(world).pipe(
          Layer.provide(signedIn({ port, source: Effect.succeed({ source, server: SERVER }) })),
        ),
      );
      yield* Effect.gen(function* () {
        const store = yield* ThreadStore;
        const { session, thread } = yield* openOrchestrator(world);
        // A worker of this spawn's already runs there: the spawn's own, made before it failed.
        yield* store.insertThread({
          ...thread,
          id: "t-placed-there" as typeof thread.id,
          checkout: { ...thread.checkout, hostId: machine.id },
        } as typeof thread);
        const result = yield* session.callTool("spawn_worker", SANDBOX).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(calls.map((each) => each.call)).toEqual(["choices", "start"]);
      }).pipe(Effect.provide(context));
    }).pipe(Effect.scoped),
  );

  it.effect("refuses, once and in words, a name the server says a reclaimed machine had", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { port, calls } = fakePort((call) =>
        call === "choices"
          ? { status: 404, body: {} }
          : call === "start"
            ? { status: 409, body: { code: "name_in_use", message: "That name was used." } }
            : { status: 200, body: {} },
      );
      const hosts = {
        list: () => [],
        remove: () => false,
        machines: {
          provision: () => {
            throw new Error("not registered here");
          },
        },
      };
      const source = signedInSource(SERVER, { port, hosts });
      const context = yield* Layer.build(
        serverLayer(world).pipe(
          Layer.provide(signedIn({ port, source: Effect.succeed({ source, server: SERVER }) })),
        ),
      );
      yield* Effect.gen(function* () {
        const { session } = yield* openOrchestrator(world);
        const result = yield* session.callTool("spawn_worker", SANDBOX).pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { message: expect.stringMatching(/another clientRequestId/) },
        });
        expect(result).not.toMatchObject({
          failure: { message: expect.stringMatching(/over_total/) },
        });
        expect(calls.map((each) => each.call)).toEqual(["choices", "start"]);
      }).pipe(Effect.provide(context));
    }).pipe(Effect.scoped),
  );

  it.live("lifts a release before it waits on a machine an earlier spawn left registered", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const machine = {
        id: HostId.make("m-0123456789abcdef01234567"),
        name: "",
        confirmed: true,
        onDemand: "worker",
        via: SERVER.origin,
        onlineSince: undefined as number | undefined,
      };
      // A released machine wakes only once it is told it is working again.
      const { port, calls } = fakePort((call) => {
        if (call === "release") machine.onlineSince = 1;
        return call === "choices" ? { status: 404, body: {} } : { status: 200, body: {} };
      });
      const remote = Layer.succeed(RemoteHosts, {
        machines: { list: () => [], get: () => undefined },
        stops: makeStopMarks(),
        watch: () => () => undefined,
        list: () => [machine],
      } as unknown as RemoteHostsShape);
      const hosts = {
        list: () => [machine],
        remove: () => true,
        machines: {
          provision: () => {
            throw new Error("not registered here");
          },
        },
      };
      const source = signedInSource(SERVER, { port, hosts, timeoutMs: 1_000, everyMs: 10 });
      const context = yield* Layer.build(
        serverLayer(world).pipe(
          Layer.provide(remote),
          Layer.provide(signedIn({ port, source: Effect.succeed({ source, server: SERVER }) })),
        ),
      );
      yield* Effect.gen(function* () {
        const { session, thread } = yield* openOrchestrator(world);
        machine.name = workerMachineName(thread.id, SANDBOX.clientRequestId);
        yield* session.callTool("spawn_worker", SANDBOX).pipe(Effect.result);
        expect(calls.find((each) => each.call === "release")?.body).toEqual({
          name: machine.name,
          released: false,
          reason: "working",
          notAfter: expect.any(Number),
        });
        // It came back: nothing timed out, and nothing of it was stopped or started anew.
        expect(calls.map((each) => each.call)).not.toContain("stop");
        expect(calls.map((each) => each.call)).not.toContain("start");
      }).pipe(Effect.provide(context));
    }).pipe(Effect.scoped),
  );

  it.live("reuses a machine whose release met one not_found, once the server answers again", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const machine = {
        id: HostId.make("m-0123456789abcdef01234567"),
        name: "",
        confirmed: true,
        onDemand: "worker",
        via: SERVER.origin,
        onlineSince: undefined as number | undefined,
      };
      // Its take-back first meets a workspace out of reach; then it is told, and wakes.
      let releases = 0;
      const { port, calls } = fakePort((call) => {
        if (call === "choices") return { status: 404, body: {} };
        if (call !== "release") return { status: 200, body: {} };
        releases += 1;
        if (releases === 1)
          return {
            status: 404,
            body: { code: "not_found", message: "The workspace has no backend." },
          };
        machine.onlineSince = 1;
        return { status: 200, body: { known: true, released: false } };
      });
      const remote = Layer.succeed(RemoteHosts, {
        machines: { list: () => [], get: () => undefined },
        stops: makeStopMarks(),
        watch: () => () => undefined,
        list: () => [machine],
      } as unknown as RemoteHostsShape);
      const hosts = {
        list: () => [machine],
        remove: () => true,
        machines: {
          provision: () => {
            throw new Error("not registered here");
          },
        },
      };
      const source = signedInSource(SERVER, { port, hosts, timeoutMs: 1_000, everyMs: 10 });
      const context = yield* Layer.build(
        serverLayer(world).pipe(
          Layer.provide(remote),
          Layer.provide(signedIn({ port, source: Effect.succeed({ source, server: SERVER }) })),
        ),
      );
      yield* Effect.gen(function* () {
        const { session, thread } = yield* openOrchestrator(world);
        machine.name = workerMachineName(thread.id, SANDBOX.clientRequestId);
        const result = yield* session.callTool("spawn_worker", SANDBOX).pipe(Effect.result);
        // One not_found is no proof it is gone: asked again, and the spawn goes on.
        expect(calls.filter((each) => each.call === "release")).toHaveLength(2);
        expect(result).not.toMatchObject({
          _tag: "Failure",
          failure: { message: expect.stringMatching(/no longer holds/) },
        });
        expect(calls.map((each) => each.call)).not.toContain("stop");
      }).pipe(Effect.provide(context));
    }).pipe(Effect.scoped),
  );

  it.live("refuses a reused machine the server says it holds no more, and forgets nothing", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const { port, calls } = fakePort((call) =>
        call === "choices"
          ? { status: 404, body: {} }
          : call === "release"
            ? { status: 404, body: { code: "not_found" } }
            : { status: 200, body: {} },
      );
      const machine = {
        id: HostId.make("m-0123456789abcdef01234567"),
        name: "",
        confirmed: true,
        onDemand: "worker",
        via: SERVER.origin,
      };
      let registered = true;
      const listed = () => (registered ? [machine] : []);
      const remote = Layer.succeed(RemoteHosts, {
        machines: { list: () => [], get: () => undefined },
        stops: makeStopMarks(),
        watch: () => () => undefined,
        list: listed,
      } as unknown as RemoteHostsShape);
      const hosts = {
        list: listed,
        remove: () => {
          registered = false;
          return true;
        },
        machines: {
          provision: () => {
            throw new Error("not registered here");
          },
        },
      };
      const source = signedInSource(SERVER, { port, hosts, timeoutMs: 5_000, everyMs: 10 });
      const context = yield* Layer.build(
        serverLayer(world).pipe(
          Layer.provide(remote),
          Layer.provide(signedIn({ port, source: Effect.succeed({ source, server: SERVER }) })),
        ),
      );
      yield* Effect.gen(function* () {
        const { session, thread } = yield* openOrchestrator(world);
        machine.name = workerMachineName(thread.id, SANDBOX.clientRequestId);
        const result = yield* session.callTool("spawn_worker", SANDBOX).pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { message: expect.stringMatching(/reclaimed/) },
        });
        // Told at once, not after the wait; nothing stopped. One 404 is no proof it is gone (a
        // server answers it while its backend is out of reach): it stays, for `forgetReclaimed`.
        // Asked three times in a row, a little apart, before the spawn gives up on it.
        expect(calls.map((each) => each.call)).toEqual([
          "choices",
          "release",
          "release",
          "release",
        ]);
        expect(registered).toBe(true);
      }).pipe(Effect.provide(context));
    }).pipe(Effect.scoped),
  );
});
