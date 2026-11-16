import { describe, expect, it } from "@effect/vitest";
import {
  AgentUnavailable,
  DraftId,
  type AgentKind,
  type AgentModel,
  type ModelRef,
} from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { attachmentsDir } from "../attachments/attachments.ts";
import { hasGit } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { FakeAgentAdapter, FakeAgentControl } from "../runtime/fake-agent.ts";
import { orchestrationHandlers } from "./handler.ts";
import { Orchestration } from "./service.ts";
import { makeWorld, openProject, serverLayer } from "./test-harness.ts";

const models: AgentModel[] = [
  { id: "synthetic-personal", displayName: "Synthetic", supportsEffort: false, isDefault: true },
];
const adapters = (discovery: (agent: AgentKind) => Effect.Effect<AgentModel[], AgentUnavailable>) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const hosts = yield* AgentHosts;
      const fake = yield* FakeAgentControl;
      const claude = yield* hosts.get("claude");
      const codex = yield* hosts.get("codex");
      return Context.make(
        AgentHosts,
        AgentHosts.fromHosts([
          { ...claude, listModels: () => discovery("claude") },
          { ...codex, listModels: () => discovery("codex") },
        ]),
      ).pipe(Context.add(FakeAgentControl, fake));
    }),
  ).pipe(Layer.provide(FakeAgentAdapter), Layer.orDie);
const absent = (agent: AgentKind) =>
  Effect.fail(new AgentUnavailable({ agent, message: "Synthetic signed-out CLI" }));

describe.skipIf(!hasGit)("authoritative task preflight", () => {
  it.effect("previews an unset Codex-only task without a holder and starts on the same model", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const context = yield* Layer.build(
          serverLayer(
            world,
            {},
            adapters((agent) => (agent === "codex" ? Effect.succeed(models) : absent(agent))),
          ),
        );
        yield* Effect.gen(function* () {
          const store = yield* ThreadStore;
          const fake = yield* FakeAgentControl;
          const project = yield* openProject(world);
          const handlers = yield* orchestrationHandlers;
          const target = { projectId: project.id };
          const selection = yield* handlers["workspace.taskPreflight"]({ target });
          expect(selection.orchestrator).toEqual({
            agent: "codex",
            model: "synthetic-personal",
            speed: "standard",
          });
          expect(yield* store.listThreads).toEqual([]);
          expect(yield* store.listWorkspaces).toEqual([]);
          expect(fake.sessions).toEqual([]);
          const thread = yield* handlers["workspace.startTask"]({
            target,
            selection,
            input: { text: "Synthetic task" },
          });
          expect(thread.model).toEqual(selection.orchestrator);
          expect(
            (yield* store.getWorkspace(thread.workspaceId!)).charter.workerModels,
          ).toBeUndefined();
          expect(fake.sessions.every((session) => session.options.model?.agent === "codex")).toBe(
            true,
          );
        }).pipe(Effect.provide(context));
      }),
    ),
  );

  it.effect(
    "refuses a stale selection after auth/discovery changes before making a workspace or thread",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = yield* makeWorld;
          let chosen: AgentKind = "codex";
          const context = yield* Layer.build(
            serverLayer(
              world,
              {},
              adapters((agent) => (agent === chosen ? Effect.succeed(models) : absent(agent))),
            ),
          );
          yield* Effect.gen(function* () {
            const store = yield* ThreadStore;
            const project = yield* openProject(world);
            const handlers = yield* orchestrationHandlers;
            const target = { projectId: project.id };
            const selection = yield* handlers["workspace.taskPreflight"]({ target });
            chosen = "claude";
            const refused = yield* handlers["workspace.startTask"]({
              target,
              selection,
              input: { text: "Synthetic task" },
            }).pipe(Effect.flip);
            expect(refused).toMatchObject({
              _tag: "InvalidState",
              message: expect.stringContaining("selected harness changed"),
            });
            expect(yield* store.listThreads).toEqual([]);
            expect(yield* store.listWorkspaces).toEqual([]);
            expect((yield* FakeAgentControl).sessions).toEqual([]);
          }).pipe(Effect.provide(context));
        }),
      ),
  );

  it.effect("keeps an explicit charter model authoritative over the roster", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const context = yield* Layer.build(
          serverLayer(
            world,
            {},
            adapters((agent) => (agent === "claude" ? Effect.succeed(models) : absent(agent))),
          ),
        );
        yield* Effect.gen(function* () {
          const store = yield* ThreadStore;
          const orchestration = yield* Orchestration;
          const project = yield* openProject(world);
          const explicit: ModelRef = {
            agent: "claude",
            model: "explicit-synthetic",
            variant: "high",
          };
          const state = yield* orchestration.saveWorkspace({
            name: "Synthetic",
            projectIds: [project.id],
            homeProjectId: project.id,
            charter: {
              maxConcurrentWorkers: 1,
              autonomy: "full",
              orchestratorModel: explicit,
              workerModels: [
                { agent: "codex", model: "synthetic-personal", default: true },
                { agent: "claude", model: "explicit-synthetic" },
              ],
            },
          });
          const handlers = yield* orchestrationHandlers;
          const target = { workspaceId: state.workspace.id };
          expect((yield* handlers["workspace.taskPreflight"]({ target })).orchestrator).toEqual(
            explicit,
          );
          const thread = yield* handlers["workspace.startTask"]({
            target,
            input: { text: "Synthetic task" },
          });
          expect(thread.model).toMatchObject(explicit);
          expect((yield* store.listThreads).map((each) => each.role)).toEqual(["orchestrator"]);
        }).pipe(Effect.provide(context));
      }),
    ),
  );
});

describe.skipIf(!hasGit)("independent ordinary task startup race", () => {
  it.effect("refuses a charter changed during startup discovery before creating a holder", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        let stall = false;
        const context = yield* Layer.build(
          serverLayer(
            world,
            {},
            adapters((agent) =>
              Effect.gen(function* () {
                if (agent !== "claude") return yield* absent(agent);
                if (stall) {
                  stall = false;
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(resume);
                }
                return models;
              }),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const store = yield* ThreadStore;
          const orchestration = yield* Orchestration;
          const project = yield* openProject(world);
          const state = yield* orchestration.saveWorkspace({
            name: "Synthetic race",
            projectIds: [project.id],
            homeProjectId: project.id,
            charter: { maxConcurrentWorkers: 1, autonomy: "full" },
          });
          const handlers = yield* orchestrationHandlers;
          const target = { workspaceId: state.workspace.id };
          const selection = yield* handlers["workspace.taskPreflight"]({ target });
          const draftId = Schema.decodeSync(DraftId)("synthetic-charter-race");
          const attachments = attachmentsDir(world.dir);
          const staged = join(attachments, "_drafts", draftId);
          yield* Effect.promise(() => mkdir(staged, { recursive: true }));
          yield* Effect.promise(() =>
            writeFile(join(staged, "synthetic.txt"), "Synthetic attachment"),
          );
          stall = true;
          const startup = yield* Effect.forkScoped(
            handlers["workspace.startTask"]({
              target,
              selection,
              draftId,
              input: { text: "Synthetic ordinary task" },
            }).pipe(Effect.result),
          );
          yield* Deferred.await(entered);
          yield* orchestration.setCharter(state.workspace.id, {
            ...state.charter,
            maxConcurrentWorkers: 2,
          });
          yield* Deferred.succeed(resume, undefined);
          const result = yield* Fiber.join(startup);
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: {
              _tag: "InvalidState",
              message: expect.stringContaining("selected harness changed"),
            },
          });
          expect((yield* FakeAgentControl).sessions).toEqual([]);
          expect(yield* Effect.promise(() => readdir(attachments))).toEqual(["_drafts"]);
          expect(yield* Effect.promise(() => readFile(join(staged, "synthetic.txt"), "utf8"))).toBe(
            "Synthetic attachment",
          );
          expect(yield* store.listThreads).toEqual([]);
          expect(
            (yield* store.getWorkspace(state.workspace.id)).workspace.orchestratorThreadId,
          ).toBeUndefined();
          const refreshed = yield* handlers["workspace.taskPreflight"]({ target });
          const orchestrator = yield* handlers["workspace.startTask"]({
            target,
            selection: refreshed,
            draftId,
            input: { text: "Synthetic retried task" },
          });
          expect(orchestrator.role).toBe("orchestrator");
          expect(orchestrator.model).toEqual(refreshed.orchestrator);
          expect(
            yield* Effect.promise(() =>
              readFile(join(attachments, orchestrator.id, "synthetic.txt"), "utf8"),
            ),
          ).toBe("Synthetic attachment");
        }).pipe(Effect.provide(context));
      }),
    ),
  );
});

describe.skipIf(!hasGit)("task startup charter edit boundary", () => {
  it.effect("finishes admitted startup before committing a later charter edit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const editStarted = yield* Deferred.make<void>();
        const editCompleted = yield* Deferred.make<void>();
        const context = yield* Layer.build(
          serverLayer(
            world,
            {},
            adapters((agent) => (agent === "claude" ? Effect.succeed(models) : absent(agent))),
          ),
        );
        yield* Effect.gen(function* () {
          const store = yield* ThreadStore;
          const orchestration = yield* Orchestration;
          const project = yield* openProject(world);
          const state = yield* orchestration.saveWorkspace({
            name: "Synthetic admitted task",
            projectIds: [project.id],
            homeProjectId: project.id,
            charter: { maxConcurrentWorkers: 1, autonomy: "full" },
          });
          const handlers = yield* orchestrationHandlers;
          const target = { workspaceId: state.workspace.id };
          const selection = yield* handlers["workspace.taskPreflight"]({ target });
          // Admitted startup has made the orchestrator, past its context freshness check.
          world.afterCreate = (thread) =>
            thread.role === "orchestrator"
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume)))
              : Effect.void;
          const startup = yield* Effect.forkScoped(
            handlers["workspace.startTask"]({
              target,
              selection,
              input: { text: "Synthetic admitted task" },
            }),
          );
          yield* Deferred.await(entered);
          const edit = yield* Effect.forkScoped(
            Effect.gen(function* () {
              yield* Deferred.succeed(editStarted, undefined);
              return yield* orchestration.setCharter(state.workspace.id, {
                ...state.charter,
                maxConcurrentWorkers: 2,
              });
            }).pipe(Effect.ensuring(Deferred.succeed(editCompleted, undefined))),
          );
          yield* Deferred.await(editStarted);
          yield* Effect.yieldNow;
          expect(yield* Deferred.isDone(editCompleted)).toBe(false);
          expect((yield* store.getWorkspace(state.workspace.id)).charter.maxConcurrentWorkers).toBe(
            1,
          );
          yield* Deferred.succeed(resume, undefined);
          world.afterCreate = undefined;
          const orchestrator = yield* Fiber.join(startup);
          expect(orchestrator.model).toEqual(selection.orchestrator);
          const changed = yield* Fiber.join(edit);
          expect(changed.charter.maxConcurrentWorkers).toBe(2);
          expect(
            (yield* store.listThreads).filter((thread) => thread.role === "orchestrator"),
          ).toHaveLength(1);
        }).pipe(Effect.provide(context));
      }),
    ),
  );
});
