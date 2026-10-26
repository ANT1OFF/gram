// Orchestration service: tasks, admitted agents and models, autonomy and connectors.
import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_CHARTER, type ModelRef, type ProfileId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { hasGit } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { threadHandlers } from "../rpc/handlers/threads.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { orchestrationHandlers } from "./handler.ts";
import { Orchestration } from "./service.ts";
import {
  GIT_HEAVY,
  atAutonomy,
  completeTurn,
  openOrchestrator,
  openProject,
  outboxOf,
  settle,
  spawn,
  waitReal,
  waitSent,
  waitStatus,
} from "./test-harness.ts";
import { inServer, texts, sessionsOf } from "./service-kit.ts";

describe.skipIf(!hasGit)("orchestration service", () => {
  it.effect(
    "starts a task: a repo's workspace on first use, the words to its orchestrator, or a worker",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const handlers = yield* orchestrationHandlers;
          const project = yield* openProject(world);

          const orchestrator = yield* handlers["workspace.startTask"]({
            target: { projectId: project.id },
            input: { text: "Add a retry to the mail trigger" },
            // Picked on the draft, so the workspace made for it starts there rather than at full.
            autonomy: "publish",
          });
          expect(orchestrator).toMatchObject({
            role: "orchestrator",
            title: "Orchestrator · shop",
          });
          const workspaceId = orchestrator.workspaceId!;
          const made = yield* store.getWorkspace(workspaceId);
          expect(made.workspace.projectIds).toEqual([project.id]);
          expect(made.charter).toMatchObject({ autonomy: "publish", workerMode: "auto" });
          // A draft that promised another level, made before this workspace was, is refused rather
          // than start under the level it has; one that matches goes ahead.
          const stale = yield* handlers["workspace.startTask"]({
            target: { projectId: project.id },
            input: { text: "Anything" },
            autonomy: "supervised",
          }).pipe(Effect.flip);
          expect(stale).toMatchObject({ _tag: "InvalidState" });
          expect(stale.message).toContain("at publish autonomy, which it keeps");
          const session = yield* waitReal(
            "the task to reach the orchestrator",
            Effect.gen(function* () {
              const [latest] = yield* sessionsOf(orchestrator.id);
              return latest?.sent.some((input) => input.text.includes("mail trigger"))
                ? latest
                : undefined;
            }),
          );
          const task = session.sent.find((input) => input.text.includes("mail trigger"));
          expect(task).toEqual({ text: "Add a retry to the mail trigger" });

          const worker = yield* handlers["workspace.startTask"]({
            target: { workspaceId },
            input: { text: "Fix the flaky retry test\nIt fails on Windows." },
            direct: { projectId: project.id },
          });
          expect(worker).toMatchObject({
            title: "Fix the flaky retry test",
            workspaceId,
            spawnedBy: { threadId: orchestrator.id, feature: "fix-the-flaky-retry-test" },
            checkout: { kind: "worktree", branch: "feat/fix-the-flaky-retry-test" },
          });
          const brief = yield* waitSent(worker.id, 1);
          // The user's own words, so it starts theirs.
          expect(brief.sent[0]).toEqual({ text: "Fix the flaky retry test\nIt fails on Windows." });
          const outbox = yield* outboxOf(workspaceId);
          expect(outbox.workers[worker.id]?.userIntervened).toBe(true);
          expect(outbox.notes.at(-1)).toContain(
            `The user started "Fix the flaky retry test" [thread ${worker.id}] in shop themselves`,
          );
          // The same words again make a feature of their own.
          const again = yield* handlers["workspace.startTask"]({
            target: { workspaceId },
            input: { text: "Fix the flaky retry test" },
            direct: { projectId: project.id },
          });
          expect(again.spawnedBy?.feature).toBe("fix-the-flaky-retry-test-2");

          const elsewhere = yield* store.ensureProject({ root: world.dir, name: "elsewhere" });
          const refused = yield* handlers["workspace.startTask"]({
            target: { workspaceId },
            input: { text: "Anything" },
            direct: { projectId: elsewhere.id },
          }).pipe(Effect.flip);
          expect(refused).toMatchObject({ _tag: "InvalidState" });
          expect(refused.message).toContain("isn't one of");
        }),
      ),
    GIT_HEAVY,
  );

  it.effect("lets a hold lapse once the worker has sat idle ten minutes since the user wrote", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const { session, workspaceId } = yield* openOrchestrator(world);
        const worker = yield* spawn(session, { feature: "mail-trigger", title: "Mail trigger" });
        yield* completeTurn(worker.session);
        const held = outboxOf(workspaceId).pipe(
          Effect.map((outbox) => outbox.workers[worker.thread.id]?.userIntervened === true),
        );

        // A turn still running keeps the hold however long it takes.
        yield* runtimes.send(worker.thread.id, { text: "Use the other queue." });
        yield* waitReal("the hold", held);
        yield* TestClock.adjust("11 minutes");
        yield* settle;
        expect(yield* held).toBe(true);
        // Its end finds the ten minutes long gone.
        yield* completeTurn(worker.session);
        yield* waitReal("the lapse", held.pipe(Effect.map((on) => !on)));
        expect((yield* outboxOf(workspaceId)).notes.at(-1)).toBe(
          `"Mail trigger" [thread ${worker.thread.id}] sat idle 10 minutes after the user last wrote to it, so it is yours again; you may message it.`,
        );

        // Writing again restarts the count from the new message.
        yield* runtimes.send(worker.thread.id, { text: "And rebase." });
        yield* waitReal("the hold again", held);
        yield* completeTurn(worker.session);
        yield* TestClock.adjust("9 minutes");
        yield* settle;
        expect(yield* held).toBe(true);
        yield* TestClock.adjust("1 minutes");
        yield* waitReal("the second lapse", held.pipe(Effect.map((on) => !on)));

        // An input whose agent never opens ends no turn, and lapses all the same.
        const fake = yield* FakeAgentControl;
        yield* TestClock.adjust("15 minutes");
        yield* waitStatus(worker.thread.id, "cold");
        yield* fake.setUnavailable("no agent here");
        yield* runtimes.send(worker.thread.id, { text: "Try again." }).pipe(Effect.ignore);
        yield* waitReal("the hold once more", held);
        yield* waitStatus(worker.thread.id, "error");
        yield* fake.setUnavailable(undefined);
        yield* TestClock.adjust("10 minutes");
        yield* waitReal("the lapse with no turn", held.pipe(Effect.map((on) => !on)));
      }),
    ),
  );

  it.effect("waits twice as long while a thread of the tree is being rate limited", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { session, thread } = yield* openOrchestrator(world);
        const limited = yield* spawn(session, { feature: "billing" });
        const worker = yield* spawn(session, { feature: "mail-trigger" });
        yield* limited.session.emit({ type: "status", status: "retrying" });
        yield* settle;
        yield* completeTurn(worker.session);
        yield* TestClock.adjust("119 seconds");
        yield* settle;
        expect(session.sent).toHaveLength(1);
        yield* TestClock.adjust("1 seconds");
        yield* waitSent(thread.id, 2);
      }),
    ),
  );

  it.effect("lets the user's queue go first, and keeps the digest out of it", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const { session, thread } = yield* openOrchestrator(world);
        const worker = yield* spawn(session, { feature: "mail-trigger" });
        yield* runtimes.send(thread.id, { text: "first from the user" });
        yield* waitSent(thread.id, 2);
        yield* runtimes.send(thread.id, { text: "second from the user" });
        yield* completeTurn(worker.session);
        yield* TestClock.adjust("60 seconds");
        yield* settle;
        const summary = (yield* runtimes.snapshot).find((s) => s.thread.id === thread.id);
        expect(summary?.queue.map((item) => item.input.text)).toEqual(["second from the user"]);

        yield* session.completeTurn();
        yield* waitSent(thread.id, 3);
        expect(texts(session)[2]).toBe("second from the user");
        yield* session.completeTurn();
        yield* waitSent(thread.id, 4);
        expect(session.sent[3]?.notice).toMatchObject({ kind: "orchestration", generation: 2 });
      }),
    ),
  );

  it.effect("moves an orchestrator or a worker that fell out of auto to bypass, once", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const runtimes = yield* ThreadRuntimes;
        const orchestration = yield* Orchestration;
        const project = yield* openProject(world);
        const thread = yield* orchestration.open({ projectId: project.id });
        const session = yield* waitSent(thread.id, 1);
        yield* session.emit({ type: "mode", mode: "default" });
        yield* waitReal(
          "the move to bypass",
          Effect.sync(() => session.modes.includes("bypassPermissions")),
        );
        yield* settle;
        expect((yield* store.getThread(thread.id)).mode).toBe("bypassPermissions");
        yield* completeTurn(session);

        const worker = yield* spawn(session, { feature: "mail-trigger" });
        expect(worker.thread.mode).toBe("auto");
        yield* worker.session.emit({ type: "mode", mode: "default" });
        yield* waitReal(
          "the worker's move to bypass",
          Effect.sync(() => worker.session.modes.includes("bypassPermissions")),
        );
        yield* completeTurn(worker.session);

        // After its first turn the mode is the user's: picking default by hand stands.
        yield* runtimes.setMode(worker.thread.id, "default");
        yield* runtimes.setMode(thread.id, "default");
        yield* settle;
        expect((yield* store.getThread(worker.thread.id)).mode).toBe("default");
        expect((yield* store.getThread(thread.id)).mode).toBe("default");
        expect(worker.session.modes).toEqual(["bypassPermissions", "default"]);
      }),
    ),
  );

  it.effect("holds role-bearing and spawned threads to admitted agent kinds", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const orchestration = yield* Orchestration;
        const handlers = yield* threadHandlers;
        const { session, thread } = yield* openOrchestrator(world);
        const worker = yield* spawn(session, { feature: "mail-trigger" });
        const grok = { agent: "grok", model: "synthetic-grok" } as const;

        const asOrchestrator = yield* handlers["thread.setModel"]({
          threadId: thread.id,
          model: grok,
        }).pipe(Effect.flip);
        expect(asOrchestrator).toMatchObject({ _tag: "InvalidState" });
        expect(asOrchestrator.message).toContain("grok isn't admitted to orchestrate");
        const asWorker = yield* handlers["thread.setModel"]({
          threadId: worker.thread.id,
          model: grok,
        }).pipe(Effect.flip);
        expect(asWorker.message).toContain("Detach it");
        expect((yield* store.getThread(thread.id)).model.agent).toBe("claude");
        expect((yield* store.getThread(worker.thread.id)).model.agent).toBe("claude");

        expect(
          (yield* Effect.flip(orchestration.checkModelChange(worker.thread.id, grok))).message,
        ).toContain("isn't admitted");
        yield* handlers["thread.setModel"]({
          threadId: thread.id,
          model: { agent: "claude", model: "opus" },
        });
        // Anything goes once the worker is detached.
        yield* orchestration.detach(worker.thread.id);
        yield* orchestration.checkModelChange(worker.thread.id, grok);
      }),
    ),
  );

  for (const autonomy of ["supervised", "publish"] as const) {
    for (const ready of [true, false]) {
      it.effect(
        `native Codex orchestrator and worker at ${autonomy}: owned home ready ${ready}`,
        () =>
          inServer((world) =>
            Effect.gen(function* () {
              const fake = yield* FakeAgentControl;
              yield* fake.setNativeGateReady(ready);
              const store = yield* ThreadStore;
              const orchestration = yield* Orchestration;
              const project = yield* openProject(world);
              const native = { agent: "codex", model: "fake-opus" } as const;
              const state = yield* orchestration.saveWorkspace({
                name: "Native gate",
                projectIds: [project.id],
                homeProjectId: project.id,
              });
              const charter = {
                ...DEFAULT_CHARTER,
                autonomy,
                orchestratorModel: native,
                workerModels: [{ ...native, default: true }],
                workerMode: "bypassPermissions" as const,
              };
              yield* orchestration.setCharter(state.workspace.id, charter);
              if (!ready) {
                const refused = yield* Effect.flip(orchestration.open({ projectId: project.id }));
                expect(refused.message).toContain("cannot prepare Gram's native approval home");
                expect((yield* store.listThreads).filter((t) => t.role === "orchestrator")).toEqual(
                  [],
                );
                // A Claude orchestrator still cannot spawn the unavailable native worker.
                yield* orchestration.setCharter(state.workspace.id, {
                  ...charter,
                  orchestratorModel: { agent: "claude", model: "fake-opus" },
                });
              }
              const root = yield* orchestration.open({ projectId: project.id });
              const session = yield* waitSent(root.id, 1);
              yield* completeTurn(session);
              expect(session.options.outwardGate).toBe(
                autonomy === "supervised" ? "all" : "irreversible",
              );
              if (ready) {
                expect(root.model).toEqual(native);
                const worker = yield* spawn(session, {
                  feature: "native",
                  model: "codex:fake-opus",
                });
                expect(worker.thread.model).toEqual(native);
                expect(worker.session.options.outwardGate).toBe(session.options.outwardGate);
                expect(worker.session.options.permissionMode).toBe("bypassPermissions");
                // Revoked preparation readiness refuses model/admission changes even with a held slot.
                yield* fake.setNativeGateReady(false);
                expect(
                  (yield* Effect.flip(orchestration.checkModelChange(worker.thread.id, native)))
                    .message,
                ).toContain("cannot prepare");
              } else {
                const before = yield* store.listThreads;
                const refused = yield* Effect.flip(
                  session.callTool("spawn_worker", {
                    project: "shop",
                    feature: "native",
                    title: "Native",
                    brief: "Work",
                    model: "codex:fake-opus",
                  }),
                );
                expect(refused.message).toContain("cannot prepare");
                expect(yield* store.listThreads).toEqual(before);
              }
            }),
          ),
        GIT_HEAVY,
      );
    }
  }

  it.effect(
    "opens an orchestrator on the user's default model when its kind can hold the gate there",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const orchestration = yield* Orchestration;
          const project = yield* openProject(world);
          const prefer = (defaultModel: ModelRef) =>
            store.updateSettings((settings) => ({
              ...settings,
              agents: { ...settings.agents, defaultModel },
            }));

          // A new workspace starts at full, where nothing asks.
          const made = yield* orchestration.saveWorkspace({
            name: project.name,
            projectIds: [project.id],
            homeProjectId: project.id,
          });
          expect(made.charter).toEqual({
            ...DEFAULT_CHARTER,
            workerMode: "auto",
          });
          expect(made.charter.autonomy).toBe("full");
          // With no model of its own, at publish, it asks before what can't be taken back, which
          // Codex needs its owned home ready: the fake starts unavailable, so refuse before startup.
          yield* orchestration.setCharter(made.workspace.id, {
            ...DEFAULT_CHARTER,
            autonomy: "publish",
          });
          yield* prefer({ agent: "codex", model: "gpt-5.5" });
          const refused = yield* orchestration.open({ projectId: project.id }).pipe(Effect.flip);
          expect(refused).toMatchObject({ _tag: "InvalidState" });
          expect(refused.message).toContain("Codex cannot prepare Gram's native approval home");
          expect(refused.message).toContain("Prepare the native approval home");
          expect((yield* store.listThreads).filter((t) => t.role === "orchestrator")).toEqual([]);

          // An explicit unsupported default is authoritative and refused before a holder exists.
          yield* prefer({ agent: "grok", model: "synthetic-grok" });
          const unsupported = yield* orchestration
            .open({ projectId: project.id })
            .pipe(Effect.flip);
          expect(unsupported).toMatchObject({
            _tag: "InvalidState",
            message: expect.stringContaining("cannot orchestrate"),
          });
          expect((yield* store.listThreads).filter((t) => t.role === "orchestrator")).toEqual([]);
        }),
      ),
  );

  it.effect(
    "refuses gated native model changes without a prepared home and preserves the gateway path",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const orchestration = yield* Orchestration;
          const handlers = yield* threadHandlers;
          const { session, thread, workspaceId } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "mail-trigger" });
          yield* store.upsertProfile({
            id: "litellm" as ProfileId,
            name: "LiteLLM",
            baseURL: "http://127.0.0.1:4000",
            keyRef: "",
            models: [],
          });
          const direct = { agent: "codex", model: "gpt-5.5" } as ModelRef;
          const gone = { agent: "codex", model: "gpt-5.5", profileId: "deleted" } as ModelRef;
          const viaGateway = { agent: "codex", model: "gpt-5.5", profileId: "litellm" } as ModelRef;

          for (const threadId of [worker.thread.id, thread.id]) {
            for (const model of [direct, gone]) {
              const refused = yield* handlers["thread.setModel"]({ threadId, model }).pipe(
                Effect.flip,
              );
              expect(refused).toMatchObject({ _tag: "InvalidState" });
              expect(refused.message).toContain("Codex cannot prepare Gram's native approval home");
            }
            expect((yield* store.getThread(threadId)).model.agent).toBe("claude");
          }
          // `set_thread_model` asks the same `checkModelChange` before the charter's list.
          expect(
            (yield* orchestration.checkModelChange(worker.thread.id, direct).pipe(Effect.flip))
              .message,
          ).toContain(
            "Prepare the native approval home and start a fresh session, or choose a prepared gateway home.",
          );

          yield* handlers["thread.setModel"]({ threadId: worker.thread.id, model: viaGateway });
          expect((yield* store.getThread(worker.thread.id)).model).toEqual(viaGateway);

          // At full there is no gate, so the user's own Codex home will do.
          yield* orchestration.setCharter(workspaceId, { ...DEFAULT_CHARTER, autonomy: "full" });
          yield* orchestration.checkModelChange(worker.thread.id, direct);
          yield* orchestration.checkModelChange(thread.id, direct);
        }),
      ),
  );

  it.effect(
    "won't lower autonomy while a live native Codex worker lacks a prepared home, and names it",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const orchestration = yield* Orchestration;
          const handlers = yield* threadHandlers;
          const { session, thread, workspaceId } = yield* openOrchestrator(world);
          const full = { ...DEFAULT_CHARTER, autonomy: "full" as const };
          yield* atAutonomy(thread, "full");
          const stuck = yield* spawn(session, { feature: "mail-trigger", title: "Mail trigger" });
          const fine = yield* spawn(session, { feature: "docs", title: "Docs" });
          const direct = { agent: "codex", model: "gpt-5.5" } as ModelRef;
          yield* handlers["thread.setModel"]({ threadId: stuck.thread.id, model: direct });

          for (const autonomy of ["publish", "supervised"] as const) {
            const refused = yield* orchestration
              .setCharter(workspaceId, { ...full, autonomy })
              .pipe(Effect.flip);
            expect(refused).toMatchObject({ _tag: "InvalidState" });
            expect(refused.message).toBe(
              `Autonomy can't go from full to ${autonomy} yet, because “Mail trigger” couldn't ask before a push. Codex cannot prepare Gram's native approval home. Check codex login and the Gram data directory, or select a prepared gateway home. Prepare their native approval home and start fresh sessions, choose a prepared gateway home or a mode that can ask, detach them, or let them finish, and then change it.`,
            );
            expect(refused.message).not.toContain(fine.thread.title);
          }
          expect((yield* store.getWorkspace(workspaceId)).charter.autonomy).toBe("full");
          // Nothing else about the charter is held back while it stays at full.
          yield* orchestration.setCharter(workspaceId, { ...full, maxConcurrentWorkers: 3 });

          // Each way out the message names: a finished worker, a detached one, a gateway profile.
          yield* orchestration.detach(stuck.thread.id);
          const lowered = yield* orchestration.setCharter(workspaceId, {
            ...full,
            autonomy: "publish",
          });
          expect(lowered.charter.autonomy).toBe("publish");
        }),
      ),
  );

  it.effect(
    "holds a workspace's threads to its connector set, and reopens them when it changes",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const orchestration = yield* Orchestration;
          const { session, thread, workspaceId, project } = yield* openOrchestrator(world);
          // At full, so a Codex worker needs no gateway profile to ask before a push.
          yield* atAutonomy(thread, "full");
          const worker = yield* spawn(session, { feature: "mail-trigger" });
          yield* completeTurn(worker.session);
          const codexWorker = yield* spawn(session, { feature: "docs" });
          yield* completeTurn(codexWorker.session);
          yield* store.updateSettings((settings) => ({
            ...settings,
            agents: { ...settings.agents, restartOnMcpChange: false },
          }));
          yield* (yield* threadHandlers)["thread.setModel"]({
            threadId: codexWorker.thread.id,
            model: { agent: "codex", model: "gpt-5.5" } as ModelRef,
          });
          // Another agent takes a session of its own, which opens at the reload.
          yield* (yield* ThreadRuntimes).reloadSession(codexWorker.thread.id);
          yield* waitReal(
            "the Codex worker's session",
            sessionsOf(codexWorker.thread.id).pipe(
              Effect.map((sessions) => sessions.at(-1)?.options.model?.agent === "codex"),
            ),
          );
          yield* completeTurn(session);
          const charter = (yield* store.getWorkspace(workspaceId)).charter;

          const refused = yield* orchestration
            .setCharter(workspaceId, {
              ...charter,
              connectors: { allow: ["https://user:secret@organization.example.invalid/x"] },
            })
            .pipe(Effect.flip);
          expect(refused).toMatchObject({ _tag: "InvalidState" });
          expect(refused.message).toContain("without a user name");
          expect((yield* store.getWorkspace(workspaceId)).charter).toEqual(charter);
          // A workspace made with a charter of its own is held to the same rule.
          const made = yield* orchestration
            .saveWorkspace({
              name: "keyed",
              projectIds: [project.id],
              homeProjectId: project.id,
              charter: {
                ...charter,
                connectors: { deny: ["https://organization.example.invalid/x?token=abc"] },
              },
            })
            .pipe(Effect.flip);
          expect(made.message).toContain("without a user name");

          yield* orchestration.setCharter(workspaceId, {
            ...charter,
            connectors: { deny: ["claude.ai Gmail"] },
          });
          const workerAfter = yield* waitReal(
            "the worker's reloaded session",
            sessionsOf(worker.thread.id).pipe(Effect.map((sessions) => sessions[1])),
          );
          expect(workerAfter.options.mcpDenylist).toEqual(["claude.ai Gmail"]);
          expect(workerAfter.options).not.toHaveProperty("mcpAllowlist");
          // A Codex worker restarts onto a fresh app-server, whatever the restart setting says.
          const codexAfter = yield* waitReal(
            "the Codex worker's restarted session",
            sessionsOf(codexWorker.thread.id).pipe(
              Effect.map(
                (sessions) => sessions.at(-1)?.options.mcpDenylist !== undefined && sessions.at(-1),
              ),
            ),
          );
          expect(codexAfter.options.mcpDenylist).toEqual(["claude.ai Gmail"]);
          expect(codexAfter.options.model?.agent).toBe("codex");
          // The orchestrator lists none of its own, so it gets the workspace's as a worker does.
          const orchestratorAfter = yield* waitReal(
            "the orchestrator's reloaded session",
            sessionsOf(thread.id).pipe(
              Effect.map(
                (sessions) => sessions.at(-1)?.options.mcpDenylist !== undefined && sessions.at(-1),
              ),
            ),
          );
          expect(orchestratorAfter.options).toMatchObject({
            mcpDenylist: ["claude.ai Gmail"],
            mcpNoneWithoutToolSearch: true,
          });
          expect(orchestratorAfter.options).not.toHaveProperty("mcpAllowlist");

          // A parked Codex worker's app-server may still hold its thread, so it is retired too.
          const fake = yield* FakeAgentControl;
          yield* store.updateThread(codexWorker.thread.id, (t) => ({ ...t, parked: true }));
          const before = fake.configReloads.filter((reload) => reload === "codex:*").length;
          yield* orchestration.setCharter(workspaceId, {
            ...charter,
            connectors: { deny: ["claude.ai Gmail", "docs"] },
          });
          expect(fake.configReloads.filter((reload) => reload === "codex:*").length).toBe(
            before + 1,
          );
        }),
      ),
  );
});
