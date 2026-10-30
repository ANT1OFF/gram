// Orchestration service: opening workspaces and orchestrators, names and session policy.
import { describe, expect, it } from "@effect/vitest";
import { type AgentKind, DEFAULT_CHARTER, type ProfileId, type WorkerModel } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as nodePath from "node:path";
import { hasGit, makeRepo } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { orchestrationHandlers } from "./handler.ts";
import { MEMORY_INDEX_TEMPLATE } from "./memory.ts";
import { Orchestration } from "./service.ts";
import {
  collectEvents,
  completeTurn,
  openOrchestrator,
  openProject,
  outboxOf,
  settle,
  spawn,
  waitSent,
  waitStatus,
} from "./test-harness.ts";
import { inServer, sessionsOf } from "./service-kit.ts";

/** A kind outside the contract, for the guards that must refuse one. */
const UNADMITTED = "unadmitted" as string as AgentKind;

describe.skipIf(!hasGit)("orchestration service", () => {
  it.effect(
    "opens a workspace, its orchestrator and the slot, and boots it with memory and charter",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const orchestration = yield* Orchestration;
          const events = yield* collectEvents(["workspaces.changed", "orchestration.changed"]);
          const { thread, session, workspaceId, project } = yield* openOrchestrator(world);

          const state = yield* store.getWorkspace(workspaceId);
          expect(state.workspace).toMatchObject({
            name: "shop",
            projectIds: [project.id],
            homeProjectId: project.id,
            orchestratorThreadId: thread.id,
          });
          // `openOrchestrator` holds the workspace at publish; a new one starts at full, below.
          expect(state.charter).toEqual({ ...DEFAULT_CHARTER, autonomy: "publish" });
          expect(thread).toMatchObject({
            role: "orchestrator",
            workspaceId,
            title: "Orchestrator · shop",
            mode: "auto",
            model: { agent: "claude" },
            checkout: { kind: "main", path: world.repo },
          });

          expect(session.options).toMatchObject({
            audience: "orchestrator",
            outwardGate: "irreversible",
            pinCwd: true,
            noBlockingAsk: true,
            // Listing none, it gets every connector where tool search defers their schemas.
            mcpNoneWithoutToolSearch: true,
          });
          expect(session.options).not.toHaveProperty("mcpAllowlist");
          // Claude Code's own peer messaging stays off unless the user lets orchestrators send.
          expect(session.options).not.toHaveProperty("peerMessaging");
          expect(session.options.instructions).toContain('orchestrator of the "shop" workspace');
          expect(session.options.instructions).toContain(world.repo);

          const [boot] = session.sent;
          expect(boot?.notice).toMatchObject({
            kind: "orchestration",
            variant: "boot",
            generation: 1,
          });
          expect(boot?.text).toContain("Orchestration boot #1");
          expect(boot?.text).toContain(MEMORY_INDEX_TEMPLATE.trim().split("\n")[0]);
          expect(boot?.text).toContain(
            `at most ${DEFAULT_CHARTER.maxConcurrentWorkers} workers at once`,
          );
          expect(yield* outboxOf(workspaceId)).toMatchObject({ booted: true, generation: 1 });
          expect(events.map((event) => event.type)).toContain("workspaces.changed");
          expect(events).toContainEqual({ type: "orchestration.changed", workspaceId });

          // Open again: the same thread, by workspace or by project, and nothing new is sent.
          expect((yield* orchestration.open({ workspaceId })).id).toBe(thread.id);
          expect((yield* orchestration.open({ projectId: project.id })).id).toBe(thread.id);
          expect(yield* orchestration.listWorkspaces).toHaveLength(1);
          yield* settle;
          expect(session.sent).toHaveLength(1);

          // A parked holder keeps the slot and is handed back as it is.
          const runtimes = yield* ThreadRuntimes;
          yield* runtimes.updateThread(thread.id, (t) => ({ ...t, parked: true }));
          const parked = yield* orchestration.open({ workspaceId });
          expect(parked).toMatchObject({ id: thread.id, parked: true });
        }),
      ),
  );

  it.effect(
    "starts a new workspace on the app's models, opens on its orchestrator model, and tells it the roster",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const orchestration = yield* Orchestration;
          const project = yield* openProject(world);
          const roster = [
            { agent: "claude", model: "fake-opus", useFor: "orchestration,\n implementation" },
            { agent: "claude", model: "fake-haiku", useFor: "reviews, bug hunts", default: true },
          ] as const;
          const sol = { agent: "codex", model: "gpt-6-sol", variant: "high", useFor: "audits" };
          yield* store.upsertProfile({
            id: "litellm" as ProfileId,
            name: "LiteLLM",
            baseURL: "http://127.0.0.1:4000",
            keyRef: "",
            models: [],
          });
          yield* store.updateSettings((settings) => ({
            ...settings,
            agents: {
              ...settings.agents,
              workerModels: [...roster, sol as WorkerModel],
            },
          }));
          const state = yield* orchestration.saveWorkspace({
            name: "Shop",
            projectIds: [project.id],
            homeProjectId: project.id,
          });
          // The gateway there is has no key, so the Codex entry is left unpinned for one that does.
          expect(state.charter).toEqual({
            ...DEFAULT_CHARTER,
            workerMode: "auto",
            workerModels: [...roster, sol],
          });
          const refused = yield* orchestration
            .setCharter(state.workspace.id, {
              ...state.charter,
              orchestratorModel: { agent: UNADMITTED, model: "synthetic-model" },
            })
            .pipe(Effect.flip);
          expect(refused.message).toBe("unadmitted threads can't be orchestrators yet.");
          yield* orchestration.setCharter(state.workspace.id, {
            ...state.charter,
            orchestratorModel: { agent: "claude", model: "fake-opus" },
          });
          const thread = yield* orchestration.open({ workspaceId: state.workspace.id });
          expect(thread.model).toEqual({ agent: "claude", model: "fake-opus" });
          const session = yield* waitSent(thread.id, 1);
          expect(session.sent[0]?.text ?? "").toContain(
            "workers start in auto mode, on one of these worker models (agent:model, then what the user wants it used for):\n  - claude:fake-opus: orchestration, implementation\n  - claude:fake-haiku (default): reviews, bug hunts\n  - codex:gpt-6-sol: audits [unavailable: Codex does not list gpt-6-sol on your local account; choose a listed model in Settings → Workspaces]",
          );
          yield* completeTurn(session);
          // A spawn on a model that isn't set up gets the default, and says so.
          const audit = yield* spawn(session, { feature: "audit", model: "codex:gpt-6-sol" });
          expect(audit.thread.model).toEqual({ agent: "claude", model: "fake-haiku" });
          expect(audit.result.warning).toContain(
            "codex:gpt-6-sol is unavailable here (Codex does not list gpt-6-sol on your local account; choose a listed model in Settings → Workspaces), so this worker runs on claude:fake-haiku.",
          );
          yield* completeTurn(session);
          yield* TestClock.adjust("60 seconds");
          yield* settle;
          // Adding a gateway never changes local routing. The user must select it explicitly.
          yield* store.upsertProfile({
            id: "sol-gw" as ProfileId,
            name: "Sol gateway",
            baseURL: "http://127.0.0.1:4001",
            keyRef: "vault:sol-gw",
            models: [{ id: "gpt-6-sol", name: "GPT-6 Sol" }],
          });
          const stillLocal = yield* spawn(session, {
            feature: "local-review",
            model: "codex:gpt-6-sol",
          });
          expect(stillLocal.thread.model).toEqual({ agent: "claude", model: "fake-haiku" });
          expect(stillLocal.result.warning).toContain("local account");
          yield* completeTurn(session);
          const beforeGatewayRoster = session.sent.length;
          yield* orchestration.setCharter(state.workspace.id, {
            ...state.charter,
            orchestratorModel: { agent: "claude", model: "fake-opus" },
            workerModels: [...roster, { ...sol, profileId: "sol-gw" as ProfileId } as WorkerModel],
          });
          const onSol = yield* spawn(session, { feature: "review", model: "codex:gpt-6-sol" });
          expect(onSol.thread.model).toEqual({
            agent: "codex",
            model: "gpt-6-sol",
            profileId: "sol-gw",
            variant: "high",
          });
          expect(onSol.result.warning).toBeUndefined();
          yield* completeTurn(session);
          yield* TestClock.adjust("60 seconds");
          const gatewayRosterDigest = yield* waitSent(thread.id, beforeGatewayRoster + 1);
          yield* completeTurn(gatewayRosterDigest);
          yield* settle;

          // An open session hears of a new roster in its next digest; the same roster says nothing.
          const next = [...roster, { agent: "claude", model: "fake-sonnet" } as const];
          yield* orchestration.setCharter(state.workspace.id, {
            ...DEFAULT_CHARTER,
            orchestratorModel: { agent: "claude", model: "fake-opus" },
            workerModels: next,
          });
          const before = session.sent.length;
          yield* TestClock.adjust("60 seconds");
          const woken = yield* waitSent(thread.id, before + 1);
          expect(woken.sent[before]?.text).toContain(
            "The user changed your worker models. From now on, pick from these (agent:model, then what the user wants it used for):\n  - claude:fake-opus: orchestration, implementation\n  - claude:fake-haiku (default): reviews, bug hunts\n  - claude:fake-sonnet",
          );
          yield* completeTurn(woken);
          yield* orchestration.setCharter(state.workspace.id, {
            ...DEFAULT_CHARTER,
            workerModels: next,
          });
          yield* TestClock.adjust("60 seconds");
          yield* settle;
          expect(woken.sent).toHaveLength(before + 1);

          // The same labels on a profile that has gone is a roster changed, told as it now stands.
          yield* orchestration.setCharter(state.workspace.id, {
            ...DEFAULT_CHARTER,
            workerModels: [
              ...roster,
              { agent: "claude", model: "fake-sonnet", profileId: "gone" as ProfileId },
            ],
          });
          yield* TestClock.adjust("60 seconds");
          const moved = yield* waitSent(thread.id, before + 2);
          expect(moved.sent[before + 1]?.text).toContain(
            "  - claude:fake-sonnet [unavailable: its gateway profile is gone; pick another for it in Settings → Workspaces]",
          );
        }),
      ),
  );

  it.effect("workspace names are unique across concurrent creates and renames", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const orchestration = yield* Orchestration;
        const project = yield* openProject(world);
        const projects = { projectIds: [project.id], homeProjectId: project.id } as const;
        const results = yield* Effect.all(
          ["  Shop ", "sHoP"].map((name) =>
            orchestration.saveWorkspace({ ...projects, name }).pipe(Effect.result),
          ),
          { concurrency: 2 },
        );
        expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
        expect(results.find((result) => result._tag === "Failure")).toMatchObject({
          failure: { _tag: "InvalidState", message: "A workspace with that name already exists." },
        });
        const [saved] = yield* store.listWorkspaces;
        const id = saved!.workspace.id;
        const renamed = yield* orchestration.saveWorkspace({ ...projects, id, name: "  SHOP  " });
        expect(renamed.workspace.name).toBe("SHOP");
        const other = yield* orchestration.saveWorkspace({ ...projects, name: "Other" });
        const refused = yield* orchestration
          .saveWorkspace({
            ...projects,
            id: other.workspace.id,
            name: " shop ",
          })
          .pipe(Effect.flip);
        expect(refused).toMatchObject({ _tag: "InvalidState" });
        expect((yield* store.getWorkspace(other.workspace.id)).workspace.name).toBe("Other");
        expect(yield* store.listWorkspaces).toHaveLength(2);
      }),
    ),
  );

  it.effect(
    "implicit opens and tasks choose unique names when a project's name is already taken",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const orchestration = yield* Orchestration;
          const handlers = yield* orchestrationHandlers;
          const first = yield* openProject(world);
          const root = makeRepo(nodePath.join(world.dir, "other"));
          const second = yield* store.ensureProject({ root, name: "shop" });
          const projectIds = [first.id, second.id] as const;
          for (const name of [" SHOP ", "shop (2)"]) {
            yield* orchestration.saveWorkspace({ name, projectIds, homeProjectId: first.id });
          }
          const [opened, started] = yield* Effect.all(
            [
              orchestration.open({ projectId: first.id }),
              handlers["workspace.startTask"]({
                target: { projectId: second.id },
                input: { text: "Review the project" },
              }),
            ],
            { concurrency: 2 },
          );
          expect(opened.workspaceId).not.toBe(started.workspaceId);
          const states = yield* store.listWorkspaces;
          expect(states.map(({ workspace }) => workspace.name).toSorted()).toEqual([
            "SHOP",
            "shop (2)",
            "shop (3)",
            "shop (4)",
          ]);
          expect(
            states.find(({ workspace }) => workspace.id === opened.workspaceId)?.workspace
              .projectIds,
          ).toEqual([first.id]);
          expect(
            states.find(({ workspace }) => workspace.id === started.workspaceId)?.workspace
              .projectIds,
          ).toEqual([second.id]);
          expect((yield* orchestration.open({ projectId: first.id })).id).toBe(opened.id);
          expect((yield* orchestration.open({ projectId: second.id })).id).toBe(started.id);
          expect(yield* store.listWorkspaces).toHaveLength(4);
        }),
      ),
  );

  it.effect("two opens at once end with one orchestrator, and the loser leaves no trace", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const orchestration = yield* Orchestration;
        const project = yield* openProject(world);
        const state = yield* orchestration.saveWorkspace({
          name: "Shop",
          projectIds: [project.id],
          homeProjectId: project.id,
        });
        const [first, second] = yield* Effect.all(
          [
            orchestration.open({ workspaceId: state.workspace.id }),
            orchestration.open({ workspaceId: state.workspace.id }),
          ],
          { concurrency: 2 },
        );
        expect(first.id).toBe(second.id);
        yield* settle;
        const orchestrators = (yield* store.listThreads).filter((t) => t.role === "orchestrator");
        expect(orchestrators.map((t) => t.id)).toEqual([first.id]);
        expect(yield* store.listClosed).toEqual([]);
        expect((yield* store.getWorkspace(state.workspace.id)).workspace.orchestratorThreadId).toBe(
          first.id,
        );
      }),
    ),
  );

  it.effect("a workspace needs its home project", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const orchestration = yield* Orchestration;
        const project = yield* store.ensureProject({ root: world.repo, name: "shop" });
        const other = makeRepo(nodePath.join(world.dir, "other"));
        const second = yield* store.ensureProject({ root: other, name: "other" });
        const homeless = yield* orchestration
          .saveWorkspace({ name: "x", projectIds: [project.id], homeProjectId: second.id })
          .pipe(Effect.flip);
        expect(homeless).toMatchObject({ _tag: "InvalidState" });
      }),
    ),
  );

  it.effect("gives each role its own session policy, and a plain thread none", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const { session, thread } = yield* openOrchestrator(world);
        const worker = yield* spawn(session, { feature: "mail-trigger" });
        expect(worker.session.options).toMatchObject({
          audience: "worker",
          outwardGate: "irreversible",
        });
        expect(worker.session.options.instructions).toContain('worker on "mail-trigger"');
        expect(worker.session.options.instructions).toContain(thread.title);
        expect(yield* runtimes.audienceOf(worker.thread.id)).toBe("worker");
        expect(yield* runtimes.audienceOf(thread.id)).toBe("orchestrator");

        const plain = yield* runtimes.create({
          projectRoot: world.repo,
          checkout: { kind: "main", path: world.repo },
        });
        yield* waitStatus(plain.id, "idle");
        const [opened] = yield* sessionsOf(plain.id);
        expect(opened?.options).toMatchObject({ audience: "plain" });
        expect(opened?.options.outwardGate).toBeUndefined();
        expect(opened?.options.instructions).toBeUndefined();
        for (const options of [worker.session.options, opened?.options]) {
          expect(options).not.toHaveProperty("mcpAllowlist");
          expect(options).not.toHaveProperty("mcpNoneWithoutToolSearch");
          expect(options).not.toHaveProperty("noBlockingAsk");
          expect(options).not.toHaveProperty("pinCwd");
          expect(options).not.toHaveProperty("peerMessaging");
        }
      }),
    ),
  );

  it.effect("lets only an orchestrator send to sessions outside Gram, and only when allowed", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        yield* store.updateSettings((settings) => ({
          ...settings,
          workspaces: { orchestratorPeerMessaging: true },
        }));
        const { session } = yield* openOrchestrator(world);
        expect(session.options).toMatchObject({ audience: "orchestrator", peerMessaging: true });
        // A worker's message to another session would skip Gram's routing, approval and fence.
        const worker = yield* spawn(session, { feature: "peer-off" });
        expect(worker.session.options).not.toHaveProperty("peerMessaging");
      }),
    ),
  );
});
