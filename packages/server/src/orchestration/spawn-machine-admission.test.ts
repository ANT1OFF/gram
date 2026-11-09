import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_CHARTER, HostId, type ModelRef, ProfileId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RemoteHosts, type RemoteHostsShape } from "../host/remote-hosts.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { FakeAgentAdapter } from "../runtime/fake-agent.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { Orchestration } from "./service.ts";
import { makeWorld, openOrchestrator, serverLayer } from "./test-harness.ts";

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
const remote = Layer.succeed(RemoteHosts, { list: () => [MACHINE] } as unknown as RemoteHostsShape);

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
            const { session, workspaceId } = yield* openOrchestrator(world);
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
            expect(yield* store.listThreads).toEqual(before);
            expect(existsSync(join(world.repo, ".worktrees"))).toBe(false);
          }).pipe(Effect.provide(context));
        }).pipe(Effect.scoped),
    );
  }
});
