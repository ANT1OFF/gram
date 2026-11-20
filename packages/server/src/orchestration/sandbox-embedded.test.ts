// `spawn_worker`'s `sandbox` on an embedded server, whose machines come from the embedder's host
// provider (`embedding/worker-machines.ts`): a fake provider on loopback, no real machine.

import { createServer, type Server } from "node:http";
import { describe, expect, it } from "@effect/vitest";
import {
  AppToolError,
  type AgentFailureKind,
  HostId,
  LOCAL_HOST_ID,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AppToolRegistry, bindAppTools } from "../app-tools/registry.ts";
import { makeOnDemandHosts, OnDemand } from "../embedding/on-demand.ts";
import { hasGit } from "../git/test-repo.ts";
import { RemoteHosts, type RemoteHostsShape } from "../host/remote-hosts.ts";
import { ServerWork } from "../host/ownership.ts";
import { makeStopMarks } from "../host/stop-marks.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import type { FakeSession } from "../runtime/fake-agent.ts";
import type { HeldSpawn } from "./service.ts";
import { workerMachinesOffered } from "./service/worker-machines-offered.ts";
import {
  atAutonomy,
  makeWorld,
  openOrchestrator,
  outboxOf,
  serverLayer,
  settle,
  spawn,
  waitReal,
} from "./test-harness.ts";

const MACHINE = HostId.make("m-0123456789abcdef01234567");
/** Where an embedded Gram's orchestrator runs: a machine of its person's, never this one. */
const ORCHESTRATORS = HostId.make("m-89abcdef0123456789abcdef");

/** Puts the orchestrator on its person's machine, as an embedder's always is. */
const onItsMachine = (id: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    yield* store.updateThread(id, (thread) => ({
      ...thread,
      checkout: { ...thread.checkout, hostId: ORCHESTRATORS },
    }));
  });

/** An embedder's host provider on loopback that offers no choices and starts what it is asked. */
const fakeProvider = (started: { name?: string }) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ server: Server; url: string; asked: Array<{ path: string; body: unknown }> }>(
          (resolve) => {
            const asked: Array<{ path: string; body: unknown }> = [];
            const server = createServer((req, res) => {
              let text = "";
              req.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
              req.on("end", () => {
                const body = text === "" ? undefined : (JSON.parse(text) as { name?: string });
                asked.push({ path: req.url ?? "", body });
                if (req.url === "/hosts/start" && body?.name !== undefined)
                  started.name = body.name;
                res.writeHead(req.url === "/hosts/choices" ? 404 : 200, {
                  "content-type": "application/json",
                });
                res.end("{}");
              });
            });
            server.listen(0, "127.0.0.1", () => {
              const address = server.address();
              const port = typeof address === "object" && address !== null ? address.port : 0;
              resolve({ server, url: `http://127.0.0.1:${port}`, asked });
            });
          },
        ),
    ),
    ({ server }) => Effect.sync(() => server.close()),
  );

const fail = (session: FakeSession, id: ThreadId, kind: AgentFailureKind = "network") =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    yield* session.emit({
      type: "turnEnd",
      reason: "error",
      error: "Synthetic provider unavailable",
      failure: { kind, retryable: true },
    });
    yield* waitReal(
      "the failed turn",
      store.getThread(id).pipe(Effect.map((thread) => thread.lastError?.kind === kind)),
    );
    yield* settle;
  });

describe("an embedded orchestrator's prompt", () => {
  it.effect("says nothing of worker machines, as it never did", () =>
    Effect.gen(function* () {
      const offered = yield* workerMachinesOffered.pipe(
        Effect.provideService(
          OnDemand,
          makeOnDemandHosts({ url: "http://127.0.0.1:9", token: "t" }),
        ),
      );
      expect(yield* offered).toBeUndefined();
    }),
  );
});

describe.skipIf(!hasGit)("sandbox from an embedder's host provider", () => {
  it.effect(
    "keeps a brief the spawn breaker held, as an embedded spawn always has",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        // This machine and the worker machine are Grace's, as an embedder's are its person's.
        world.owners = new Map([
          [LOCAL_HOST_ID, "grace"],
          [ORCHESTRATORS, "grace"],
          [MACHINE, "grace"],
        ]);
        // The machine it starts joins at once, under the name asked for.
        const started: { name?: string } = {};
        const provider = yield* fakeProvider(started);
        const machine = () =>
          started.name === undefined
            ? []
            : [
                {
                  id: MACHINE,
                  name: started.name,
                  confirmed: true,
                  owner: "grace",
                  onDemand: "worker",
                  onlineSince: 1,
                },
              ];
        const remote = Layer.succeed(RemoteHosts, {
          machines: { list: () => [], get: () => undefined },
          stops: makeStopMarks(),
          watch: () => () => undefined,
          list: machine,
        } as unknown as RemoteHostsShape);
        const context = yield* Layer.build(
          serverLayer(world).pipe(
            Layer.provide(remote),
            Layer.provide(
              Layer.succeed(OnDemand)(makeOnDemandHosts({ url: provider.url, token: "synthetic" })),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const { thread, workspaceId } = yield* openOrchestrator(world);
          const session = yield* atAutonomy(thread, "full", {
            maxConcurrentWorkers: 8,
            workerModels: [{ agent: "claude", model: "fake-opus", default: true }],
          });
          // A worker on the model failed to start: the breaker holds the next spawns on it.
          const failed = yield* spawn(session, { feature: "failed" });
          yield* fail(failed.session, failed.thread.id);
          yield* onItsMachine(thread.id);
          const result = yield* session
            .callTool("spawn_worker", {
              project: "shop",
              feature: "heavy",
              title: "Heavy build",
              brief: "Synthetic work",
              clientRequestId: "heavy-1",
              sandbox: { own: true, reason: "A long build." },
            })
            .pipe(Effect.result);
          expect(provider.asked.map((each) => each.path)).toContain("/hosts/start");
          // Held, as before: the provider keeps its machine and the brief retries later.
          expect(result).toMatchObject({ _tag: "Success", success: { held: true } });
          const held = (result as { success: HeldSpawn }).success;
          expect((yield* outboxOf(workspaceId)).heldBriefs?.map((brief) => brief.id)).toEqual([
            held.id,
          ]);
        }).pipe(Effect.provide(context), Effect.provideService(ServerWork, true));
      }).pipe(Effect.scoped),
    { timeout: 90_000 },
  );
  it.effect(
    "starts its machine and admits it before any approval, as an embedded spawn always has",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        world.owners = new Map([
          [LOCAL_HOST_ID, "grace"],
          [ORCHESTRATORS, "grace"],
          [MACHINE, "grace"],
        ]);
        // The machine it starts joins at once, without Claude Code.
        const started: { name?: string } = {};
        const provider = yield* fakeProvider(started);
        const machine = () =>
          started.name === undefined
            ? []
            : [
                {
                  id: MACHINE,
                  name: started.name,
                  confirmed: true,
                  owner: "grace",
                  onDemand: "worker",
                  onlineSince: 1,
                  tools: [{ tool: "claude", found: false }],
                },
              ];
        const remote = Layer.succeed(RemoteHosts, {
          machines: { list: () => [], get: () => undefined },
          stops: makeStopMarks(),
          watch: () => () => undefined,
          list: machine,
        } as unknown as RemoteHostsShape);
        const context = yield* Layer.build(
          serverLayer(world).pipe(
            Layer.provide(remote),
            Layer.provide(
              Layer.succeed(OnDemand)(makeOnDemandHosts({ url: provider.url, token: "synthetic" })),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const { thread } = yield* openOrchestrator(world);
          yield* onItsMachine(thread.id);
          const registry = yield* AppToolRegistry;
          let asked = 0;
          const gated = bindAppTools(
            registry.definitions.map((definition) =>
              definition.descriptor.name === "spawn_worker"
                ? { ...definition, alwaysAsks: true }
                : definition,
            ),
            thread.id,
            {
              approve: () =>
                Effect.suspend(() => {
                  asked += 1;
                  return Effect.fail(
                    new AppToolError({ tool: "spawn_worker", message: "The user said no." }),
                  );
                }),
            },
          ).find((tool) => tool.descriptor.name === "spawn_worker")!;
          const result = yield* gated
            .run({
              project: "shop",
              feature: "heavy",
              title: "Heavy build",
              brief: "Synthetic work",
              clientRequestId: "heavy-1",
              sandbox: { own: true, reason: "A long build." },
            })
            .pipe(Effect.result);
          // Started and waited for as the call resolved, and refused on what joined, before any
          // card: the user is never asked about a spawn its machine can't run.
          expect(provider.asked.map((each) => each.path)).toContain("/hosts/start");
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { message: expect.stringMatching(/Claude Code is not installed/) },
          });
          expect(asked).toBe(0);
        }).pipe(Effect.provide(context), Effect.provideService(ServerWork, true));
      }).pipe(Effect.scoped),
    { timeout: 90_000 },
  );
});
