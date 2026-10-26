import { expect, it } from "@effect/vitest";
import { AgentUnavailable, type AgentKind, type ModelRef, type ProfileId } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ThreadStore } from "../persistence/thread-store.ts";
import { AgentHosts } from "./agent-hosts.ts";
import { FakeAgentAdapter, FakeAgentControl } from "./fake-agent.ts";
import { makeRuntimeTestLayer, waitFor } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

const unavailable = (agent: AgentKind) =>
  new AgentUnavailable({
    agent,
    reason: "not-logged-in",
    message: `${agent} synthetic login unavailable`,
  });

const fixture = (available: readonly AgentKind[]) => {
  const discovered: AgentKind[] = [];
  const opened: AgentKind[] = [];
  const agents = Layer.effectContext(
    Effect.gen(function* () {
      const hosts = yield* AgentHosts;
      const control = yield* FakeAgentControl;
      return Context.make(
        AgentHosts,
        AgentHosts.of({
          get: (kind) =>
            hosts.get(kind).pipe(
              Effect.map((host) => ({
                ...host,
                listModels: () => {
                  discovered.push(kind);
                  return available.includes(kind)
                    ? Effect.succeed([
                        { id: `${kind}-other`, displayName: "Other", supportsEffort: false },
                        {
                          id: `${kind}-default`,
                          displayName: "Default",
                          supportsEffort: false,
                          isDefault: true,
                        },
                      ])
                    : Effect.fail(unavailable(kind));
                },
                open: (options) => {
                  opened.push(kind);
                  return available.includes(kind)
                    ? host.open(options)
                    : Effect.fail(unavailable(kind));
                },
              })),
            ),
        }),
      ).pipe(Context.add(FakeAgentControl, control));
    }),
  ).pipe(Layer.provide(FakeAgentAdapter));
  return {
    discovered,
    opened,
    layer: makeRuntimeTestLayer(undefined, undefined, undefined, agents),
  };
};
const input = {
  projectRoot: "/work/repo",
  checkout: { kind: "main", path: "/work/repo" },
} as const;

for (const agent of ["claude", "codex"] as const) {
  it.effect(`no-model creation uses only usable ${agent}'s CLI default and persists it`, () => {
    const f = fixture([agent]);
    return Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const thread = yield* runtimes.create(input);
      expect(thread.model).toEqual({ agent, model: `${agent}-default`, speed: "standard" });
      expect((yield* store.getThread(thread.id)).model).toEqual(thread.model);
      expect(f.opened).toEqual([agent]);
      expect(f.discovered.toSorted()).toEqual(["claude", "codex"]);
    }).pipe(Effect.provide(f.layer));
  });

  for (const source of ["input", "settings"] as const) {
    it.effect(
      `${source} ${agent} choice remains selected after auth failure without other-provider discovery`,
      () => {
        const f = fixture([agent === "claude" ? "codex" : "claude"]);
        return Effect.gen(function* () {
          const runtimes = yield* ThreadRuntimes;
          const store = yield* ThreadStore;
          const model: ModelRef = {
            agent,
            model: "selected",
            variant: "high",
            speed: "fast",
            profileId: "chosen-profile" as ProfileId,
          };
          if (source === "settings")
            yield* store.updateSettings((settings) => ({
              ...settings,
              agents: { ...settings.agents, defaultModel: model },
            }));
          const thread = yield* runtimes.create({
            ...input,
            ...(source === "input" ? { model } : {}),
          });
          expect(thread.model).toEqual(model);
          expect(f.discovered).toEqual([]);
          expect(f.opened).toEqual([agent]);
          const error = yield* waitFor(
            "selected-harness auth error",
            store.getThread(thread.id).pipe(Effect.map((stored) => stored.lastError)),
          );
          expect(error.text).toContain(`${agent} synthetic login unavailable`);
        }).pipe(Effect.provide(f.layer));
      },
    );
  }
}

it.effect(
  "no-model creation refuses when neither local harness is usable before inserting a thread",
  () => {
    const f = fixture([]);
    return Effect.gen(function* () {
      const failure = yield* (yield* ThreadRuntimes).create(input).pipe(Effect.flip);
      expect(failure.message).toContain("Claude Code: claude synthetic login unavailable");
      expect(failure.message).toContain("Codex: codex synthetic login unavailable");
      expect(yield* (yield* ThreadStore).listThreads).toEqual([]);
      expect(f.opened).toEqual([]);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("explicit input outranks saved defaults and keeps its unset speed unspecified", () => {
  const f = fixture(["codex"]);
  return Effect.gen(function* () {
    const store = yield* ThreadStore;
    yield* store.updateSettings((settings) => ({
      ...settings,
      agents: { ...settings.agents, defaultModel: { agent: "claude", model: "saved" } },
    }));
    const thread = yield* (yield* ThreadRuntimes).create({
      ...input,
      model: { agent: "codex", model: "chosen" },
      deferOpen: true,
    });
    expect(thread.model).toEqual({ agent: "codex", model: "chosen" });
    expect(f.discovered).toEqual([]);
  }).pipe(Effect.provide(f.layer));
});
