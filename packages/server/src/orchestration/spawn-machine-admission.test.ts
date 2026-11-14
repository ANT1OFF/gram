import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_CHARTER, HostId, type ModelRef, ProfileId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RemoteHosts, type RemoteHostsShape } from "../host/remote-hosts.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { FakeAgentAdapter } from "../runtime/fake-agent.ts";
import { AppToolRegistry, bindAppTools } from "../app-tools/registry.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { Orchestration } from "./service.ts";
import { makeWorld, openOrchestrator, serverLayer, spawn } from "./test-harness.ts";

const MACHINE = {
  id: HostId.make("m-0123456789abcdef01234567"),
  name: "build box",
  confirmed: true,
};
const agents = Layer.effect(
  AgentHosts,
  Effect.gen(function* () {
    const hosts = yield* AgentHosts;
    return AgentHosts.of({
      get: (kind) =>
        hosts
          .get(kind)
          .pipe(Effect.map((host) => ({ ...host, nativeGateReady: Effect.succeed(true) }))),
    });
  }),
).pipe(Layer.provideMerge(FakeAgentAdapter));
/** No machine's link is registered, so a call for this machine's own paths looks nothing up. */
const NO_LINKS = { machines: { list: () => [] } };
const remote = Layer.succeed(RemoteHosts, {
  ...NO_LINKS,
  list: () => [MACHINE],
} as unknown as RemoteHostsShape);

describe("spawn admission on a joined machine", () => {
  for (const model of [
    { agent: "codex", model: "fake-opus" },
    { agent: "claude", model: "fake-opus", profileId: ProfileId.make("synthetic-gateway") },
  ] satisfies ModelRef[]) {
    it.effect(
      `refuses ${model.agent}${model.profileId ? " through a gateway" : ""} before making a checkout or thread`,
      () =>
        Effect.gen(function* () {
          const world = yield* makeWorld;
          const context = yield* Layer.build(
            serverLayer(world, {}, agents).pipe(Layer.provide(remote)),
          );
          yield* Effect.gen(function* () {
            const store = yield* ThreadStore;
            const { session, thread, workspaceId } = yield* openOrchestrator(world);
            if (model.profileId !== undefined)
              yield* store.upsertProfile({
                id: model.profileId,
                name: "Synthetic gateway",
                baseURL: "https://gateway.example.test",
                keyRef: "vault:synthetic-unused",
                models: [],
              });
            yield* (yield* Orchestration).setCharter(workspaceId, {
              ...DEFAULT_CHARTER,
              autonomy: "publish",
              workerModels: [model],
            });
            const before = yield* store.listThreads;
            const result = yield* session
              .callTool("spawn_worker", {
                project: "shop",
                feature: "remote-test",
                title: "Remote",
                brief: "Synthetic work",
                machine: "build box",
              })
              .pipe(Effect.result);
            expect(result).toMatchObject({
              _tag: "Failure",
              failure: {
                message: expect.stringMatching(/build box.*direct Claude/),
              },
            });
            // Even a call whose class always asks must be refused before its card is raised.
            let approvals = 0;
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
                  Effect.sync(() => {
                    approvals++;
                  }),
              },
            ).find((tool) => tool.descriptor.name === "spawn_worker")!;
            const refused = yield* gated
              .run({
                project: "shop",
                feature: "remote-card",
                title: "Remote",
                brief: "Synthetic",
                machine: "build box",
              })
              .pipe(Effect.result);
            expect(refused).toMatchObject({
              _tag: "Failure",
              failure: { message: expect.stringMatching(/build box.*direct Claude/) },
            });
            expect(approvals).toBe(0);
            expect(yield* store.listThreads).toEqual(before);
            expect(existsSync(join(world.repo, ".worktrees"))).toBe(false);
          }).pipe(Effect.provide(context));
        }).pipe(Effect.scoped),
    );
  }
  for (const name of ["local", "this machine"]) {
    it.effect(`refuses the ambiguous legacy joined name ${name} instead of starting locally`, () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const machines = Layer.succeed(RemoteHosts, {
          ...NO_LINKS,
          list: () => [{ ...MACHINE, name }],
        } as unknown as RemoteHostsShape);
        const context = yield* Layer.build(
          serverLayer(world, {}, agents).pipe(Layer.provide(machines)),
        );
        yield* Effect.gen(function* () {
          const { session } = yield* openOrchestrator(world);
          const store = yield* ThreadStore;
          const before = yield* store.listThreads;
          const refused = yield* session
            .callTool("spawn_worker", {
              project: "shop",
              feature: "ambiguous",
              title: "Ambiguous",
              brief: "Synthetic",
              machine: name,
            })
            .pipe(Effect.result);
          expect(refused).toMatchObject({
            _tag: "Failure",
            failure: { message: expect.stringContaining("ambiguous_machine") },
          });
          expect(yield* store.listThreads).toEqual(before);
          expect(existsSync(join(world.repo, ".worktrees"))).toBe(false);
        }).pipe(Effect.provide(context));
      }).pipe(Effect.scoped),
    );
  }
  it.effect("runs the reserved names here, and refuses a blank or unknown one with how to", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const context = yield* Layer.build(
        serverLayer(world, {}, agents).pipe(Layer.provide(remote)),
      );
      yield* Effect.gen(function* () {
        const { session } = yield* openOrchestrator(world);
        const store = yield* ThreadStore;
        for (const [feature, machine] of [
          ["here-local", " LOCAL "],
          ["here-this", "This Machine"],
        ] as const) {
          const { thread } = yield* spawn(session, { feature, machine });
          expect(thread.checkout.hostId).toBeUndefined();
        }
        const before = yield* store.listThreads;
        const refuse = (machine: string) =>
          session
            .callTool("spawn_worker", {
              project: "shop",
              feature: "nowhere",
              title: "Nowhere",
              brief: "Synthetic",
              machine,
            })
            .pipe(
              Effect.flip,
              Effect.map((error) => error.message),
            );
        const blank = yield* refuse("   ");
        expect(blank).toMatch(/^unknown_machine: machine is blank/);
        expect(blank).toContain("omit machine");
        const unknown = yield* refuse("this Mac");
        expect(unknown).toMatch(/^unknown_machine: No joined machine is named “this Mac”/);
        expect(unknown).toContain("Joined machines: build box.");
        expect(unknown).toContain("say “local”, to run on this machine");
        expect(yield* store.listThreads).toEqual(before);
      }).pipe(Effect.provide(context));
    }).pipe(Effect.scoped),
  );
  it.effect(
    "refuses a machine started for other work, or for another person, before any card, checkout or thread",
    () =>
      Effect.gen(function* () {
        for (const named of [
          { ...MACHINE, onDemand: "thread" },
          { ...MACHINE, owner: "grace", onDemand: "personal" },
        ]) {
          const world = yield* makeWorld;
          const machines = Layer.succeed(RemoteHosts, {
            ...NO_LINKS,
            list: () => [named],
          } as unknown as RemoteHostsShape);
          const context = yield* Layer.build(
            serverLayer(world, {}, agents).pipe(Layer.provide(machines)),
          );
          yield* Effect.gen(function* () {
            const store = yield* ThreadStore;
            const { session, thread } = yield* openOrchestrator(world);
            const before = yield* store.listThreads;
            // By its name and by its id: the same machine, refused alike.
            for (const machine of ["build box", MACHINE.id]) {
              const refused = yield* session
                .callTool("spawn_worker", {
                  project: "shop",
                  feature: `other-${named.onDemand}`,
                  title: "Elsewhere",
                  brief: "Synthetic",
                  machine,
                })
                .pipe(
                  Effect.flip,
                  Effect.map((error) => error.message),
                );
              expect(refused).toMatch(
                /^not_admitted: A worker goes on its orchestrator's own machine/,
              );
            }
            // Refused before a card is raised, as admission runs ahead of it.
            let approvals = 0;
            const registry = yield* AppToolRegistry;
            const gated = bindAppTools(
              registry.definitions.map((definition) =>
                definition.descriptor.name === "spawn_worker"
                  ? { ...definition, alwaysAsks: true }
                  : definition,
              ),
              thread.id,
              { approve: () => Effect.sync(() => void approvals++) },
            ).find((tool) => tool.descriptor.name === "spawn_worker")!;
            const carded = yield* gated
              .run({
                project: "shop",
                feature: "other-card",
                title: "Elsewhere",
                brief: "Synthetic",
                machine: "build box",
              })
              .pipe(Effect.result);
            expect(carded).toMatchObject({ _tag: "Failure" });
            expect(approvals).toBe(0);
            expect(yield* store.listThreads).toEqual(before);
            expect(existsSync(join(world.repo, ".worktrees"))).toBe(false);
          }).pipe(Effect.provide(context));
        }
      }).pipe(Effect.scoped),
  );

  for (const status of ["notSignedIn", "notInstalled"] as const) {
    it.effect(`refuses a joined machine reported as ${status} before preparing a checkout`, () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const machines = Layer.succeed(RemoteHosts, {
          ...NO_LINKS,
          list: () => [
            {
              ...MACHINE,
              claudeSignIn: status === "notSignedIn" ? "notSignedIn" : "unknown",
              tools: [{ tool: "claude", found: status !== "notInstalled" }],
            },
          ],
        } as unknown as RemoteHostsShape);
        const context = yield* Layer.build(
          serverLayer(world, {}, agents).pipe(Layer.provide(machines)),
        );
        yield* Effect.gen(function* () {
          const { session } = yield* openOrchestrator(world);
          const store = yield* ThreadStore;
          const before = yield* store.listThreads;
          const refused = yield* session
            .callTool("spawn_worker", {
              project: "shop",
              feature: "needs-claude",
              title: "Needs Claude",
              brief: "Synthetic",
              machine: "build box",
            })
            .pipe(Effect.result);
          expect(refused).toMatchObject({
            _tag: "Failure",
            failure: {
              message: expect.stringMatching(
                status === "notSignedIn" ? /build box.*not signed in/ : /build box.*not installed/,
              ),
            },
          });
          expect(yield* store.listThreads).toEqual(before);
          expect(existsSync(join(world.repo, ".worktrees"))).toBe(false);
        }).pipe(Effect.provide(context));
      }).pipe(Effect.scoped),
    );
  }
});
