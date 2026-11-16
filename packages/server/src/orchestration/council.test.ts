import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_CHARTER, type OrchestratorCharter, type UserInput } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import type * as Scope from "effect/Scope";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { hasGit } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { Orchestration } from "./service.ts";
import { OTHER_WORKER_MODELS_LINE, OTHER_WORKER_MODELS_SETTING } from "./service/kit.ts";
import {
  atAutonomy,
  completeTurn,
  makeWorld,
  openOrchestrator,
  openProject,
  spawn,
  waitSent,
  withServer,
  type Server,
  type World,
} from "./test-harness.ts";

// The council (reviewers on other models sending their findings straight to the author) and the
// charter's `otherWorkerModels`, through the orchestrator's own tools on the fake agent, whose
// harnesses each list `fake-opus` and `fake-haiku`.

const inServer = <A, E>(body: (world: World) => Effect.Effect<A, E, Server | Scope.Scope>) =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    return yield* withServer(world, body(world));
  });

const textOf = (input: UserInput | undefined) => input?.text ?? "";

/** A roster of one model, the other one the fake lists left off it. */
const roster = (more: Partial<OrchestratorCharter> = {}): OrchestratorCharter => ({
  ...DEFAULT_CHARTER,
  autonomy: "publish",
  workerModels: [{ agent: "claude", model: "fake-haiku", default: true }],
  ...more,
});

describe.skipIf(!hasGit)("a council", () => {
  it.effect("lets three reviewers send their findings to one author in quick succession", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const registry = yield* AppToolRegistry;
        const store = yield* ThreadStore;
        const { thread } = yield* openOrchestrator(world);
        const session = yield* atAutonomy(thread, "full");
        const author = yield* spawn(session, { feature: "mail-trigger" });
        const reviewers = [];
        for (const seat of ["r1-a", "r1-b", "r1-c"]) {
          reviewers.push(
            yield* spawn(session, {
              feature: "mail-trigger",
              title: `Council ${seat}`,
              branch: `review/mail-trigger-${seat}`,
              readAlso: [author.thread.id],
            }),
          );
        }
        for (const [index, reviewer] of reviewers.entries()) {
          const send = registry
            .forTransport(reviewer.thread.id, "worker")
            .find((tool) => tool.descriptor.name === "send_message")!;
          // Each guard holds per sender: no reviewer's message is the one before it.
          expect(
            yield* send.run({
              threadId: author.thread.id,
              text: `Findings ${index + 1}: one likely, minor. Score 8/10.`,
            }),
          ).toMatchObject({ delivered: expect.any(String) });
          expect(yield* store.listRequests(reviewer.thread.id)).toEqual([]);
        }
      }),
    ),
  );
});

describe.skipIf(!hasGit)("other worker models", () => {
  it.effect("are refused while the setting is absent or off, and the refusal names it", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const orchestration = yield* Orchestration;
        const { session, workspaceId } = yield* openOrchestrator(world);
        for (const charter of [roster(), roster({ otherWorkerModels: false })]) {
          yield* orchestration.setCharter(workspaceId, charter);
          const refused = yield* session
            .callTool("spawn_worker", {
              project: "shop",
              feature: "audit",
              title: "audit",
              brief: "audit",
              model: "claude:fake-opus",
            })
            .pipe(Effect.flip);
          expect(refused.message).toBe(
            `not_admitted: The charter doesn't allow workers on claude:fake-opus. Allowed: claude:fake-haiku (Fake Haiku (echo)). Others need the workspace setting "${OTHER_WORKER_MODELS_SETTING}"; if none of these fits, ask the user to turn it on.`,
          );
        }
        // The same holds for a switch of a worker's model.
        const worker = yield* spawn(session, { feature: "mail-trigger" });
        const stuck = yield* session
          .callTool("set_thread_model", { threadId: worker.thread.id, model: "fake-opus" })
          .pipe(Effect.flip);
        expect(stuck.message).toContain(OTHER_WORKER_MODELS_SETTING);
      }),
    ),
  );

  it.effect(
    "with the setting on, prefer the roster and go beyond it only to a model a harness lists",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const store = yield* ThreadStore;
          const { session, workspaceId } = yield* openOrchestrator(world);
          yield* orchestration.setCharter(workspaceId, roster({ otherWorkerModels: true }));
          // Nothing named: the roster's default, as before.
          const preferred = yield* spawn(session, { feature: "build" });
          expect(preferred.thread.model).toEqual({ agent: "claude", model: "fake-haiku" });
          // Off the roster, on a model the harness lists on the user's own login: Standard speed,
          // and an effort asked past high stops at high (the fake model takes none, so it's left
          // out).
          const beyond = yield* spawn(session, {
            feature: "review",
            model: "claude:fake-opus",
            effort: "max",
          });
          expect(beyond.thread.model).toEqual({
            agent: "claude",
            model: "fake-opus",
            speed: "standard",
          });
          expect(beyond.result).toMatchObject({ model: "claude:fake-opus" });
          expect(beyond.result.warning).toContain("a model off them stops at effort high");
          // A model no harness lists stays refused.
          const unknown = yield* session
            .callTool("spawn_worker", {
              project: "shop",
              feature: "nowhere",
              title: "nowhere",
              brief: "nowhere",
              model: "claude:fake-sonnet",
            })
            .pipe(Effect.flip);
          expect(unknown.message).toContain("No harness here lists it either");
          // A switch follows the same rule, at Standard speed only.
          yield* session.callTool("set_thread_model", {
            threadId: preferred.thread.id,
            model: "fake-opus",
          });
          expect((yield* store.getThread(preferred.thread.id)).model.model).toBe("fake-opus");
        }),
      ),
  );

  it.effect("run at high or below, and a delegated effort can't take them past it", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const orchestration = yield* Orchestration;
        const store = yield* ThreadStore;
        const { session, workspaceId } = yield* openOrchestrator(world);
        // A model of the user's own that takes efforts, which the roster leaves off.
        yield* store.updateSettings((settings) => ({
          ...settings,
          agents: { ...settings.agents, customModels: [{ agent: "claude", id: "fake-deep" }] },
        }));
        yield* orchestration.setCharter(workspaceId, roster({ otherWorkerModels: true }));
        const deep = yield* spawn(session, { feature: "review", model: "claude:fake-deep" });
        expect(deep.thread.model).toEqual({
          agent: "claude",
          model: "fake-deep",
          speed: "standard",
          variant: "high",
        });
        const past = yield* session
          .callTool("set_thread_effort", { threadId: deep.thread.id, effort: "max" })
          .pipe(Effect.flip);
        expect(past.message).toContain("runs at effort high or below, not max");
        expect((yield* store.getThread(deep.thread.id)).model.variant).toBe("high");
        yield* session.callTool("set_thread_effort", { threadId: deep.thread.id, effort: "low" });
        expect((yield* store.getThread(deep.thread.id)).model.variant).toBe("low");
      }),
    ),
  );

  it.effect(
    "are on for a new workspace, said in its charter lines, and a change is told to the session",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const project = yield* openProject(world);
          const made = yield* orchestration.saveWorkspace({
            name: project.name,
            projectIds: [project.id],
            homeProjectId: project.id,
          });
          expect(made.charter.otherWorkerModels).toBe(true);
          const thread = yield* orchestration.open({ projectId: project.id });
          const session = yield* waitSent(thread.id, 1);
          expect(textOf(session.sent[0])).toContain(OTHER_WORKER_MODELS_LINE);
          yield* completeTurn(session);
          const before = session.sent.length;
          const { otherWorkerModels: _on, ...off } = made.charter;
          yield* orchestration.setCharter(made.workspace.id, off);
          yield* TestClock.adjust("60 seconds");
          const woken = yield* waitSent(thread.id, before + 1);
          expect(textOf(woken.sent[before])).toContain("The user turned off other worker models");
        }),
      ),
    { timeout: 90_000 },
  );
});
