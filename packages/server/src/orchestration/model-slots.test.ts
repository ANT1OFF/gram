import { describe, expect, it } from "@effect/vitest";
import {
  AgentUnavailable,
  DEFAULT_CHARTER,
  RECOMMENDED,
  type AgentKind,
  type AgentModel,
  type OrchestratorCharter,
} from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { hasGit } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { FakeAgentAdapter, FakeAgentControl } from "../runtime/fake-agent.ts";
import { resolveSlot } from "../runtime/model-slots.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { orchestrationHandlers } from "./handler.ts";
import { Orchestration } from "./service.ts";
import { makeWorld, openOrchestrator, openProject, serverLayer, spawn } from "./test-harness.ts";

const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
const row = (id: string, resolvedId?: string): AgentModel => ({
  id,
  displayName: id,
  supportsEffort: true,
  efforts,
  ...(resolvedId === undefined ? {} : { resolvedId }),
});
/** Synthetic lists shaped like each CLI's: Claude's aliases, Codex's ids. */
const CLAUDE = [
  row("opus", "claude-opus-5-5"),
  row("sonnet", "claude-sonnet-5-5"),
  row("haiku", "claude-haiku-5-5"),
];
const CODEX = [row("gpt-6.1-sol"), row("gpt-6-luna")];

const listedBy = (lists: Partial<Record<AgentKind, AgentModel[]>>, agent: AgentKind) => () =>
  lists[agent] === undefined
    ? Effect.fail(new AgentUnavailable({ agent, message: "Synthetic signed-out CLI" }))
    : Effect.succeed(lists[agent]!);

const adapters = (lists: Partial<Record<AgentKind, AgentModel[]>>) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const hosts = yield* AgentHosts;
      const fake = yield* FakeAgentControl;
      const claude = yield* hosts.get("claude");
      const codex = yield* hosts.get("codex");
      return Context.make(
        AgentHosts,
        AgentHosts.fromHosts([
          { ...claude, listModels: listedBy(lists, "claude") },
          // A prepared native home, so a Codex worker can ask under a gated autonomy.
          {
            ...codex,
            listModels: listedBy(lists, "codex"),
            nativeGateReady: Effect.succeed(true),
          },
        ]),
      ).pipe(Context.add(FakeAgentControl, fake));
    }),
  ).pipe(Layer.provide(FakeAgentAdapter), Layer.orDie);

const charter = (over: Partial<OrchestratorCharter>): OrchestratorCharter => ({
  maxConcurrentWorkers: 1,
  autonomy: "full",
  ...over,
});

describe.skipIf(!hasGit)("model slots that follow a tier", () => {
  it.effect("resolve on this machine, and a pinned slot stays as saved", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const context = yield* Layer.build(
          serverLayer(world, {}, adapters({ claude: CLAUDE, codex: CODEX })),
        );
        yield* Effect.gen(function* () {
          const hosts = yield* AgentHosts;
          expect(yield* resolveSlot(hosts, { tier: "scoped" })).toEqual({
            agent: "codex",
            model: "gpt-6.1-sol",
            variant: "medium",
            speed: "standard",
          });
          expect(yield* resolveSlot(hosts, { tier: "lead", agent: "codex" })).toMatchObject({
            model: "gpt-6.1-sol",
            variant: "high",
          });
          const pinned = { agent: "claude" as const, model: "opus", variant: "max" as const };
          expect(yield* resolveSlot(hosts, pinned)).toBe(pinned);
          // Nothing here fills Top: the caller's own fallback takes over.
          expect(yield* resolveSlot(hosts, { tier: "top" })).toBeUndefined();
        }).pipe(Effect.provide(context));
      }),
    ),
  );

  it.effect("open a Codex-only orchestrator on Sol at high, and resolve the roster", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const context = yield* Layer.build(serverLayer(world, {}, adapters({ codex: CODEX })));
        yield* Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const project = yield* openProject(world);
          const state = yield* orchestration.saveWorkspace({
            name: "Synthetic",
            projectIds: [project.id],
            homeProjectId: project.id,
            charter: charter({
              orchestratorModel: { tier: "lead" },
              workerModels: [
                { tier: "scoped", default: true },
                { tier: "cheap", useFor: "Synthetic note of the user's own" },
                { tier: "top", agent: "claude" },
              ],
            }),
          });
          // Stored as saved: the tiers, not what they resolve to.
          expect(
            (yield* (yield* ThreadStore).getWorkspace(state.workspace.id)).charter.workerModels,
          ).toEqual(state.charter.workerModels);
          const handlers = yield* orchestrationHandlers;
          const selection = yield* handlers["workspace.taskPreflight"]({
            target: { workspaceId: state.workspace.id },
            direct: { projectId: project.id },
          });
          expect(selection.orchestrator).toEqual({
            agent: "codex",
            model: "gpt-6.1-sol",
            variant: "high",
            speed: "standard",
          });
          expect(selection.worker).toEqual({
            agent: "codex",
            model: "gpt-6.1-sol",
            variant: "medium",
            speed: "standard",
          });
          const [scoped, cheap, top] = selection.workerChoices!;
          expect(scoped).toMatchObject({ useFor: RECOMMENDED.tiers.scoped.note, default: true });
          expect(cheap).toMatchObject({
            model: { agent: "codex", model: "gpt-6-luna", variant: "medium" },
            useFor: "Synthetic note of the user's own",
          });
          // Kept to Claude, which isn't here: unavailable, never moved to the other harness.
          expect(top?.model).toMatchObject({ agent: "claude", model: "claude-fable-5-2" });
          expect(top?.unavailable).toContain("fills the Top tier");
        }).pipe(Effect.provide(context));
      }),
    ),
  );

  it.effect("start a new chat on the default it follows, recorded as a concrete model", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const context = yield* Layer.build(serverLayer(world, {}, adapters({ claude: CLAUDE })));
        yield* Effect.gen(function* () {
          const store = yield* ThreadStore;
          const runtimes = yield* ThreadRuntimes;
          const project = yield* openProject(world);
          const settings = yield* store.getSettings;
          yield* store.putSettings({
            ...settings,
            agents: { ...settings.agents, defaultModel: { tier: "lead", variant: "low" } },
          });
          const thread = yield* runtimes.create({
            projectRoot: project.root,
            checkout: { kind: "main", path: project.root },
          });
          expect(thread.model).toEqual({
            agent: "claude",
            model: "opus",
            variant: "low",
            speed: "standard",
          });
        }).pipe(Effect.provide(context));
      }),
    ),
  );
});

describe.skipIf(!hasGit)("spawning on a roster entry that follows a tier", () => {
  it.effect("keeps an effort asked of it at high, while a pinned entry takes max", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const context = yield* Layer.build(serverLayer(world, {}, adapters({ claude: CLAUDE })));
        yield* Effect.gen(function* () {
          const { session, workspaceId } = yield* openOrchestrator(world);
          yield* (yield* Orchestration).setCharter(workspaceId, {
            ...DEFAULT_CHARTER,
            autonomy: "publish",
            workerModels: [
              { tier: "lead", default: true },
              { agent: "claude", model: "sonnet" },
            ],
          });
          const following = yield* spawn(session, { feature: "capped", effort: "max" });
          expect(following.thread.model).toEqual({
            agent: "claude",
            model: "opus",
            variant: "high",
            speed: "standard",
          });
          expect(following.result.warning).toContain("stops at high");
          const pinned = yield* spawn(session, {
            feature: "pinned",
            model: "claude:sonnet",
            effort: "max",
          });
          expect(pinned.thread.model).toMatchObject({ model: "sonnet", variant: "max" });
        }).pipe(Effect.provide(context));
      }),
    ),
  );

  it.effect("names two tiers that resolve to the same model apart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const context = yield* Layer.build(
          serverLayer(world, {}, adapters({ claude: CLAUDE, codex: CODEX })),
        );
        yield* Effect.gen(function* () {
          const { session, workspaceId } = yield* openOrchestrator(world);
          yield* (yield* Orchestration).setCharter(workspaceId, {
            ...DEFAULT_CHARTER,
            autonomy: "publish",
            workerModels: [
              { tier: "scoped", agent: "codex", default: true },
              { tier: "lead", agent: "codex" },
            ],
          });
          const listed = (yield* session.callTool("list_workers", {})) as {
            readonly workerModels: ReadonlyArray<{
              readonly model: string;
              readonly runsOn?: string;
            }>;
          };
          expect(listed.workerModels).toMatchObject([
            { model: "tier:scoped:codex", runsOn: "codex:gpt-6.1-sol · medium", default: true },
            { model: "tier:lead:codex", runsOn: "codex:gpt-6.1-sol · high" },
          ]);
          const lead = yield* spawn(session, { feature: "lead", model: "tier:lead:codex" });
          expect(lead.thread.model).toMatchObject({ model: "gpt-6.1-sol", variant: "high" });
          const refused = yield* session
            .callTool("spawn_worker", {
              project: "shop",
              feature: "either",
              title: "Either",
              brief: "Synthetic work",
              model: "codex:gpt-6.1-sol",
            })
            .pipe(Effect.flip);
          expect(refused.message).toContain("tier:<tier>");
        }).pipe(Effect.provide(context));
      }),
    ),
  );
});
