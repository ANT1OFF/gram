import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_CHARTER,
  type Autonomy,
  type ModelRef,
  type RequestId,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { Orchestration } from "./service.ts";
import {
  completeTurn,
  makeWorld,
  openProject,
  outboxOf,
  settle,
  spawn,
  waitReal,
  waitSent,
  withServer,
  type World,
} from "./test-harness.ts";

// All hosts/auth/model discovery are injected by FakeAgentAdapter. No installed CLI or gh account is consulted.
const setup = (world: World, agent: ModelRef["agent"] = "codex", autonomy: Autonomy = "full") =>
  Effect.gen(function* () {
    const project = yield* openProject(world);
    const orchestration = yield* Orchestration;
    const state = yield* orchestration.saveWorkspace({
      name: "Synthetic workspace",
      projectIds: [project.id],
      homeProjectId: project.id,
      charter: {
        ...DEFAULT_CHARTER,
        autonomy,
        orchestratorModel: { agent, model: "fake-opus" },
        workerModels: [{ agent: "claude", model: "fake-haiku", useFor: "Reviews" }],
      },
    });
    const thread = yield* orchestration.open({ workspaceId: state.workspace.id });
    const session = yield* waitSent(thread.id, 1);
    yield* completeTurn(session);
    return { state, thread, session, workspaceId: state.workspace.id };
  });
const sessionsFor = (id: ThreadId) =>
  Effect.map(FakeAgentControl, (fake) =>
    fake.sessions.filter((session) => session.options.threadId === id),
  );
const inServer = (body: (world: World) => ReturnType<typeof runCase>) =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    yield* withServer(world, body(world));
  });
const runCase = (
  body: () => Effect.Effect<
    void,
    unknown,
    ThreadStore | ThreadRuntimes | Orchestration | FakeAgentControl
  >,
) => body();

describe("explicit workspace orchestrator switch", () => {
  for (const [source, destination] of [
    ["codex", "claude"],
    ["claude", "codex"],
    ["claude", "claude"],
  ] as const) {
    it.effect(
      `${source} → ${destination}: checkpoint, actual exit, boot, then queued input on the same holder`,
      () =>
        inServer((world) =>
          runCase(() =>
            Effect.gen(function* () {
              const { thread, session, workspaceId, state } = yield* setup(world, source);
              const orchestration = yield* Orchestration;
              const store = yield* ThreadStore;
              const rt = yield* ThreadRuntimes;
              const worker = yield* spawn(session, {
                feature: "review",
                title: "Synthetic worker",
              });
              yield* worker.session.emit({
                type: "request",
                request: {
                  kind: "question",
                  id: "synthetic-worker-question" as RequestId,
                  questions: [
                    {
                      question: "Which local port?",
                      header: "Port",
                      options: [],
                      multiSelect: false,
                    },
                  ],
                },
              });
              yield* waitReal(
                "worker question",
                store
                  .listRequests(worker.thread.id)
                  .pipe(Effect.map((requests) => requests.length === 1)),
              );
              const workerRequests = yield* store.listRequests(worker.thread.id);
              const beforeWorker = yield* store.getThread(worker.thread.id);
              // Before: editing the future preference has no effect on the active holder.
              const target = { agent: destination, model: "fake-haiku" } as const;
              yield* orchestration.setCharter(workspaceId, {
                ...state.charter,
                orchestratorModel: target,
              });
              expect((yield* store.getThread(thread.id)).model).toEqual(thread.model);
              expect(yield* sessionsFor(thread.id)).toHaveLength(1);
              yield* orchestration.handoff(workspaceId, "user", target);
              yield* waitSent(thread.id, 2);
              expect((yield* store.getThread(thread.id)).sessionSwitch).toMatchObject({
                phase: "checkpoint",
                oldExited: false,
                previous: thread.model,
                target,
              });
              expect(
                (yield* rt.send(thread.id, { text: "Queued while checkpointing" })).queued,
              ).toBe(true);
              yield* orchestration.setPaused(workspaceId, true);
              yield* session.completeTurn("ready");
              const fresh = yield* waitReal(
                "target boot",
                Effect.gen(function* () {
                  const all = yield* sessionsFor(thread.id);
                  return all.length === 2 && all[1]!.sent.length > 0 ? all[1] : undefined;
                }),
              );
              expect(session.closed).toBe(true);
              expect(fresh.switchStartupAccepts).toEqual([fresh.options.switchStartup]);
              expect(fresh.options.model).toEqual(target);
              expect(fresh.options.permissionMode).toBe(thread.mode);
              expect(fresh.options.resumeId).toBeUndefined();
              expect(fresh.options.switchStartup).toBeTypeOf("string");
              expect(fresh.sent[0]?.notice).toMatchObject({ variant: "boot" });
              expect(fresh.sent).toHaveLength(1);
              expect((yield* store.getWorkspace(workspaceId)).paused?.reason).toBe("user");
              expect((yield* store.getWorkspace(workspaceId)).charter.orchestratorModel).toEqual(
                target,
              );
              expect((yield* store.getWorkspace(workspaceId)).charter.workerModels).toEqual(
                state.charter.workerModels,
              );
              expect(yield* store.getThread(worker.thread.id)).toEqual(beforeWorker);
              expect(yield* store.listRequests(worker.thread.id)).toEqual(workerRequests);
              expect((yield* store.getWorkspace(workspaceId)).workspace.orchestratorThreadId).toBe(
                thread.id,
              );
              expect((yield* outboxOf(workspaceId)).handoff).toBeUndefined();
              yield* fresh.completeTurn();
              yield* waitSent(thread.id, 2);
              expect(fresh.sent[1]?.text).toContain("Queued while checkpointing");
              expect((yield* store.getThread(thread.id)).sessionSwitch).toBeUndefined();
            }),
          ),
        ),
    );
  }

  for (const autonomy of ["publish", "supervised", "full"] as const) {
    it.effect(`switch preflight honors ${autonomy} autonomy and never edits it`, () =>
      inServer((world) =>
        runCase(() =>
          Effect.gen(function* () {
            const { thread, session, workspaceId, state } = yield* setup(world, "claude", autonomy);
            const orchestration = yield* Orchestration;
            const store = yield* ThreadStore;
            const target = { agent: "codex", model: "fake-haiku" } as const;
            if (autonomy !== "full") {
              const refused = yield* orchestration
                .handoff(workspaceId, "user", target)
                .pipe(Effect.flip);
              expect(refused.message).toContain("approval policy");
              expect((yield* store.getWorkspace(workspaceId)).charter).toEqual(state.charter);
              expect((yield* store.getThread(thread.id)).sessionSwitch).toBeUndefined();
              expect(session.closed).toBe(false);
              expect(session.sent).toHaveLength(1);
              expect((yield* outboxOf(workspaceId)).handoff).toBeUndefined();
            }
            // Claude can preserve every gate. Full also permits local Codex, without weakening policy.
            const allowed =
              autonomy === "full" ? target : ({ agent: "claude", model: "fake-haiku" } as const);
            yield* orchestration.handoff(workspaceId, "user", allowed);
            yield* waitSent(thread.id, 2);
            const undo = yield* orchestration
              .setCharter(workspaceId, { ...state.charter, autonomy: "full" })
              .pipe(Effect.flip);
            expect(undo.message).toContain("Wait for the orchestrator switch");
            expect((yield* store.getWorkspace(workspaceId)).charter).toEqual(state.charter);
            yield* session.completeTurn();
            const fresh = yield* waitReal(
              "policy-preserving target",
              Effect.gen(function* () {
                const all = yield* sessionsFor(thread.id);
                return all.length === 2 && all[1]!.sent.length > 0 ? all[1] : undefined;
              }),
            );
            expect(fresh.options.model).toEqual(allowed);
            expect((yield* store.getWorkspace(workspaceId)).charter.autonomy).toBe(autonomy);
            yield* fresh.completeTurn();
            yield* waitReal(
              "switch completion",
              store.getThread(thread.id).pipe(Effect.map((t) => t.sessionSwitch === undefined)),
            );
          }),
        ),
      ),
    );
  }

  for (const failure of [
    "unsupported",
    "discovery",
    "missing model",
    "effort",
    "checkpoint error",
  ] as const) {
    it.effect(`preflight ${failure} leaves the source and charter unchanged`, () =>
      inServer((world) =>
        runCase(() =>
          Effect.gen(function* () {
            const { thread, session, workspaceId } = yield* setup(world);
            const fake = yield* FakeAgentControl;
            const orchestration = yield* Orchestration;
            const store = yield* ThreadStore;
            const before = yield* store.getWorkspace(workspaceId);
            if (failure === "unsupported") yield* fake.setSwitchCapability(false);
            if (failure === "discovery")
              yield* fake.setModelDiscoveryFailure("Synthetic CLI signed out");
            if (failure === "checkpoint error")
              yield* session.emit({ type: "status", status: "error" });
            yield* settle;
            const target: ModelRef = {
              agent: "claude",
              model: failure === "missing model" ? "Opus5.5-unlisted" : "fake-haiku",
              ...(failure === "effort" ? { variant: "high" } : {}),
            };
            const refused = yield* orchestration
              .handoff(workspaceId, "user", target)
              .pipe(Effect.flip);
            expect(refused._tag).toBe("InvalidState");
            if (failure === "unsupported") expect(refused.message).toContain("Windows");
            expect((yield* store.getWorkspace(workspaceId)).charter).toEqual(before.charter);
            expect((yield* store.getThread(thread.id)).sessionSwitch).toBeUndefined();
            expect(session.sent).toHaveLength(1);
            expect(session.closed).toBe(false);
            expect((yield* outboxOf(workspaceId)).handoff).toBeUndefined();
          }),
        ),
      ),
    );
  }

  it.effect("checkpoint cancellation and concurrent requests retain the existing source", () =>
    inServer((world) =>
      runCase(() =>
        Effect.gen(function* () {
          const { thread, session, workspaceId } = yield* setup(world);
          const orchestration = yield* Orchestration;
          const store = yield* ThreadStore;
          yield* orchestration.handoff(workspaceId, "user", {
            agent: "claude",
            model: "fake-haiku",
          });
          yield* waitSent(thread.id, 2);
          expect(
            (yield* orchestration
              .handoff(workspaceId, "user", { agent: "codex", model: "fake-opus" })
              .pipe(Effect.flip))._tag,
          ).toBe("InvalidState");
          yield* orchestration.cancelSwitch(workspaceId);
          yield* completeTurn(session);
          expect((yield* store.getThread(thread.id)).sessionSwitch).toBeUndefined();
          expect(session.closed).toBe(false);
          expect(yield* sessionsFor(thread.id)).toHaveLength(1);
        }),
      ),
    ),
  );

  it.effect("an interrupted checkpoint does not fabricate memory or start the target", () =>
    inServer((world) =>
      runCase(() =>
        Effect.gen(function* () {
          const { thread, session, workspaceId } = yield* setup(world);
          const orchestration = yield* Orchestration;
          yield* orchestration.handoff(workspaceId, "user", {
            agent: "claude",
            model: "fake-haiku",
          });
          yield* waitSent(thread.id, 2);
          yield* session.emit(
            { type: "turnEnd", reason: "interrupted" },
            { type: "status", status: "idle" },
          );
          yield* waitReal(
            "checkpoint refusal",
            outboxOf(workspaceId).pipe(Effect.map((outbox) => outbox.handoff === undefined)),
          );
          expect(session.closed).toBe(false);
          expect(yield* sessionsFor(thread.id)).toHaveLength(1);
        }),
      ),
    ),
  );

  for (const failure of ["old owner refusal", "target unavailable"] as const) {
    it.effect(`${failure} retains queued input and truthful identity without fallback`, () =>
      inServer((world) =>
        runCase(() =>
          Effect.gen(function* () {
            const { thread, session, workspaceId } = yield* setup(world);
            const fake = yield* FakeAgentControl;
            const orchestration = yield* Orchestration;
            const store = yield* ThreadStore;
            const rt = yield* ThreadRuntimes;
            yield* orchestration.handoff(workspaceId, "user", {
              agent: "claude",
              model: "fake-haiku",
            });
            yield* waitSent(thread.id, 2);
            if (failure === "old owner refusal")
              yield* fake.setSwitchStopFailure("Synthetic held owner refuses graceful stop");
            else yield* fake.setUnavailable("Synthetic target startup failure");
            yield* rt.send(thread.id, { text: "Keep this queued" });
            yield* session.completeTurn();
            const failed = yield* waitReal(
              "failed switch",
              store
                .getThread(thread.id)
                .pipe(
                  Effect.map((current) =>
                    current.sessionSwitch?.phase === "failed" ? current : undefined,
                  ),
                ),
            );
            expect(failed.sessionSwitch?.oldExited).toBe(failure === "target unavailable");
            expect((yield* store.listQueue(thread.id))[0]?.input.text).toBe("Keep this queued");
            expect((yield* store.getWorkspace(workspaceId)).charter.orchestratorModel).toEqual(
              thread.model,
            );
            yield* rt.send(thread.id, { text: "Also retained" });
            expect(yield* sessionsFor(thread.id)).toHaveLength(1);
            expect((yield* rt.restartSession(thread.id).pipe(Effect.flip))._tag).toBe(
              "InvalidState",
            );
            yield* TestClock.adjust("10 minutes");
            yield* settle;
            expect(yield* sessionsFor(thread.id)).toHaveLength(1);
            expect((yield* store.listQueue(thread.id)).map((item) => item.input.text)).toEqual([
              "Keep this queued",
              "Also retained",
            ]);
          }),
        ),
      ),
    );
  }
  it.effect(
    "a running turn finishes before the checkpoint; an open question is never discarded",
    () =>
      inServer((world) =>
        runCase(() =>
          Effect.gen(function* () {
            const { thread, session, workspaceId } = yield* setup(world);
            const orchestration = yield* Orchestration;
            const rt = yield* ThreadRuntimes;
            const store = yield* ThreadStore;
            yield* rt.send(thread.id, { text: "Finish this work first" });
            yield* waitSent(thread.id, 2);
            const requestId = "synthetic-current-question" as RequestId;
            yield* session.emit(
              {
                type: "request",
                request: {
                  kind: "question",
                  id: requestId,
                  questions: [
                    { question: "Which port?", header: "Port", options: [], multiSelect: false },
                  ],
                },
              },
              { type: "status", status: "awaitingInput" },
            );
            yield* waitReal(
              "pending current question",
              store.listRequests(thread.id).pipe(Effect.map((all) => all.length === 1)),
            );
            yield* orchestration.handoff(workspaceId, "user", {
              agent: "claude",
              model: "fake-haiku",
            });
            expect(session.sent).toHaveLength(2);
            expect(yield* store.listRequests(thread.id)).toHaveLength(1);
            expect(session.closed).toBe(false);
            yield* session.emit({ type: "requestResolved", requestId });
            yield* session.completeTurn();
            yield* waitSent(thread.id, 3);
            expect(session.sent[2]?.notice).toMatchObject({ variant: "checkpoint" });
            yield* orchestration.cancelSwitch(workspaceId);
            yield* session.completeTurn();
          }),
        ),
      ),
  );

  it.effect("a late startup cannot accept a failed attempt or drain its queued input", () =>
    inServer((world) =>
      runCase(() =>
        Effect.gen(function* () {
          const { thread, session, workspaceId } = yield* setup(world);
          const fake = yield* FakeAgentControl;
          const orchestration = yield* Orchestration;
          const rt = yield* ThreadRuntimes;
          const store = yield* ThreadStore;
          yield* orchestration.handoff(workspaceId, "user", {
            agent: "claude",
            model: "fake-haiku",
          });
          yield* waitSent(thread.id, 2);
          yield* fake.setOpenDelay("2 minutes");
          yield* rt.send(thread.id, { text: "Held for exact attempt" });
          yield* session.completeTurn();
          yield* waitReal(
            "target starting",
            store
              .getThread(thread.id)
              .pipe(Effect.map((t) => t.sessionSwitch?.phase === "starting")),
          );
          yield* settle;
          yield* TestClock.adjust("46 seconds");
          const failure = yield* waitReal(
            "startup timeout",
            store
              .getThread(thread.id)
              .pipe(
                Effect.map((t) =>
                  t.sessionSwitch?.phase === "failed" ? t.sessionSwitch : undefined,
                ),
              ),
          );
          expect(failure.oldExited).toBe(true);
          yield* TestClock.adjust("2 minutes");
          const late = yield* waitReal(
            "late target object",
            Effect.gen(function* () {
              const sessions = yield* sessionsFor(thread.id);
              return sessions.length === 2 ? sessions[1] : undefined;
            }),
          );
          yield* settle;
          expect(late.switchStartupAccepts).toEqual([]);
          expect(late.sent).toEqual([]);
          expect((yield* store.getThread(thread.id)).sessionSwitch?.phase).toBe("failed");
          expect((yield* store.listQueue(thread.id))[0]?.input.text).toBe("Held for exact attempt");
        }),
      ),
    ),
  );

  for (const phase of ["checkpoint", "stopping", "starting"] as const) {
    it.effect(`backend restart during ${phase} never overlaps an unverified owner`, () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const saved = yield* withServer(
          world,
          Effect.gen(function* () {
            const opened = yield* setup(world);
            const orchestration = yield* Orchestration;
            const fake = yield* FakeAgentControl;
            const store = yield* ThreadStore;
            yield* orchestration.handoff(opened.workspaceId, "user", {
              agent: "claude",
              model: "fake-haiku",
            });
            yield* waitSent(opened.thread.id, 2);
            if (phase !== "checkpoint") {
              if (phase === "stopping") yield* fake.setSwitchStopDelay("1 hour");
              else yield* fake.setOpenDelay("1 hour");
              yield* opened.session.completeTurn();
              yield* waitReal(
                "persisted transition phase",
                store
                  .getThread(opened.thread.id)
                  .pipe(Effect.map((t) => t.sessionSwitch?.phase === phase)),
              );
            }
            if (phase === "stopping") expect(opened.session.switchStopPrepared).toBe(true);
            return { threadId: opened.thread.id, workspaceId: opened.workspaceId };
          }),
        );
        yield* withServer(
          world,
          Effect.gen(function* () {
            const fake = yield* FakeAgentControl;
            const store = yield* ThreadStore;
            const rt = yield* ThreadRuntimes;
            if (phase === "checkpoint") {
              const checkpoint = yield* waitSent(saved.threadId, 1);
              expect(checkpoint.options.model?.agent).toBe("codex");
              expect(checkpoint.sent[0]?.notice).toMatchObject({ variant: "checkpoint" });
              expect(checkpoint.options.switchStartup).toBeUndefined();
            } else {
              yield* waitReal(
                "failed restart fence",
                store
                  .getThread(saved.threadId)
                  .pipe(Effect.map((t) => t.sessionSwitch?.phase === "failed")),
              );
              yield* rt.send(saved.threadId, { text: "Retained after restart" });
              yield* TestClock.adjust("10 minutes");
              yield* settle;
              expect(fake.sessions).toEqual([]);
              expect((yield* store.listQueue(saved.threadId))[0]?.input.text).toBe(
                "Retained after restart",
              );
            }
          }),
        );
      }),
    );
  }

  it.effect("a workspace without a prior holder refuses before creating a switch", () =>
    inServer((world) =>
      runCase(() =>
        Effect.gen(function* () {
          const project = yield* openProject(world);
          const orchestration = yield* Orchestration;
          const state = yield* orchestration.saveWorkspace({
            name: "No holder",
            projectIds: [project.id],
            homeProjectId: project.id,
          });
          const failure = yield* orchestration
            .handoff(state.workspace.id, "user", { agent: "claude", model: "fake-haiku" })
            .pipe(Effect.flip);
          expect(failure.message).toContain("no orchestrator");
          expect((yield* FakeAgentControl).sessions).toEqual([]);
        }),
      ),
    ),
  );
  for (const failure of ["source refusal", "target startup"] as const) {
    it.effect(`an explicit retry after ${failure} retains the checkpoint and same ownership`, () =>
      inServer((world) =>
        runCase(() =>
          Effect.gen(function* () {
            const { thread, session, workspaceId } = yield* setup(world);
            const fake = yield* FakeAgentControl;
            const orchestration = yield* Orchestration;
            const store = yield* ThreadStore;
            yield* orchestration.handoff(workspaceId, "user", {
              agent: "claude",
              model: "fake-haiku",
            });
            yield* waitSent(thread.id, 2);
            if (failure === "source refusal")
              yield* fake.setSwitchStopFailure("Synthetic held owner");
            else yield* fake.setUnavailable("Synthetic startup rejected");
            yield* session.completeTurn();
            const failed = yield* waitReal(
              "failed attempt",
              store
                .getThread(thread.id)
                .pipe(
                  Effect.map((t) =>
                    t.sessionSwitch?.phase === "failed" ? t.sessionSwitch : undefined,
                  ),
                ),
            );
            yield* fake.setUnavailable(undefined);
            yield* fake.setSwitchStopFailure(undefined);
            const retry = yield* orchestration.retrySwitch(workspaceId);
            expect(retry.sessionSwitch?.id).not.toBe(failed.id);
            const fresh = yield* waitReal(
              "retried boot",
              Effect.gen(function* () {
                const sessions = yield* sessionsFor(thread.id);
                return sessions.length === 2 && sessions[1]!.sent.length > 0
                  ? sessions[1]
                  : undefined;
              }),
            );
            expect(session.sent).toHaveLength(2);
            expect(session.closed).toBe(true);
            expect(fresh.options.resumeId).toBeUndefined();
            expect(fresh.switchStartupAccepts).toEqual([retry.sessionSwitch?.id]);
            expect((yield* store.getWorkspace(workspaceId)).workspace.orchestratorThreadId).toBe(
              thread.id,
            );
          }),
        ),
      ),
    );
  }
  it.effect("second preflight refusal releases queued input back to the unchanged source", () =>
    inServer((world) =>
      runCase(() =>
        Effect.gen(function* () {
          const { thread, session, workspaceId } = yield* setup(world);
          const orchestration = yield* Orchestration;
          const fake = yield* FakeAgentControl;
          const rt = yield* ThreadRuntimes;
          const store = yield* ThreadStore;
          yield* orchestration.handoff(workspaceId, "user", {
            agent: "claude",
            model: "fake-haiku",
          });
          yield* waitSent(thread.id, 2);
          yield* rt.send(thread.id, { text: "Return this to the source" });
          yield* fake.setSwitchCapability(false);
          yield* session.completeTurn();
          yield* waitSent(thread.id, 3);
          expect(session.sent[2]?.text).toBe("Return this to the source");
          expect(session.closed).toBe(false);
          expect((yield* store.getThread(thread.id)).sessionSwitch).toBeUndefined();
          expect(yield* sessionsFor(thread.id)).toHaveLength(1);
        }),
      ),
    ),
  );

  it.effect("a configured custom model ID is sent exactly, without substitution", () =>
    inServer((world) =>
      runCase(() =>
        Effect.gen(function* () {
          const { thread, session, workspaceId } = yield* setup(world);
          const store = yield* ThreadStore;
          const orchestration = yield* Orchestration;
          const target = {
            agent: "claude",
            model: "Opus5.5-EXACT-custom",
            variant: "medium",
          } as const;
          yield* store.updateSettings((settings) => ({
            ...settings,
            agents: { ...settings.agents, customModels: [{ agent: "claude", id: target.model }] },
          }));
          yield* orchestration.handoff(workspaceId, "user", target);
          yield* waitSent(thread.id, 2);
          yield* session.completeTurn();
          const fresh = yield* waitReal(
            "custom target boot",
            Effect.gen(function* () {
              const all = yield* sessionsFor(thread.id);
              return all.length === 2 && all[1]!.sent.length > 0 ? all[1] : undefined;
            }),
          );
          expect(fresh.options.model).toEqual(target);
          expect((yield* store.getWorkspace(workspaceId)).charter.orchestratorModel).toEqual(
            target,
          );
        }),
      ),
    ),
  );

  it.effect(
    "a persisted closed pre-spawn receipt permits explicit retry after backend restart",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const saved = yield* withServer(
          world,
          Effect.gen(function* () {
            const opened = yield* setup(world);
            const orchestration = yield* Orchestration;
            const fake = yield* FakeAgentControl;
            const store = yield* ThreadStore;
            yield* orchestration.handoff(opened.workspaceId, "user", {
              agent: "claude",
              model: "fake-haiku",
            });
            yield* waitSent(opened.thread.id, 2);
            yield* fake.setUnavailable("Synthetic target refused before spawn");
            yield* opened.session.completeTurn();
            yield* waitReal(
              "persisted release receipt",
              store
                .getThread(opened.thread.id)
                .pipe(
                  Effect.map(
                    (t) =>
                      t.sessionSwitch?.phase === "failed" &&
                      t.sessionSwitch.targetRelease === "notStarted",
                  ),
                ),
            );
            return { workspaceId: opened.workspaceId, threadId: opened.thread.id };
          }),
        );
        yield* withServer(
          world,
          Effect.gen(function* () {
            const orchestration = yield* Orchestration;
            const fake = yield* FakeAgentControl;
            yield* settle;
            expect(fake.sessions).toEqual([]);
            yield* orchestration.retrySwitch(saved.workspaceId);
            const target = yield* waitSent(saved.threadId, 1);
            expect(target.options.model?.agent).toBe("claude");
            expect(target.options.resumeId).toBeUndefined();
            expect(target.sent[0]?.notice).toMatchObject({ variant: "boot" });
          }),
        );
      }),
  );
});
