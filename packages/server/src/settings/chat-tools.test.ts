import { describe, expect, it } from "@effect/vitest";
import {
  AppToolError,
  modelText,
  USER_ONLY_SETTINGS,
  type ApprovalRequest,
  type ThreadId,
  type WorkspaceId,
} from "@gram/contracts";
import type { ToolAudience } from "@gram/agents";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { EventHub } from "../events/event-hub.ts";
import { Orchestration } from "../orchestration/service.ts";
import {
  atAutonomy,
  collectEvents,
  makeWorld,
  openOrchestrator,
  serverLayer,
  settle,
  spawn,
  waitReal,
  waitStatus,
  type Server,
  type World,
} from "../orchestration/test-harness.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { settingsAppToolsLayer } from "./chat-tools.ts";

/** The orchestration world with the settings tools registered over it. */
const inSettings = <A, E>(
  body: (world: World) => Effect.Effect<A, E, Server | Scope.Scope>,
  /** What the settings tools see of a service, in place of the server's own, for a test's timing. */
  around: {
    readonly hub?: Layer.Layer<EventHub, never, EventHub>;
    readonly orchestration?: Layer.Layer<Orchestration, never, Orchestration | ThreadStore>;
  } = {},
) =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const server = serverLayer(world);
        const hub = around.hub ?? Layer.empty;
        const orchestration = around.orchestration ?? Layer.empty;
        const context = yield* Layer.build(
          settingsAppToolsLayer().pipe(
            Layer.provide(Layer.mergeAll(hub, orchestration).pipe(Layer.provide(server))),
            Layer.provideMerge(server),
          ),
        );
        return yield* body(world).pipe(Effect.provide(context));
      }),
    );
  });

/** A tool as `audience` is bound it, with the registry's gate, as the HTTP MCP and Claude serve it. */
const gated = (threadId: ThreadId, audience: ToolAudience, name: string) =>
  Effect.gen(function* () {
    const registry = yield* AppToolRegistry;
    return registry.forTransport(threadId, audience).find((tool) => tool.descriptor.name === name);
  });

const call = (threadId: ThreadId, audience: ToolAudience, name: string, input: unknown) =>
  Effect.gen(function* () {
    const tool = yield* gated(threadId, audience, name);
    if (tool === undefined) return yield* Effect.die(new Error(`${name} isn't bound`));
    return yield* tool.run(input);
  });

/** The one card waiting in `threadId`. */
const cardIn = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const [card] = yield* waitReal(
      "the settings card",
      store.listRequests(threadId).pipe(Effect.map((all) => all.length === 1 && all)),
    );
    expect(card?.kind).toBe("approval");
    return card as ApprovalRequest;
  });

const answer = (threadId: ThreadId, card: ApprovalRequest, decision: "allow" | "deny") =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    yield* runtimes.respond(threadId, card.id, { kind: "approval", decision, scope: "once" });
  });

/** A plain thread the user is chatting with, outside any workspace. */
const plainThread = (world: World) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const thread = yield* runtimes.create({
      projectRoot: world.repo,
      checkout: { kind: "main", path: world.repo },
      title: "The user's own thread",
    });
    yield* waitStatus(thread.id, "idle");
    return thread;
  });

const noCard = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    yield* settle;
    expect(yield* store.listRequests(threadId)).toEqual([]);
  });

describe("settings_read", () => {
  it.effect("reads the caller's own scope, redacted", () =>
    inSettings((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const { thread, workspaceId } = yield* openOrchestrator(world);
        yield* store.updateSettings((settings) => ({
          ...settings,
          editor: { command: "/invented/secret-editor --wait" },
          agents: { ...settings.agents, defaultFolder: "/invented/private-folder" },
        }));
        yield* store.upsertProfile({
          id: "gw-1" as never,
          name: "Invented gateway",
          baseURL: "https://gateway.invalid/v1",
          keyRef: "profile:gw-1",
          models: [],
        });

        const read = (yield* call(thread.id, "orchestrator", "settings_read", {})) as {
          readonly app: ReadonlyArray<{ readonly key: string }>;
          readonly workspace: {
            readonly id: string;
            readonly settings: ReadonlyArray<{ readonly key: string; readonly value: unknown }>;
          };
          readonly userOnly: ReadonlyArray<{ readonly key: string; readonly value?: unknown }>;
        };
        const text = JSON.stringify(read);
        for (const secret of [
          "/invented/secret-editor",
          "/invented/private-folder",
          "gateway.invalid",
          "Invented gateway",
          "profile:gw-1",
        ]) {
          expect(text).not.toContain(secret);
        }
        expect(read.workspace.id).toBe(workspaceId);
        expect(read.workspace.settings).toContainEqual(
          expect.objectContaining({ key: "workspace.maxConcurrentWorkers", value: 10 }),
        );
        expect(read.app.map((row) => row.key)).toContain("appearance.mode");
        expect(read.userOnly).toContainEqual(
          expect.objectContaining({ key: "workspace.autonomy", value: "publish" }),
        );

        // Its own, named by name, is.
        const byName = (yield* call(thread.id, "orchestrator", "settings_read", {
          workspaceId: "shop",
        })) as { readonly workspace: { readonly id: string } };
        expect(byName.workspace.id).toBe(workspaceId);

        // Another workspace is not an orchestrator's to read.
        const other = yield* store.ensureProject({ root: world.dir, name: "elsewhere" });
        const orchestration = yield* Orchestration;
        const elsewhere = yield* orchestration.saveWorkspace({
          name: "Elsewhere",
          projectIds: [other.id],
          homeProjectId: other.id,
        });
        const refused = yield* call(thread.id, "orchestrator", "settings_read", {
          workspaceId: elsewhere.workspace.id,
        }).pipe(Effect.flip);
        expect(refused.message).toContain("only read and propose settings for your own workspace");

        // A plain thread has no workspace unless it names one, which it may.
        const plain = yield* plainThread(world);
        const alone = (yield* call(plain.id, "plain", "settings_read", {})) as object;
        expect(alone).not.toHaveProperty("workspace");
        const named = (yield* call(plain.id, "plain", "settings_read", {
          workspaceId: "elsewhere",
        })) as { readonly workspace: { readonly id: string } };
        expect(named.workspace.id).toBe(elsewhere.workspace.id);
      }),
    ),
  );
});

describe("settings_propose", () => {
  it.effect("pins the complete local-check recipe while its approval card waits", () =>
    inSettings((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const { thread } = yield* openOrchestrator(world);
        const current = () =>
          store.listProjects.pipe(
            Effect.map((projects) => projects.find((p) => p.id === thread.projectId)!),
          );
        const set = (field: string, value: unknown) =>
          Effect.gen(function* () {
            const before = yield* current();
            return yield* store.updateProjectLocalCheckAudited(
              before.id,
              [
                {
                  key: `project.localCheck.${field}`,
                  path: ["localCheck", field],
                  before: before.localCheck?.[field as "command" | "timeoutMs"],
                  after: value,
                },
              ],
              {
                at: 1,
                threadId: thread.id,
                proposerRole: "plain",
                scope: "project",
                approvedBy: "user",
                approvedAt: 1,
                changes: [],
                shown: [],
              },
              before.localCheckRevision!,
            );
          });
        yield* set("command", "make test");
        const changes = [
          { op: "set" as const, key: "project.localCheck.command", value: "cargo test" },
        ];
        const asked = yield* call(thread.id, "orchestrator", "settings_propose", { changes }).pipe(
          Effect.flip,
          Effect.forkScoped,
        );
        const card = yield* cardIn(thread.id);
        expect(JSON.stringify(card.input)).toContain("cargo test");
        expect((yield* current()).localCheck).toEqual({ command: "make test" });
        yield* set("timeoutMs", 120_000); // Not a changed field in the waiting card.
        const auditCount = (yield* store.listSettingsAudit(20)).length;
        yield* answer(thread.id, card, "allow");
        expect((yield* Fiber.join(asked)).message).toContain("changed while the card waited");
        expect((yield* current()).localCheck).toEqual({ command: "make test", timeoutMs: 120_000 });
        expect((yield* store.listSettingsAudit(20)).length).toBe(auditCount);
        const fresh = yield* call(thread.id, "orchestrator", "settings_propose", { changes }).pipe(
          Effect.forkScoped,
        );
        yield* answer(thread.id, yield* cardIn(thread.id), "allow");
        expect(yield* Fiber.join(fresh)).toMatchObject({ applied: true });
        expect((yield* current()).localCheck).toEqual({
          command: "cargo test",
          timeoutMs: 120_000,
        });
        expect((yield* store.listSettingsAudit(20)).length).toBe(auditCount + 1);
        const back = yield* call(thread.id, "orchestrator", "settings_propose", {
          changes: [{ op: "set", key: "project.localCheck.command", value: "make test" }],
        }).pipe(Effect.forkScoped);
        yield* answer(thread.id, yield* cardIn(thread.id), "allow");
        expect(yield* Fiber.join(back)).toMatchObject({ applied: true });
        expect((yield* current()).localCheck).toEqual({ command: "make test", timeoutMs: 120_000 });
        expect((yield* store.listSettingsAudit(20)).length).toBe(auditCount + 2);
      }),
    ),
  );
  it.effect("applies an approved workspace change through setCharter, and audits it", () =>
    inSettings((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const { thread, workspaceId } = yield* openOrchestrator(world);
        const asked = yield* call(thread.id, "orchestrator", "settings_propose", {
          reason: "The user wants fewer workers and a docs model.",
          changes: [
            { op: "set", key: "workspace.maxConcurrentWorkers", value: 4 },
            {
              op: "add",
              key: "workspace.workerModels",
              item: { agent: "claude", model: "fake-haiku", useFor: "docs" },
            },
          ],
        }).pipe(Effect.forkScoped);
        const card = yield* cardIn(thread.id);
        expect(card).toMatchObject({
          toolName: "mcp__gram__settings_propose",
          displayName: "Change settings",
          scopes: ["once"],
          description: "Change 3 settings in the workspace “shop”.",
        });
        expect(card.input).toMatchObject({
          scope: "workspace",
          workspace: { id: workspaceId, name: "shop" },
          reason: "The user wants fewer workers and a docs model.",
          rows: [
            {
              key: "workspace.maxConcurrentWorkers",
              label: "Max concurrent workers",
              before: "10",
              after: "4",
            },
            {
              key: "workspace.workerModels",
              label: "Worker model claude:fake-haiku",
              before: null,
              after: "claude:fake-haiku — docs",
            },
            {
              // Workers ran on the orchestrator's own model; from now on on the one listed.
              key: "workspace.workerModels",
              label: "Worker model used when none is named",
              before: `${modelText(thread.model)} (the orchestrator's own)`,
              after: "claude:fake-haiku",
            },
          ],
        });
        // Nothing has changed while the card waits.
        expect((yield* store.getWorkspace(workspaceId)).charter.maxConcurrentWorkers).toBe(10);

        yield* answer(thread.id, card, "allow");
        const result = (yield* Fiber.join(asked)) as { readonly applied: boolean };
        expect(result).toMatchObject({ applied: true, scope: "workspace" });
        const { charter } = yield* store.getWorkspace(workspaceId);
        expect(charter.maxConcurrentWorkers).toBe(4);
        expect(charter.workerModels).toEqual([
          { agent: "claude", model: "fake-haiku", useFor: "docs" },
        ]);
        // The autonomy the user set is untouched.
        expect(charter.autonomy).toBe("publish");

        const [audit] = yield* store.listSettingsAudit(5);
        expect(audit).toMatchObject({
          threadId: thread.id,
          proposerRole: "orchestrator",
          scope: "workspace",
          workspaceId,
          requestId: card.id,
          approvedBy: "user",
          reason: "The user wants fewer workers and a docs model.",
          // As stored, typed: not the card's words.
          changes: [
            { key: "workspace.maxConcurrentWorkers", before: 10, after: 4 },
            {
              key: "workspace.workerModels",
              before: null,
              after: [{ agent: "claude", model: "fake-haiku", useFor: "docs" }],
            },
          ],
          shown: card.input["rows"],
        });
        expect(audit!.at).toBeGreaterThanOrEqual(audit!.approvedAt);
        const events = yield* store.listOrchestrationEvents(workspaceId, 0);
        expect(events.filter((event) => event.kind === "settings")).toEqual([
          expect.objectContaining({
            data: expect.objectContaining({
              by: thread.id,
              approvedBy: "user",
              requestId: card.id,
            }),
          }),
        ]);
      }),
    ),
  );

  it.effect("applies an app preference by settings.set's path and tells every window", () =>
    inSettings((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const plain = yield* plainThread(world);
        const events = yield* collectEvents(["settings.changed"]);
        const asked = yield* call(plain.id, "plain", "settings_propose", {
          changes: [{ op: "set", key: "appearance.mode", value: "light" }],
        }).pipe(Effect.forkScoped);
        const card = yield* cardIn(plain.id);
        expect(card.input).toMatchObject({
          scope: "app",
          rows: [{ key: "appearance.mode", before: "dark", after: "light" }],
        });
        yield* answer(plain.id, card, "allow");
        yield* Fiber.join(asked);
        expect((yield* store.getSettings).appearance.mode).toBe("light");
        yield* settle;
        expect(events.map((event) => event.type)).toEqual(["settings.changed"]);
        const [audit] = yield* store.listSettingsAudit(1);
        expect(audit).toMatchObject({ threadId: plain.id, proposerRole: "plain", scope: "app" });
        expect(audit).not.toHaveProperty("workspaceId");
      }),
    ),
  );

  it.effect("reports a denial and changes nothing", () =>
    inSettings((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const { thread, workspaceId } = yield* openOrchestrator(world);
        const asked = yield* call(thread.id, "orchestrator", "settings_propose", {
          changes: [{ op: "set", key: "workspace.maxConcurrentWorkers", value: 2 }],
        }).pipe(Effect.flip, Effect.forkScoped);
        yield* answer(thread.id, yield* cardIn(thread.id), "deny");
        const error = yield* Fiber.join(asked);
        expect(error).toBeInstanceOf(AppToolError);
        expect(error.message).toBe("The user declined the settings change; nothing changed.");
        expect((yield* store.getWorkspace(workspaceId)).charter.maxConcurrentWorkers).toBe(10);
        expect(yield* store.listSettingsAudit(5)).toEqual([]);
      }),
    ),
  );

  it.effect("withdraws the card when it expires and changes nothing", () =>
    inSettings((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const { thread, workspaceId } = yield* openOrchestrator(world);
        const asked = yield* call(thread.id, "orchestrator", "settings_propose", {
          changes: [{ op: "set", key: "workspace.maxConcurrentWorkers", value: 2 }],
        }).pipe(Effect.flip, Effect.forkScoped);
        yield* cardIn(thread.id);
        yield* TestClock.adjust("16 minutes");
        const error = yield* Fiber.join(asked);
        expect(error.message).toContain("The settings proposal expired");
        expect(error.message).toContain("nothing changed");
        yield* noCard(thread.id);
        expect((yield* store.getWorkspace(workspaceId)).charter.maxConcurrentWorkers).toBe(10);
        expect(yield* store.listSettingsAudit(5)).toEqual([]);
      }),
    ),
  );

  it.effect("refuses invalid changes before any card", () =>
    inSettings((world) =>
      Effect.gen(function* () {
        const { thread } = yield* openOrchestrator(world);
        for (const [changes, says] of [
          [[{ op: "set", key: "workspace.maxConcurrentWorkers", value: 0 }], "at least 1"],
          [[{ op: "set", key: "appearance.mode", value: "purple" }], "appearance.mode"],
          [[{ op: "set", key: "workspace.nonsense", value: 1 }], "isn't settable by chat"],
          [
            [
              {
                op: "add",
                key: "workspace.workerModels",
                item: { agent: "claude", model: "no-such-model" },
              },
            ],
            "claude has no model no-such-model",
          ],
          [
            [
              { op: "set", key: "appearance.mode", value: "light" },
              { op: "set", key: "workspace.maxConcurrentWorkers", value: 3 },
            ],
            "not both",
          ],
        ] as const) {
          const error = yield* call(thread.id, "orchestrator", "settings_propose", {
            changes,
          }).pipe(Effect.flip);
          expect(error.message).toContain(says);
        }
        // Input that doesn't decode is refused too, an unknown argument included.
        const excess = yield* call(thread.id, "orchestrator", "settings_propose", {
          changes: [{ op: "set", key: "appearance.mode", value: "light" }],
          approve: true,
        }).pipe(Effect.flip);
        expect(excess.message).toContain("Invalid input");
        yield* noCard(thread.id);
      }),
    ),
  );

  it.effect("refuses every never-settable key, even with approval on offer", () =>
    inSettings((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const { thread, workspaceId } = yield* openOrchestrator(world);
        const plain = yield* plainThread(world);
        const before = yield* store.getWorkspace(workspaceId);
        const settingsBefore = yield* store.getSettings;
        for (const { key, via } of USER_ONLY_SETTINGS) {
          for (const [caller, audience] of [
            [thread.id, "orchestrator"],
            [plain.id, "plain"],
          ] as const) {
            const error = yield* call(caller, audience, "settings_propose", {
              changes: [{ op: "set", key, value: "full" }],
            }).pipe(Effect.flip);
            expect(error.message, key).toContain(
              via === undefined ? "no agent may change it" : `propose it with ${via}`,
            );
          }
        }
        yield* noCard(thread.id);
        yield* noCard(plain.id);
        expect(yield* store.getWorkspace(workspaceId)).toEqual(before);
        expect(yield* store.getSettings).toEqual(settingsBefore);
      }),
    ),
  );

  it.effect("asks at full autonomy and in Bypass, for the call alone", () =>
    inSettings((world) =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const { thread } = yield* openOrchestrator(world);
        yield* atAutonomy(thread, "full");
        yield* runtimes.updateThread(thread.id, (t) => ({ ...t, mode: "bypassPermissions" }));
        for (let round = 0; round < 2; round++) {
          const asked = yield* call(thread.id, "orchestrator", "settings_propose", {
            changes: [{ op: "set", key: "workspace.maxConcurrentWorkers", value: 3 + round }],
          }).pipe(Effect.flip, Effect.forkScoped);
          const card = yield* cardIn(thread.id);
          expect(card.scopes).toEqual(["once"]);
          yield* answer(thread.id, card, "deny");
          expect((yield* Fiber.join(asked)).message).toContain("declined");
        }
      }),
    ),
  );

  it.effect("lets a worker read but never propose", () =>
    inSettings((world) =>
      Effect.gen(function* () {
        const registry = yield* AppToolRegistry;
        const { session } = yield* openOrchestrator(world);
        const { thread: worker } = yield* spawn(session, { feature: "docs" });
        const bound = registry.forTransport(worker.id, "worker").map((t) => t.descriptor.name);
        expect(bound).toContain("settings_read");
        expect(bound).not.toContain("settings_propose");
        const read = (yield* call(worker.id, "worker", "settings_read", {})) as {
          readonly workspace: { readonly id: WorkspaceId };
          readonly howToChange: string;
        };
        expect(read.workspace.id).toBe(worker.workspaceId);
        expect(read.howToChange).toContain("Workers can read Gram's settings but not propose");

        // A binding made for another role doesn't let the worker through: the role is read anew.
        const error = yield* call(worker.id, "orchestrator", "settings_propose", {
          changes: [{ op: "set", key: "workspace.maxConcurrentWorkers", value: 50 }],
        }).pipe(Effect.flip);
        expect(error.message).toContain("Workers can read Gram's settings but not propose");
        yield* noCard(worker.id);
      }),
    ),
  );

  it.effect("refuses what was approved when the settings moved meanwhile", () =>
    inSettings((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const orchestration = yield* Orchestration;
        const { thread, workspaceId } = yield* openOrchestrator(world);
        const asked = yield* call(thread.id, "orchestrator", "settings_propose", {
          changes: [{ op: "set", key: "workspace.maxConcurrentWorkers", value: 4 }],
        }).pipe(Effect.flip, Effect.forkScoped);
        const card = yield* cardIn(thread.id);
        const standing = yield* store.getWorkspace(workspaceId);
        yield* orchestration.setCharter(workspaceId, {
          ...standing.charter,
          maxConcurrentWorkers: 7,
        });
        yield* answer(thread.id, card, "allow");
        expect((yield* Fiber.join(asked)).message).toContain("changed while the card waited");
        expect((yield* store.getWorkspace(workspaceId)).charter.maxConcurrentWorkers).toBe(7);
        expect(yield* store.listSettingsAudit(5)).toEqual([]);
      }),
    ),
  );

  it.effect("refuses pausing and resuming from every role, before any card", () => {
    // Re-review R1: a resume of the user's pause reached changePaused through an approved card.
    const calls: Array<string> = [];
    const spied = Layer.effect(
      Orchestration,
      Effect.gen(function* () {
        const orchestration = yield* Orchestration;
        return Orchestration.of({
          ...orchestration,
          changePaused: (...args) => {
            calls.push("changePaused");
            return orchestration.changePaused(...args);
          },
          setPaused: (...args) => {
            calls.push("setPaused");
            return orchestration.setPaused(...args);
          },
        });
      }),
    );
    return inSettings(
      (world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const orchestration = yield* Orchestration;
          const { thread, session, workspaceId } = yield* openOrchestrator(world);
          const { thread: worker } = yield* spawn(session, { feature: "docs" });
          const plain = yield* plainThread(world);
          for (const pause of [false, true]) {
            // The user's own pause path is the UI's, and stays.
            yield* orchestration.setPaused(workspaceId, pause);
            const before = (yield* store.getWorkspace(workspaceId)).paused;
            for (const [caller, audience, says] of [
              [thread.id, "orchestrator", "only the user pauses or resumes"],
              [plain.id, "plain", "only the user pauses or resumes"],
              [worker.id, "orchestrator", "Workers can read Gram's settings but not propose"],
            ] as const) {
              const error = yield* call(caller, audience, "settings_propose", {
                workspaceId,
                changes: [{ op: "set", key: "workspace.paused", value: !pause }],
              }).pipe(Effect.flip);
              expect(error.message, `${audience} ${pause}`).toContain(says);
              yield* noCard(caller);
            }
            expect((yield* store.getWorkspace(workspaceId)).paused).toEqual(before);
          }
          // The worker has no propose tool at all.
          const registry = yield* AppToolRegistry;
          expect(
            registry.forTransport(worker.id, "worker").map((tool) => tool.descriptor.name),
          ).not.toContain("settings_propose");
          expect(calls).toEqual([]);
          expect(yield* store.listSettingsAudit(5)).toEqual([]);
        }),
      { orchestration: spied },
    );
  });

  it.effect("applies to the workspace the card named, whatever takes its name meanwhile", () =>
    inSettings((world) =>
      Effect.gen(function* () {
        // Review P1: A is proposed for by name; while the card waits A is renamed and B takes the
        // name. Before the fix the approval changed B.
        const store = yield* ThreadStore;
        const orchestration = yield* Orchestration;
        const plain = yield* plainThread(world);
        const { workspaceId: a } = yield* openOrchestrator(world);
        const standing = yield* store.getWorkspace(a);
        const name = standing.workspace.name;
        const asked = yield* call(plain.id, "plain", "settings_propose", {
          workspaceId: name,
          changes: [{ op: "set", key: "workspace.maxConcurrentWorkers", value: 4 }],
        }).pipe(Effect.forkScoped);
        const card = yield* cardIn(plain.id);
        expect(card.input).toMatchObject({ workspace: { id: a, name } });
        yield* orchestration.saveWorkspace({
          id: a,
          name: `${name} (old)`,
          projectIds: standing.workspace.projectIds,
          homeProjectId: standing.workspace.homeProjectId,
        });
        const other = yield* store.ensureProject({ root: world.dir, name: "elsewhere" });
        const b = yield* orchestration.saveWorkspace({
          name,
          projectIds: [other.id],
          homeProjectId: other.id,
        });
        expect(b.charter.maxConcurrentWorkers).toBe(10);
        yield* answer(plain.id, card, "allow");
        yield* Fiber.join(asked);
        expect((yield* store.getWorkspace(a)).charter.maxConcurrentWorkers).toBe(4);
        expect((yield* store.getWorkspace(b.workspace.id)).charter.maxConcurrentWorkers).toBe(10);
      }),
    ),
  );

  it.effect("keeps the autonomy the user lowered just before the approved write", () => {
    // Review P1: the whole charter read before the user's edit was written back over it. The
    // user's edit lands at the last moment: as the tool's write to the workspace begins.
    const lowered = { done: false };
    const userFirst = Layer.effect(
      Orchestration,
      Effect.gen(function* () {
        const orchestration = yield* Orchestration;
        const store = yield* ThreadStore;
        const lowerFirst = (workspaceId: WorkspaceId) =>
          Effect.gen(function* () {
            if (lowered.done) return;
            lowered.done = true;
            const { charter } = yield* store.getWorkspace(workspaceId);
            yield* orchestration.setCharter(workspaceId, {
              ...charter,
              autonomy: "supervised",
              workerMode: "default",
            });
          }).pipe(Effect.orDie);
        return Orchestration.of({
          ...orchestration,
          setCharter: (workspaceId, charter) =>
            lowerFirst(workspaceId).pipe(
              Effect.andThen(orchestration.setCharter(workspaceId, charter)),
            ),
          changeCharter: (workspaceId, writes, audit) =>
            lowerFirst(workspaceId).pipe(
              Effect.andThen(orchestration.changeCharter(workspaceId, writes, audit)),
            ),
        });
      }),
    );
    return inSettings(
      (world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const { thread, workspaceId } = yield* openOrchestrator(world);
          const asked = yield* call(thread.id, "orchestrator", "settings_propose", {
            changes: [{ op: "set", key: "workspace.maxConcurrentWorkers", value: 4 }],
          }).pipe(Effect.forkScoped);
          yield* answer(thread.id, yield* cardIn(thread.id), "allow");
          yield* Fiber.join(asked);
          expect(lowered.done).toBe(true);
          const { charter } = yield* store.getWorkspace(workspaceId);
          expect(charter).toMatchObject({
            maxConcurrentWorkers: 4,
            autonomy: "supervised",
            workerMode: "default",
          });
          const [audit] = yield* store.listSettingsAudit(5);
          expect(audit?.changes).toEqual([
            { key: "workspace.maxConcurrentWorkers", before: 10, after: 4 },
          ]);
        }),
      { orchestration: userFirst },
    );
  });

  it.effect("refuses an effort approved for a model the user has since replaced", () =>
    inSettings((world) =>
      Effect.gen(function* () {
        // Review P2: the old card set its effort on the new model, which was never checked.
        const store = yield* ThreadStore;
        const orchestration = yield* Orchestration;
        const { thread, workspaceId } = yield* openOrchestrator(world);
        const standing = yield* store.getWorkspace(workspaceId);
        yield* orchestration.setCharter(workspaceId, {
          ...standing.charter,
          orchestratorModel: { agent: "claude", model: "fake-opus", variant: "low" },
        });
        const asked = yield* call(thread.id, "orchestrator", "settings_propose", {
          changes: [{ op: "set", key: "workspace.orchestratorEffort", value: "high" }],
        }).pipe(Effect.flip, Effect.forkScoped);
        const card = yield* cardIn(thread.id);
        const replaced = { agent: "claude", model: "unlisted-model", variant: "low" } as const;
        yield* orchestration.setCharter(workspaceId, {
          ...(yield* store.getWorkspace(workspaceId)).charter,
          orchestratorModel: replaced,
        });
        yield* answer(thread.id, card, "allow");
        expect((yield* Fiber.join(asked)).message).toContain("changed while the card waited");
        expect((yield* store.getWorkspace(workspaceId)).charter.orchestratorModel).toEqual(
          replaced,
        );
        expect(yield* store.listSettingsAudit(5)).toEqual([]);
        // The card showed the model the effort is stored on, which is what it held still.
        expect(card.input["rows"]).toEqual([
          {
            key: "workspace.orchestratorModel",
            label: "Orchestrator model",
            before: "claude:fake-opus · low",
            after: "claude:fake-opus · high",
          },
        ]);
      }),
    ),
  );

  it.effect("audits a change that was committed even when the call is cancelled after it", () => {
    // Review P1: the call was interrupted between the settings write and its separate audit.
    const reached = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const barrier = Layer.effect(
      EventHub,
      Effect.gen(function* () {
        const hub = yield* EventHub;
        return EventHub.of({
          ...hub,
          publish: (event) =>
            event.type === "settings.changed"
              ? Deferred.succeed(reached, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(hub.publish(event)),
                )
              : hub.publish(event),
        });
      }),
    );
    return inSettings(
      (world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const plain = yield* plainThread(world);
          const asked = yield* call(plain.id, "plain", "settings_propose", {
            changes: [{ op: "set", key: "appearance.mode", value: "light" }],
          }).pipe(Effect.forkScoped);
          yield* answer(plain.id, yield* cardIn(plain.id), "allow");
          yield* Deferred.await(reached);
          // The caller goes away after the write, while what it sets off is still running.
          const interrupting = yield* Fiber.interrupt(asked).pipe(Effect.forkScoped);
          // The interrupt is delivered before the barrier lifts: a call that can be cut off here
          // ends now, its audit unwritten.
          for (let turn = 0; turn < 100; turn++) yield* Effect.yieldNow;
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(interrupting);
          expect((yield* store.getSettings).appearance.mode).toBe("light");
          const [audit] = yield* store.listSettingsAudit(5);
          expect(audit).toMatchObject({
            threadId: plain.id,
            scope: "app",
            changes: [{ key: "appearance.mode", before: "dark", after: "light" }],
          });
        }),
      { hub: barrier },
    );
  });

  it.effect("shows and audits a worker model set to Standard speed", () =>
    inSettings((world) =>
      Effect.gen(function* () {
        // Review P2: an explicit Standard speed read like an inherited one, so the card showed
        // only the limit while both were applied.
        const store = yield* ThreadStore;
        const orchestration = yield* Orchestration;
        const { thread, workspaceId } = yield* openOrchestrator(world);
        yield* orchestration.setCharter(workspaceId, {
          ...(yield* store.getWorkspace(workspaceId)).charter,
          workerModels: [{ agent: "claude", model: "fake-opus" }],
        });
        const asked = yield* call(thread.id, "orchestrator", "settings_propose", {
          changes: [
            { op: "set", key: "workspace.maxConcurrentWorkers", value: 4 },
            {
              op: "update",
              key: "workspace.workerModels",
              match: "claude:fake-opus",
              item: { speed: "standard" },
            },
          ],
        }).pipe(Effect.forkScoped);
        const card = yield* cardIn(thread.id);
        expect(card.input["rows"]).toContainEqual({
          key: "workspace.workerModels",
          label: "Worker model claude:fake-opus",
          before: "claude:fake-opus",
          after: "claude:fake-opus · standard",
        });
        yield* answer(thread.id, card, "allow");
        yield* Fiber.join(asked);
        const [audit] = yield* store.listSettingsAudit(1);
        expect(audit?.changes).toContainEqual({
          key: "workspace.workerModels",
          before: [{ agent: "claude", model: "fake-opus" }],
          after: [{ agent: "claude", model: "fake-opus", speed: "standard" }],
        });
      }),
    ),
  );

  it.effect("refuses the approval when the orchestrator's workspace changed meanwhile", () =>
    inSettings((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const runtimes = yield* ThreadRuntimes;
        const orchestration = yield* Orchestration;
        const { thread, workspaceId } = yield* openOrchestrator(world);
        const asked = yield* call(thread.id, "orchestrator", "settings_propose", {
          changes: [{ op: "set", key: "workspace.maxConcurrentWorkers", value: 4 }],
        }).pipe(Effect.flip, Effect.forkScoped);
        const card = yield* cardIn(thread.id);
        const other = yield* store.ensureProject({ root: world.dir, name: "elsewhere" });
        const elsewhere = yield* orchestration.saveWorkspace({
          name: "Elsewhere",
          projectIds: [other.id],
          homeProjectId: other.id,
        });
        yield* runtimes.updateThread(thread.id, (t) => ({
          ...t,
          workspaceId: elsewhere.workspace.id,
        }));
        yield* answer(thread.id, card, "allow");
        expect((yield* Fiber.join(asked)).message).toContain("changed while the card waited");
        expect((yield* store.getWorkspace(workspaceId)).charter.maxConcurrentWorkers).toBe(10);
        expect(
          (yield* store.getWorkspace(elsewhere.workspace.id)).charter.maxConcurrentWorkers,
        ).toBe(10);
        expect(yield* store.listSettingsAudit(5)).toEqual([]);
      }),
    ),
  );

  it.effect("refuses clearing a model override once the default it showed has changed", () =>
    inSettings((world) =>
      Effect.gen(function* () {
        // Re-review R2: the card promised claude:fake-haiku (default); the approval then left the
        // workspace on whatever the app default had become.
        const store = yield* ThreadStore;
        const orchestration = yield* Orchestration;
        const { thread, workspaceId } = yield* openOrchestrator(world);
        yield* store.updateSettings((settings) => ({
          ...settings,
          agents: { ...settings.agents, defaultModel: { agent: "claude", model: "fake-haiku" } },
        }));
        yield* orchestration.setCharter(workspaceId, {
          ...(yield* store.getWorkspace(workspaceId)).charter,
          orchestratorModel: { agent: "claude", model: "fake-opus" },
        });
        const asked = yield* call(thread.id, "orchestrator", "settings_propose", {
          changes: [{ op: "set", key: "workspace.orchestratorModel", value: null }],
        }).pipe(Effect.flip, Effect.forkScoped);
        const card = yield* cardIn(thread.id);
        yield* store.updateSettings((settings) => ({
          ...settings,
          agents: { ...settings.agents, defaultModel: { agent: "codex", model: "fake-opus" } },
        }));
        yield* answer(thread.id, card, "allow");
        expect((yield* Fiber.join(asked)).message).toContain("changed while the card waited");
        expect((yield* store.getWorkspace(workspaceId)).charter.orchestratorModel).toEqual({
          agent: "claude",
          model: "fake-opus",
        });
        expect(yield* store.listSettingsAudit(5)).toEqual([]);
        expect(card.input["rows"]).toEqual([
          {
            key: "workspace.orchestratorModel",
            label: "Orchestrator model",
            before: "claude:fake-opus",
            after: "claude:fake-haiku (default)",
          },
        ]);
      }),
    ),
  );

  it.effect("clears a model override when the default it showed still holds", () =>
    inSettings((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const orchestration = yield* Orchestration;
        const { thread, workspaceId } = yield* openOrchestrator(world);
        yield* store.updateSettings((settings) => ({
          ...settings,
          agents: { ...settings.agents, defaultModel: { agent: "claude", model: "fake-haiku" } },
        }));
        yield* orchestration.setCharter(workspaceId, {
          ...(yield* store.getWorkspace(workspaceId)).charter,
          orchestratorModel: { agent: "claude", model: "fake-opus" },
        });
        const asked = yield* call(thread.id, "orchestrator", "settings_propose", {
          changes: [{ op: "set", key: "workspace.orchestratorModel", value: null }],
        }).pipe(Effect.forkScoped);
        yield* answer(thread.id, yield* cardIn(thread.id), "allow");
        yield* Fiber.join(asked);
        expect((yield* store.getWorkspace(workspaceId)).charter).not.toHaveProperty(
          "orchestratorModel",
        );
      }),
    ),
  );

  it.effect("shows the order and fallback a roster change brings, beside another row", () =>
    inSettings((world) =>
      Effect.gen(function* () {
        // Re-review R3: the card showed only the note edit, while the order and so the fallback
        // worker model changed too.
        const store = yield* ThreadStore;
        const orchestration = yield* Orchestration;
        const { thread, workspaceId } = yield* openOrchestrator(world);
        yield* orchestration.setCharter(workspaceId, {
          ...(yield* store.getWorkspace(workspaceId)).charter,
          workerModels: [
            { agent: "claude", model: "fake-haiku" },
            { agent: "codex", model: "fake-haiku" },
          ],
        });
        const asked = yield* call(thread.id, "orchestrator", "settings_propose", {
          changes: [
            { op: "remove", key: "workspace.workerModels", match: "claude:fake-haiku" },
            {
              op: "add",
              key: "workspace.workerModels",
              item: { agent: "claude", model: "fake-haiku" },
            },
            {
              op: "update",
              key: "workspace.workerModels",
              match: "codex:fake-haiku",
              item: { useFor: "reviews" },
            },
          ],
        }).pipe(Effect.forkScoped);
        const card = yield* cardIn(thread.id);
        expect(card.input["rows"]).toEqual([
          {
            key: "workspace.workerModels",
            label: "Worker model codex:fake-haiku",
            before: "codex:fake-haiku",
            after: "codex:fake-haiku — reviews",
          },
          {
            key: "workspace.workerModels",
            label: "Worker model order",
            before: "claude:fake-haiku, codex:fake-haiku",
            after: "codex:fake-haiku, claude:fake-haiku",
          },
          {
            key: "workspace.workerModels",
            label: "Worker model used when none is named",
            before: "claude:fake-haiku",
            after: "codex:fake-haiku",
          },
        ]);
        yield* answer(thread.id, card, "allow");
        yield* Fiber.join(asked);
        const [audit] = yield* store.listSettingsAudit(1);
        expect(audit?.shown).toEqual(card.input["rows"]);
      }),
    ),
  );
});

describe("project check settings by chat", () => {
  it.effect("resolves names within the workspace and shows the project root on approval", () =>
    inSettings((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        // This earlier matching name is outside the workspace.
        yield* store.ensureProject({ root: "/invented/outside", name: "shared-name" });
        const { thread, workspaceId } = yield* openOrchestrator(world);
        const target = yield* store.ensureProject({
          root: "/invented/inside",
          name: "shared-name",
        });
        yield* store.updateWorkspace(workspaceId, (state) => ({
          ...state,
          workspace: { ...state.workspace, projectIds: [...state.workspace.projectIds, target.id] },
        }));
        expect(
          yield* call(thread.id, "orchestrator", "settings_read", { projectId: "SHARED-NAME" }),
        ).toMatchObject({ project: { id: target.id } });
        const asked = yield* call(thread.id, "orchestrator", "settings_propose", {
          projectId: "shared-name",
          changes: [{ op: "set", key: "project.localCheck.command", value: "make test" }],
        }).pipe(Effect.flip, Effect.forkScoped);
        const card = yield* cardIn(thread.id);
        expect(card.input).toMatchObject({ project: { id: target.id, root: target.root } });
        expect(card.description).toContain(target.root);
        yield* answer(thread.id, card, "deny");
        yield* Fiber.join(asked);
      }),
    ),
  );
  it.effect("requires approval, pins the project, audits the write and reads the command", () =>
    inSettings((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const { thread } = yield* openOrchestrator(world);
        const read = yield* call(thread.id, "orchestrator", "settings_read", {});
        expect(read).toMatchObject({
          project: {
            id: thread.projectId,
            settings: expect.arrayContaining([
              {
                key: "project.localCheck.command",
                label: "Local check command",
                tier: "project",
                value: expect.stringContaining("off"),
              },
            ]),
          },
        });
        const input = {
          changes: [
            { op: "set", key: "project.localCheck.command", value: "make test" },
            { op: "set", key: "project.localCheck.setup", value: "make deps" },
            { op: "set", key: "project.localCheck.timeoutMs", value: 60_000 },
          ],
        };
        const asked = yield* call(thread.id, "orchestrator", "settings_propose", input).pipe(
          Effect.forkScoped,
        );
        const card = yield* cardIn(thread.id);
        expect(card.input).toMatchObject({
          scope: "project",
          project: { id: thread.projectId },
          rows: expect.arrayContaining([
            expect.objectContaining({ key: "project.localCheck.command", after: "make test" }),
          ]),
        });
        expect(
          (yield* store.listProjects).find((p) => p.id === thread.projectId)?.localCheck,
        ).toBeUndefined();
        yield* answer(thread.id, card, "allow");
        expect(yield* Fiber.join(asked)).toMatchObject({ applied: true, scope: "project" });
        expect(
          (yield* store.listProjects).find((p) => p.id === thread.projectId)?.localCheck,
        ).toEqual({ command: "make test", setup: "make deps", timeoutMs: 60_000 });
        expect((yield* store.listSettingsAudit(1))[0]).toMatchObject({
          scope: "project",
          projectId: thread.projectId,
          requestId: card.id,
        });
        expect(yield* call(thread.id, "orchestrator", "settings_read", {})).toMatchObject({
          project: {
            settings: expect.arrayContaining([
              expect.objectContaining({ key: "project.localCheck.command", value: "make test" }),
            ]),
          },
        });
        // Denial leaves the existing gate in place.
        const denied = yield* call(thread.id, "orchestrator", "settings_propose", {
          changes: [{ op: "set", key: "project.localCheck.command", value: null }],
        }).pipe(Effect.flip, Effect.forkScoped);
        yield* answer(thread.id, yield* cardIn(thread.id), "deny");
        expect((yield* Fiber.join(denied)).message).toContain("declined");
        expect(
          (yield* store.listProjects).find((p) => p.id === thread.projectId)?.localCheck?.command,
        ).toBe("make test");
      }),
    ),
  );
  it.effect("refuses stale approved project writes", () =>
    inSettings((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const { thread } = yield* openOrchestrator(world);
        const asked = yield* call(thread.id, "orchestrator", "settings_propose", {
          changes: [{ op: "set", key: "project.localCheck.command", value: "make test" }],
        }).pipe(Effect.flip, Effect.forkScoped);
        const card = yield* cardIn(thread.id);
        yield* store.updateProjectLocalCheckAudited(
          thread.projectId,
          [
            {
              key: "project.localCheck.command",
              path: ["localCheck", "command"],
              before: undefined,
              after: "cargo test",
            },
          ],
          {
            at: 1,
            threadId: thread.id,
            proposerRole: "plain",
            scope: "project",
            approvedBy: "user",
            approvedAt: 1,
            changes: [],
            shown: [],
          },
          (yield* store.listProjects).find((p) => p.id === thread.projectId)!.localCheckRevision!,
        );
        yield* answer(thread.id, card, "allow");
        expect((yield* Fiber.join(asked)).message).toContain("changed while the card waited");
        expect(
          (yield* store.listProjects).find((p) => p.id === thread.projectId)?.localCheck?.command,
        ).toBe("cargo test");
      }),
    ),
  );
});
