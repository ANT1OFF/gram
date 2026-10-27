// Independent 93 review oracles: only imports/types adapted here; original external copies and hashes are retained.
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { DEFAULT_CHARTER } from "@gram/contracts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { Orchestration } from "./service.ts";
import {
  makeWorld,
  withServer,
  openProject,
  waitSent,
  completeTurn,
  waitReal,
  settle,
  type World,
} from "./test-harness.ts";
const setup = (world: World) =>
  Effect.gen(function* () {
    const project = yield* openProject(world),
      orchestration = yield* Orchestration;
    const state = yield* orchestration.saveWorkspace({
      name: "Independent queue probe",
      projectIds: [project.id],
      homeProjectId: project.id,
      charter: {
        ...DEFAULT_CHARTER,
        autonomy: "full",
        orchestratorModel: { agent: "codex", model: "fake-opus" },
      },
    });
    const thread = yield* orchestration.open({ workspaceId: state.workspace.id });
    const session = yield* waitSent(thread.id, 1);
    yield* completeTurn(session);
    return { thread, session, workspaceId: state.workspace.id };
  });
for (const switching of [false, true])
  it.effect(
    switching
      ? "switch checkpoint must hold explicit queued steer"
      : "neighbor: ordinary running turn permits explicit queued steer",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const { thread, session, workspaceId } = yield* setup(world),
              rt = yield* ThreadRuntimes,
              store = yield* ThreadStore,
              orchestration = yield* Orchestration;
            if (switching)
              yield* orchestration.handoff(workspaceId, "user", {
                agent: "claude",
                model: "fake-haiku",
              });
            else yield* rt.send(thread.id, { text: "Ordinary active work" });
            yield* waitSent(thread.id, 2);
            expect((yield* rt.send(thread.id, { text: "Independent held input" })).queued).toBe(
              true,
            );
            const queued = yield* store.listQueue(thread.id);
            expect(queued).toHaveLength(1);
            yield* Effect.exit(rt.steerQueued(thread.id, queued[0]!.id));
            if (switching) {
              expect(session.steered).toEqual([]);
              expect((yield* store.listQueue(thread.id)).map((x) => x.input.text)).toEqual([
                "Independent held input",
              ]);
            } else {
              expect(session.steered.map((x) => x.text)).toEqual(["Independent held input"]);
              expect(yield* store.listQueue(thread.id)).toEqual([]);
            }
          }),
        );
      }),
  );

for (const switching of [false, true])
  it.effect(
    switching
      ? "switch checkpoint must hold automatic monitor notices"
      : "neighbor: ordinary running turn permits automatic monitor notices",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const { thread, session, workspaceId } = yield* setup(world),
              rt = yield* ThreadRuntimes,
              store = yield* ThreadStore,
              orchestration = yield* Orchestration;
            if (switching)
              yield* orchestration.handoff(workspaceId, "user", {
                agent: "claude",
                model: "fake-haiku",
              });
            else yield* rt.send(thread.id, { text: "Ordinary active work" });
            yield* waitSent(thread.id, 2);
            const result = yield* rt.sendNotice(thread.id, "independent-monitor", {
              text: "Independent automatic notice",
            });
            if (switching) {
              expect(result.queued).toBe(true);
              expect(session.steered).toEqual([]);
              expect((yield* store.listQueue(thread.id)).map((x) => x.input.text)).toEqual([
                "Independent automatic notice",
              ]);
            } else {
              expect(result.steered).toBe(true);
              expect(session.steered.map((x) => x.text)).toEqual(["Independent automatic notice"]);
            }
          }),
        );
      }),
  );

import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
for (const switching of [false, true])
  it.effect(
    switching
      ? "late ordinary model selection must not overwrite switch identity"
      : "neighbor: ordinary delayed model discovery still applies selection",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const { thread, session, workspaceId } = yield* setup(world),
              rt = yield* ThreadRuntimes,
              store = yield* ThreadStore,
              orchestration = yield* Orchestration,
              hosts = yield* AgentHosts,
              fake = yield* FakeAgentControl;
            const entered = yield* Deferred.make<void>(),
              release = yield* Deferred.make<void>();
            const get = hosts.get;
            let stalled = false;
            hosts.get = (kind) =>
              get(kind).pipe(
                Effect.map((host) =>
                  kind !== "codex"
                    ? host
                    : {
                        ...host,
                        listModels: () =>
                          Effect.gen(function* () {
                            const listed = yield* host.listModels();
                            if (!stalled) {
                              stalled = true;
                              yield* Deferred.succeed(entered, undefined);
                              yield* Deferred.await(release);
                            }
                            return listed.map((m) => ({ ...m, speeds: ["fast" as const] }));
                          }),
                      },
                ),
              );
            const model = { agent: "codex", model: "fake-opus", speed: "fast" } as const;
            const setter = yield* Effect.forkScoped(Effect.exit(rt.setModel(thread.id, model)));
            yield* Deferred.await(entered);
            if (switching) {
              yield* orchestration.handoff(workspaceId, "user", {
                agent: "claude",
                model: "fake-haiku",
              });
              yield* waitSent(thread.id, 2);
              yield* fake.setOpenDelay("1 second");
              yield* session.completeTurn();
              yield* waitReal(
                "target starting",
                store
                  .getThread(thread.id)
                  .pipe(Effect.map((t) => t.sessionSwitch?.phase === "starting")),
              );
            }
            yield* Deferred.succeed(release, undefined);
            const result = yield* Fiber.join(setter);
            if (switching) {
              yield* settle;
              yield* TestClock.adjust("1 second");
              yield* waitReal(
                "target boot",
                Effect.sync(() => fake.sessions.length === 2 && fake.sessions[1]!.sent.length > 0),
              );
              const current = yield* store.getThread(thread.id),
                state = yield* store.getWorkspace(workspaceId);
              expect(current.model).toEqual({ agent: "claude", model: "fake-haiku" });
              expect(current.model).toEqual(state.charter.orchestratorModel);
            } else {
              expect(result._tag).toBe("Success");
              expect((yield* store.getThread(thread.id)).model).toEqual(model);
              expect(session.models).toEqual([model]);
            }
          }),
        );
      }),
  );

for (const finish of ["completed", "cancelled", "failed"] as const) {
  it.effect(`a delayed model selection stays bound to its owner after ${finish}`, () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const { thread, session, workspaceId } = yield* setup(world);
          const rt = yield* ThreadRuntimes;
          const store = yield* ThreadStore;
          const hosts = yield* AgentHosts;
          const fake = yield* FakeAgentControl;
          const orchestration = yield* Orchestration;
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const get = hosts.get;
          let stalled = false;
          hosts.get = (kind) =>
            get(kind).pipe(
              Effect.map((host) =>
                kind !== "codex"
                  ? host
                  : {
                      ...host,
                      listModels: () =>
                        Effect.gen(function* () {
                          const listed = yield* host.listModels();
                          if (!stalled) {
                            stalled = true;
                            yield* Deferred.succeed(entered, undefined);
                            yield* Deferred.await(release);
                          }
                          return listed.map((model) => ({ ...model, speeds: ["fast" as const] }));
                        }),
                    },
              ),
            );
          const setter = yield* Effect.forkScoped(
            Effect.exit(
              rt.setModel(thread.id, { agent: "codex", model: "fake-opus", speed: "fast" }),
            ),
          );
          yield* Deferred.await(entered);
          yield* orchestration.handoff(workspaceId, "user", {
            agent: "claude",
            model: "fake-haiku",
          });
          yield* waitSent(thread.id, 2);
          if (finish === "cancelled") yield* orchestration.cancelSwitch(workspaceId);
          else {
            if (finish === "failed") yield* fake.setUnavailable("Synthetic target refusal");
            yield* session.completeTurn();
            yield* waitReal(
              "switch settled",
              store
                .getThread(thread.id)
                .pipe(
                  Effect.map((t) =>
                    finish === "failed"
                      ? t.sessionSwitch?.phase === "failed"
                      : t.sessionSwitch === undefined,
                  ),
                ),
            );
          }
          const before = yield* store.getThread(thread.id);
          yield* Deferred.succeed(release, undefined);
          expect((yield* Fiber.join(setter))._tag).toBe("Failure");
          expect((yield* store.getThread(thread.id)).model).toEqual(before.model);
          expect(fake.sessions.flatMap((s) => s.models)).toEqual([]);
          expect((yield* store.getWorkspace(workspaceId)).charter.orchestratorModel).toEqual(
            finish === "completed" ? { agent: "claude", model: "fake-haiku" } : thread.model,
          );
        }),
      );
    }),
  );
}

for (const outcome of ["cancel", "target"] as const) {
  it.effect(
    `checkpoint holds direct steer and deduplicated notices in order until ${outcome}`,
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const { thread, session, workspaceId } = yield* setup(world);
            const rt = yield* ThreadRuntimes;
            const store = yield* ThreadStore;
            const orchestration = yield* Orchestration;
            const fake = yield* FakeAgentControl;
            yield* orchestration.handoff(workspaceId, "user", {
              agent: "claude",
              model: "fake-haiku",
            });
            yield* waitSent(thread.id, 2);
            yield* rt.sendNotice(thread.id, "held-review", { text: "Review one" });
            yield* rt.send(thread.id, { text: "User behind review" });
            const original = yield* store.listQueue(thread.id);
            expect(
              yield* rt.sendNotice(thread.id, "held-review", { text: "Review two" }),
            ).toMatchObject({ queued: true, replaced: true });
            const before = yield* store.listQueue(thread.id);
            expect(before.map((i) => i.id)).toEqual(original.map((i) => i.id));
            expect(before.map((i) => i.input.text)).toEqual(["Review two", "User behind review"]);
            expect(
              (yield* rt.steer(thread.id, { text: "Direct must refuse" }).pipe(Effect.flip))._tag,
            ).toBe("InvalidState");
            expect((yield* rt.steerQueued(thread.id, before[1]!.id).pipe(Effect.flip))._tag).toBe(
              "InvalidState",
            );
            expect(yield* store.listQueue(thread.id)).toEqual(before);
            expect(session.steered).toEqual([]);
            if (outcome === "cancel") yield* orchestration.cancelSwitch(workspaceId);
            yield* session.completeTurn();
            if (outcome === "target") {
              yield* waitReal(
                "target boot",
                Effect.sync(
                  () => fake.sessions.length === 2 && fake.sessions[1]!.sent.length === 1,
                ),
              );
              expect((yield* store.listQueue(thread.id)).map((i) => i.input.text)).toEqual([
                "Review two",
                "User behind review",
              ]);
              yield* fake.sessions[1]!.completeTurn();
              yield* waitReal(
                "target drains review",
                Effect.sync(() => fake.sessions[1]!.sent.length === 2),
              );
              expect(fake.sessions[1]!.sent[1]!.text).toBe("Review two");
              yield* fake.sessions[1]!.completeTurn();
              yield* waitReal(
                "target drains user",
                Effect.sync(() => fake.sessions[1]!.sent.length === 3),
              );
              expect(fake.sessions[1]!.sent[2]!.text).toBe("User behind review");
            } else {
              yield* waitSent(thread.id, 3);
              expect(session.sent[2]!.text).toBe("Review two");
              yield* session.completeTurn();
              yield* waitSent(thread.id, 4);
              expect(session.sent[3]!.text).toBe("User behind review");
            }
            expect(yield* store.listQueue(thread.id)).toEqual([]);
          }),
        );
      }),
  );
}

it.effect("model/mode/session and host config refreshes cannot take a checkpoint owner", () =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    yield* withServer(
      world,
      Effect.gen(function* () {
        const { thread, session, workspaceId } = yield* setup(world);
        const rt = yield* ThreadRuntimes,
          fake = yield* FakeAgentControl,
          store = yield* ThreadStore;
        yield* (yield* Orchestration).handoff(workspaceId, "user", {
          agent: "claude",
          model: "fake-haiku",
        });
        yield* waitSent(thread.id, 2);
        const before = yield* store.getThread(thread.id);
        expect((yield* rt.setMode(thread.id, "bypassPermissions").pipe(Effect.flip))._tag).toBe(
          "InvalidState",
        );
        expect(
          (yield* rt.setModel(thread.id, { agent: "codex", model: "fake-opus" }).pipe(Effect.flip))
            ._tag,
        ).toBe("InvalidState");
        expect((yield* rt.restartSession(thread.id).pipe(Effect.flip))._tag).toBe("InvalidState");
        expect(yield* rt.reloadSession(thread.id)).toBe("noSession");
        expect(yield* rt.mcpConfigChanged({ agent: "codex", always: true })).toEqual([]);
        expect(yield* rt.mcpConfigChanged({ agent: "claude", always: true })).toEqual([]);
        expect(fake.configReloads).toEqual([]);
        expect((yield* store.getThread(thread.id)).model).toEqual(before.model);
        expect((yield* store.getThread(thread.id)).mode).toBe(before.mode);
        expect(session.closed).toBe(false);
      }),
    );
  }),
);
