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
    "previews the actual worker effort when inheriting an orchestrator model without a roster",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = yield* makeWorld;
          const context = yield* Layer.build(serverLayer(world));
          yield* Effect.gen(function* () {
            const project = yield* openProject(world);
            const orchestration = yield* Orchestration;
            const state = yield* orchestration.saveWorkspace({
              name: "Synthetic inherited worker",
              projectIds: [project.id],
              homeProjectId: project.id,
              charter: {
                maxConcurrentWorkers: 1,
                autonomy: "full",
                orchestratorModel: { agent: "codex", model: "synthetic-personal", variant: "high" },
              },
            });
            const handlers = yield* orchestrationHandlers;
            const target = { workspaceId: state.workspace.id };
            const direct = { projectId: project.id };
            const selection = yield* handlers["workspace.taskPreflight"]({ target, direct });
            expect(selection.orchestrator.variant).toBe("high");
            expect(selection.worker).toEqual({ agent: "codex", model: "synthetic-personal" });
            expect(yield* (yield* ThreadStore).listThreads).toEqual([]);
            const worker = yield* handlers["workspace.startTask"]({
              target,
              direct,
              selection,
              input: { text: "Synthetic direct task" },
            });
            expect(worker.model).toEqual(selection.worker);
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

  it.effect(
    "keeps an explicit charter model authoritative and refuses an unavailable direct worker before a holder",
    () =>
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
            const direct = { projectId: project.id };
            const refused = yield* handlers["workspace.startTask"]({
              target,
              direct,
              input: { text: "Synthetic task" },
            }).pipe(Effect.flip);
            expect(refused).toMatchObject({
              _tag: "InvalidState",
              message: expect.stringContaining("will not switch providers"),
            });
            expect(yield* store.listThreads).toEqual([]);
            expect((yield* FakeAgentControl).sessions).toEqual([]);
            expect(
              (yield* store.getWorkspace(state.workspace.id)).workspace.orchestratorThreadId,
            ).toBeUndefined();
          }).pipe(Effect.provide(context));
        }),
      ),
  );
});

describe.skipIf(!hasGit)("independent ordinary task startup race", () => {
  it.effect("refuses a roster changed during startup discovery before creating a holder", () =>
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
                if (agent === "codex" && stall) {
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
            charter: {
              maxConcurrentWorkers: 1,
              autonomy: "full",
              orchestratorModel: { agent: "claude", model: "synthetic-personal" },
              workerModels: [{ agent: "codex", model: "synthetic-personal", default: true }],
            },
          });
          const handlers = yield* orchestrationHandlers;
          const target = { workspaceId: state.workspace.id };
          const direct = { projectId: project.id };
          const selection = yield* handlers["workspace.taskPreflight"]({ target, direct });
          const draftId = Schema.decodeSync(DraftId)("synthetic-roster-race");
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
              direct,
              selection,
              draftId,
              input: { text: "Synthetic ordinary task" },
            }).pipe(Effect.result),
          );
          yield* Deferred.await(entered);
          yield* orchestration.setCharter(state.workspace.id, {
            ...state.charter,
            workerModels: [{ agent: "claude", model: "synthetic-personal", default: true }],
          });
          yield* Deferred.succeed(resume, undefined);
          const result = yield* Fiber.join(startup);
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: {
              _tag: "InvalidState",
              message: expect.stringContaining("selected worker changed"),
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
          stall = false;
          const refreshed = yield* handlers["workspace.taskPreflight"]({ target, direct });
          expect(refreshed.worker?.agent).toBe("claude");
          const worker = yield* handlers["workspace.startTask"]({
            target,
            direct,
            selection: refreshed,
            draftId,
            input: { text: "Synthetic retried task" },
          });
          expect(worker.model).toEqual(refreshed.worker);
          expect(
            yield* Effect.promise(() =>
              readFile(join(attachments, worker.id, "synthetic.txt"), "utf8"),
            ),
          ).toBe("Synthetic attachment");
        }).pipe(Effect.provide(context));
      }),
    ),
  );
});

describe.skipIf(!hasGit)("task startup charter edit boundary", () => {
  it.effect("finishes admitted startup before committing a later roster edit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const editStarted = yield* Deferred.make<void>();
        const editCompleted = yield* Deferred.make<void>();
        let codexLists = 0;
        const context = yield* Layer.build(
          serverLayer(
            world,
            {},
            adapters((agent) =>
              Effect.gen(function* () {
                // Preview and startup plan are the first two listings. The third is
                // inside admitted startup, after its context freshness check.
                if (agent === "codex" && ++codexLists === 3) {
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
            name: "Synthetic admitted task",
            projectIds: [project.id],
            homeProjectId: project.id,
            charter: {
              maxConcurrentWorkers: 1,
              autonomy: "full",
              orchestratorModel: { agent: "claude", model: "synthetic-personal" },
              workerModels: [{ agent: "codex", model: "synthetic-personal", default: true }],
            },
          });
          const handlers = yield* orchestrationHandlers;
          const target = { workspaceId: state.workspace.id };
          const direct = { projectId: project.id };
          const selection = yield* handlers["workspace.taskPreflight"]({ target, direct });
          const startup = yield* Effect.forkScoped(
            handlers["workspace.startTask"]({
              target,
              direct,
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
                workerModels: [{ agent: "claude", model: "synthetic-personal", default: true }],
              });
            }).pipe(Effect.ensuring(Deferred.succeed(editCompleted, undefined))),
          );
          yield* Deferred.await(editStarted);
          yield* Effect.yieldNow;
          expect(yield* Deferred.isDone(editCompleted)).toBe(false);
          expect((yield* store.getWorkspace(state.workspace.id)).charter.workerModels).toEqual(
            state.charter.workerModels,
          );
          yield* Deferred.succeed(resume, undefined);
          const worker = yield* Fiber.join(startup);
          expect(worker.model).toEqual(selection.worker);
          const changed = yield* Fiber.join(edit);
          expect(changed.charter.workerModels?.[0]?.agent).toBe("claude");
          expect(
            (yield* store.listThreads).filter((thread) => thread.role === "orchestrator"),
          ).toHaveLength(1);
        }).pipe(Effect.provide(context));
      }),
    ),
  );
});

const workspaceWith = (
  discovery: (agent: AgentKind) => Effect.Effect<AgentModel[], AgentUnavailable>,
) =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    const context = yield* Layer.build(serverLayer(world, {}, adapters(discovery)));
    return { world, context };
  });

describe.skipIf(!hasGit)("direct task worker choices", () => {
  const roster = [
    {
      agent: "codex" as const,
      model: "synthetic-personal",
      useFor: "reviews",
      default: true,
    },
    { agent: "claude" as const, model: "synthetic-personal", variant: "high" as const },
    { agent: "claude" as const, model: "synthetic-cheap", useFor: "simple tasks" },
  ];

  it.effect("previews the roster as choices and starts the worker on the one picked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { world, context } = yield* workspaceWith(() => Effect.succeed(models));
        yield* Effect.gen(function* () {
          const project = yield* openProject(world);
          const orchestration = yield* Orchestration;
          const state = yield* orchestration.saveWorkspace({
            name: "Synthetic choices",
            projectIds: [project.id],
            homeProjectId: project.id,
            charter: {
              maxConcurrentWorkers: 2,
              autonomy: "full",
              orchestratorModel: { agent: "claude", model: "synthetic-personal" },
              workerModels: roster,
            },
          });
          const handlers = yield* orchestrationHandlers;
          const target = { workspaceId: state.workspace.id };
          const preview = yield* handlers["workspace.taskPreflight"]({
            target,
            direct: { projectId: project.id },
          });
          expect(preview.worker).toEqual({ agent: "codex", model: "synthetic-personal" });
          expect(preview.workerChoices).toEqual([
            {
              model: { agent: "codex", model: "synthetic-personal" },
              useFor: "reviews",
              default: true,
            },
            { model: { agent: "claude", model: "synthetic-personal", variant: "high" } },
            { model: { agent: "claude", model: "synthetic-cheap" }, useFor: "simple tasks" },
          ]);
          const picked = preview.workerChoices![1]!.model;
          const direct = { projectId: project.id, worker: picked };
          const selection = yield* handlers["workspace.taskPreflight"]({ target, direct });
          expect(selection.worker).toEqual(picked);
          const worker = yield* handlers["workspace.startTask"]({
            target,
            direct,
            selection,
            input: { text: "Synthetic picked worker" },
          });
          expect(worker.model).toEqual(picked);
          expect(worker.role).not.toBe("orchestrator");
        }).pipe(Effect.provide(context));
      }),
    ),
  );

  it.effect(
    "offers the rest when the default can't run, and refuses an unavailable or unknown pick",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { world, context } = yield* workspaceWith((agent) =>
            agent === "claude" ? Effect.succeed(models) : absent(agent),
          );
          yield* Effect.gen(function* () {
            const store = yield* ThreadStore;
            const project = yield* openProject(world);
            const orchestration = yield* Orchestration;
            const state = yield* orchestration.saveWorkspace({
              name: "Synthetic unavailable default",
              projectIds: [project.id],
              homeProjectId: project.id,
              charter: {
                maxConcurrentWorkers: 2,
                autonomy: "full",
                orchestratorModel: { agent: "claude", model: "synthetic-personal" },
                workerModels: roster,
              },
            });
            const handlers = yield* orchestrationHandlers;
            const target = { workspaceId: state.workspace.id };
            const preview = yield* handlers["workspace.taskPreflight"]({
              target,
              direct: { projectId: project.id },
            });
            expect(preview.worker).toBeUndefined();
            expect(preview.workerChoices?.[0]).toMatchObject({
              default: true,
              unavailable: expect.stringContaining("couldn't list local models"),
            });
            expect(preview.workerChoices?.slice(1).map((choice) => choice.unavailable)).toEqual([
              undefined,
              undefined,
            ]);
            for (const [worker, message] of [
              [{ agent: "codex", model: "synthetic-personal" }, "can't start a worker here"],
              [
                { agent: "claude", model: "synthetic-invented" },
                "isn't on this workspace's roster",
              ],
            ] as const) {
              const direct = { projectId: project.id, worker };
              for (const attempted of [
                handlers["workspace.taskPreflight"]({ target, direct }).pipe(Effect.asVoid),
                handlers["workspace.startTask"]({
                  target,
                  direct,
                  input: { text: "Refused" },
                }).pipe(Effect.asVoid),
              ]) {
                expect(yield* attempted.pipe(Effect.flip)).toMatchObject({
                  _tag: "InvalidState",
                  message: expect.stringContaining(message),
                });
              }
            }
            expect(yield* store.listThreads).toEqual([]);
            const direct = { projectId: project.id, worker: preview.workerChoices![2]!.model };
            const selection = yield* handlers["workspace.taskPreflight"]({ target, direct });
            const worker = yield* handlers["workspace.startTask"]({
              target,
              direct,
              selection,
              input: { text: "Synthetic available pick" },
            });
            expect(worker.model).toEqual({ agent: "claude", model: "synthetic-cheap" });
          }).pipe(Effect.provide(context));
        }),
      ),
  );
});
