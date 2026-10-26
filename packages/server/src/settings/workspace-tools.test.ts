import { describe, expect, it } from "@effect/vitest";
import {
  AppToolError,
  type ApprovalRequest,
  type ThreadId,
  type WorkspaceId,
  type WorkspaceProposalCard,
} from "@gram/contracts";
import type { ToolAudience } from "@gram/agents";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { makeRepo, run } from "../git/test-repo.ts";
import { Orchestration } from "../orchestration/service.ts";
import {
  atAutonomy,
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
import { workspaceAppToolsLayer } from "./workspace-tools.ts";

/** The orchestration world with the workspace tools registered over it. */
const inWorkspaces = <A, E>(body: (world: World) => Effect.Effect<A, E, Server | Scope.Scope>) =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const server = serverLayer(world);
        const context = yield* Layer.build(
          workspaceAppToolsLayer().pipe(Layer.provideMerge(server)),
        );
        return yield* body(world).pipe(Effect.provide(context));
      }),
    );
  });

/** A tool as `audience` is bound it, with the registry's gate, as the HTTP MCP and Claude serve it. */
const call = (threadId: ThreadId, audience: ToolAudience, name: string, input: unknown) =>
  Effect.gen(function* () {
    const registry = yield* AppToolRegistry;
    const tool = registry
      .forTransport(threadId, audience)
      .find((each) => each.descriptor.name === name);
    if (tool === undefined) return yield* Effect.die(new Error(`${name} isn't bound`));
    return yield* tool.run(input);
  });

/** The one card waiting in `threadId`. */
const cardIn = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const [card] = yield* waitReal(
      "the workspace card",
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

const noCard = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    yield* settle;
    expect(yield* store.listRequests(threadId)).toEqual([]);
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

/** A repository Gram doesn't know yet, at `<world>/<name>/repo`. */
const newRepo = (world: World, name: string) => makeRepo(nodePath.join(world.dir, name));

const workspaceNamed = (name: string) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    return (yield* store.listWorkspaces).find((state) => state.workspace.name === name);
  });

const projectAt = (root: string) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    return (yield* store.listProjects).find((project) => project.root === root);
  });

describe("workspace_create", () => {
  it.effect("creates exactly what the card showed, registering a new repository", () =>
    inWorkspaces((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const known = yield* store.ensureProject({ root: world.repo, name: "shop" });
        const fresh = newRepo(world, "warehouse");
        const plain = yield* plainThread(world);
        const asked = yield* call(plain.id, "plain", "workspace_create", {
          name: "Platform",
          projects: [world.repo, fresh],
          home: fresh,
          autonomy: "supervised",
          workerMode: "acceptEdits",
          settings: [
            { op: "set", key: "workspace.maxConcurrentWorkers", value: 3 },
            { op: "set", key: "workspace.mergeReviewPolicy", value: "bot" },
          ],
          reason: "The handoff README asks for it.",
        }).pipe(Effect.forkScoped);
        const card = yield* cardIn(plain.id);
        expect(card).toMatchObject({
          toolName: "mcp__gram__workspace_create",
          displayName: "Create workspace",
          description: "Create the workspace “Platform” with 2 projects.",
          suggestions: [],
          scopes: ["once"],
        });
        const shown = card.input as unknown as WorkspaceProposalCard;
        expect(shown).toMatchObject({
          action: "create",
          workspace: { name: "Platform" },
          reason: "The handoff README asks for it.",
          projects: [
            { root: world.repo, name: "shop", change: "added" },
            { root: fresh, name: "repo", change: "added", unregistered: true, home: true },
          ],
        });
        expect(shown.projects[0]).not.toHaveProperty("unregistered");
        expect(shown.rows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              label: "Autonomy",
              before: null,
              after: expect.stringMatching(/^Supervised/),
            }),
            expect.objectContaining({ label: "Worker mode", after: "Accept edits" }),
            expect.objectContaining({ label: "Max concurrent workers", after: "3" }),
            expect.objectContaining({ label: "Merge review policy", after: "bot" }),
          ]),
        );
        // Nothing exists while the card waits, not even the new project.
        expect(yield* workspaceNamed("Platform")).toBeUndefined();
        expect(yield* projectAt(fresh)).toBeUndefined();

        yield* answer(plain.id, card, "allow");
        const result = (yield* Fiber.join(asked)) as {
          readonly applied: boolean;
          readonly workspace: { readonly id: WorkspaceId };
        };
        expect(result.applied).toBe(true);
        const registered = (yield* projectAt(fresh))!;
        const state = (yield* workspaceNamed("Platform"))!;
        expect(state.workspace).toMatchObject({
          id: result.workspace.id,
          projectIds: [known.id, registered.id],
          homeProjectId: registered.id,
        });
        expect(state.charter).toMatchObject({
          autonomy: "supervised",
          workerMode: "acceptEdits",
          maxConcurrentWorkers: 3,
          mergeReviewPolicy: "bot",
        });
        const [audit] = yield* store.listSettingsAudit(5);
        expect(audit).toMatchObject({
          threadId: plain.id,
          proposerRole: "plain",
          scope: "workspace",
          workspaceId: state.workspace.id,
          requestId: card.id,
          approvedBy: "user",
          reason: "The handoff README asks for it.",
        });
        expect(audit!.changes).toEqual(
          expect.arrayContaining([
            { key: "workspace.name", before: null, after: "Platform" },
            { key: "workspace.autonomy", before: null, after: "supervised" },
          ]),
        );
      }),
    ),
  );

  it.effect("opens the new workspace's orchestrator when the card says so", () =>
    inWorkspaces((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const plain = yield* plainThread(world);
        const asked = yield* call(plain.id, "plain", "workspace_create", {
          name: "Docs",
          projects: [world.repo],
          openOrchestrator: true,
        }).pipe(Effect.forkScoped);
        const card = yield* cardIn(plain.id);
        expect((card.input as unknown as WorkspaceProposalCard).rows).toContainEqual(
          expect.objectContaining({ label: "Open its orchestrator", after: "yes" }),
        );
        yield* answer(plain.id, card, "allow");
        const result = (yield* Fiber.join(asked)) as {
          readonly workspace: { readonly id: WorkspaceId };
          readonly orchestratorThreadId: ThreadId;
        };
        const orchestrator = yield* store.getThread(result.orchestratorThreadId);
        expect(orchestrator).toMatchObject({
          role: "orchestrator",
          workspaceId: result.workspace.id,
        });
      }),
    ),
  );

  it.effect("changes nothing when the user declines", () =>
    inWorkspaces((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const fresh = newRepo(world, "warehouse");
        const plain = yield* plainThread(world);
        const before = yield* store.listWorkspaces;
        const projectsBefore = yield* store.listProjects;
        const asked = yield* call(plain.id, "plain", "workspace_create", {
          name: "Platform",
          projects: [fresh],
          autonomy: "full",
          workerMode: "bypassPermissions",
        }).pipe(Effect.flip, Effect.forkScoped);
        yield* answer(plain.id, yield* cardIn(plain.id), "deny");
        const error = yield* Fiber.join(asked);
        expect(error).toBeInstanceOf(AppToolError);
        expect(error.message).toBe("The user declined the workspace change; nothing changed.");
        expect(yield* store.listWorkspaces).toEqual(before);
        expect(yield* store.listProjects).toEqual(projectsBefore);
        expect(yield* store.listSettingsAudit(5)).toEqual([]);
      }),
    ),
  );

  it.effect("refuses a path that isn't a repository's top folder, before any card", () =>
    inWorkspaces((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const plain = yield* plainThread(world);
        const sub = nodePath.join(world.repo, "sub");
        fs.mkdirSync(sub);
        const plainFolder = nodePath.join(world.dir, "notes");
        fs.mkdirSync(plainFolder);
        const linked = nodePath.join(world.dir, "linked");
        run(world.repo, "worktree", "add", "-q", linked);
        for (const [path, says] of [
          ["repo", "isn't an absolute path"],
          [nodePath.join(world.dir, "missing"), "Folder not found"],
          [sub, sub],
          [plainFolder, plainFolder],
          [linked, linked],
        ] as const) {
          const error = yield* call(plain.id, "plain", "workspace_create", {
            name: "Anything",
            projects: [path],
          }).pipe(Effect.flip);
          expect(error.message, path).toContain(says);
        }
        for (const [input, says] of [
          [{ name: "x", projects: [world.repo], home: "/elsewhere" }, "isn't one of the projects"],
          [
            {
              name: "x",
              projects: [world.repo],
              settings: [{ op: "set", key: "appearance.mode", value: "light" }],
            },
            "workspace.* keys",
          ],
          [
            {
              name: "x",
              projects: [world.repo],
              settings: [{ op: "set", key: "workspace.autonomy", value: "full" }],
            },
            "propose it with workspace_update",
          ],
          [{ name: "x", projects: [world.repo], workerMode: "plan" }, "Invalid input"],
          [{ name: "x", projects: [world.repo], approve: true }, "Invalid input"],
        ] as const) {
          const error = yield* call(plain.id, "plain", "workspace_create", input).pipe(Effect.flip);
          expect(error.message).toContain(says);
        }
        // A name another workspace has is refused too, whatever its case.
        const orchestration = yield* Orchestration;
        const shop = yield* store.ensureProject({ root: world.repo, name: "shop" });
        yield* orchestration.saveWorkspace({
          name: "Shop",
          projectIds: [shop.id],
          homeProjectId: shop.id,
        });
        const taken = yield* call(plain.id, "plain", "workspace_create", {
          name: " shop ",
          projects: [world.repo],
        }).pipe(Effect.flip);
        expect(taken.message).toContain("already exists");
        yield* noCard(plain.id);
        expect((yield* store.listWorkspaces).length).toBe(1);
      }),
    ),
  );
});

describe("workspace_update", () => {
  it.effect("shows the whole change before → after, and applies exactly it", () =>
    inWorkspaces((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const orchestration = yield* Orchestration;
        const shop = yield* store.ensureProject({ root: world.repo, name: "shop" });
        const oldRoot = newRepo(world, "old");
        const old = yield* store.ensureProject({ root: oldRoot, name: "old" });
        const fresh = newRepo(world, "warehouse");
        const saved = yield* orchestration.saveWorkspace({
          name: "Shop",
          projectIds: [shop.id, old.id],
          homeProjectId: old.id,
        });
        const id = saved.workspace.id;
        expect(saved.charter).toMatchObject({ autonomy: "full", workerMode: "auto" });
        const plain = yield* plainThread(world);
        const asked = yield* call(plain.id, "plain", "workspace_update", {
          workspaceId: "shop",
          name: "Shop and warehouse",
          addProjects: [fresh],
          removeProjects: [oldRoot],
          home: fresh,
          autonomy: "publish",
          workerMode: null,
          settings: [{ op: "set", key: "workspace.maxConcurrentWorkers", value: 4 }],
        }).pipe(Effect.forkScoped);
        const card = yield* cardIn(plain.id);
        expect(card).toMatchObject({
          toolName: "mcp__gram__workspace_update",
          displayName: "Change workspace",
          scopes: ["once"],
          description: "Change 7 things in the workspace “Shop”.",
        });
        expect(card.input).toMatchObject({
          action: "update",
          workspace: { id, name: "Shop" },
          projects: [
            { root: world.repo, name: "shop", change: "kept" },
            { root: oldRoot, name: "old", change: "removed" },
            { root: fresh, name: "repo", change: "added", unregistered: true, home: true },
          ],
          rows: [
            { key: "workspace.name", before: "Shop", after: "Shop and warehouse" },
            {
              key: "workspace.homeProjectId",
              before: `old (${oldRoot})`,
              after: `repo (${fresh})`,
            },
            {
              key: "workspace.autonomy",
              before: expect.stringMatching(/^Full/),
              after: expect.stringMatching(/^Publish/),
            },
            {
              key: "workspace.workerMode",
              before: "Auto",
              after: expect.stringMatching(/^Follow the default/),
            },
            { key: "workspace.maxConcurrentWorkers", before: "10", after: "4" },
          ],
        });
        // Nothing has changed while the card waits.
        expect(yield* store.getWorkspace(id)).toEqual(saved);

        yield* answer(plain.id, card, "allow");
        expect(yield* Fiber.join(asked)).toMatchObject({ applied: true });
        const registered = (yield* projectAt(fresh))!;
        const after = yield* store.getWorkspace(id);
        expect(after.workspace).toMatchObject({
          name: "Shop and warehouse",
          projectIds: [shop.id, registered.id],
          homeProjectId: registered.id,
        });
        expect(after.charter.autonomy).toBe("publish");
        expect(after.charter).not.toHaveProperty("workerMode");
        expect(after.charter.maxConcurrentWorkers).toBe(4);
        // The charter and the membership each have their audit, both from this card.
        const audits = yield* store.listSettingsAudit(5);
        expect(audits.map((audit) => audit.requestId)).toEqual([card.id, card.id]);
        expect(
          audits.flatMap((audit) => audit.changes.map((change) => change.key)).toSorted(),
        ).toEqual([
          "workspace.autonomy",
          "workspace.homeProjectId",
          "workspace.maxConcurrentWorkers",
          "workspace.name",
          "workspace.projectIds",
          "workspace.workerMode",
        ]);
      }),
    ),
  );

  it.effect("refuses what was approved when the workspace moved meanwhile", () =>
    inWorkspaces((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const orchestration = yield* Orchestration;
        const shop = yield* store.ensureProject({ root: world.repo, name: "shop" });
        const saved = yield* orchestration.saveWorkspace({
          name: "Shop",
          projectIds: [shop.id],
          homeProjectId: shop.id,
        });
        const plain = yield* plainThread(world);
        const fresh = newRepo(world, "warehouse");
        const asked = yield* call(plain.id, "plain", "workspace_update", {
          workspaceId: saved.workspace.id,
          addProjects: [fresh],
        }).pipe(Effect.flip, Effect.forkScoped);
        const card = yield* cardIn(plain.id);
        // The user renames it in Settings meanwhile.
        yield* orchestration.saveWorkspace({
          id: saved.workspace.id,
          name: "Storefront",
          projectIds: [shop.id],
          homeProjectId: shop.id,
        });
        yield* answer(plain.id, card, "allow");
        expect((yield* Fiber.join(asked)).message).toContain("changed while the card waited");
        const after = yield* store.getWorkspace(saved.workspace.id);
        expect(after.workspace).toMatchObject({ name: "Storefront", projectIds: [shop.id] });
        expect(yield* store.listSettingsAudit(5)).toEqual([]);
      }),
    ),
  );

  it.effect("lets an orchestrator propose for its own workspace only, and always asks", () =>
    inWorkspaces((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const runtimes = yield* ThreadRuntimes;
        const orchestration = yield* Orchestration;
        const { thread, workspaceId } = yield* openOrchestrator(world);
        // The widest the user can set: full autonomy, the orchestrator in Bypass.
        yield* atAutonomy(thread, "full");
        yield* runtimes.updateThread(thread.id, (t) => ({ ...t, mode: "bypassPermissions" }));

        const other = yield* store.ensureProject({ root: newRepo(world, "other"), name: "other" });
        const elsewhere = yield* orchestration.saveWorkspace({
          name: "Elsewhere",
          projectIds: [other.id],
          homeProjectId: other.id,
        });
        const refused = yield* call(thread.id, "orchestrator", "workspace_update", {
          workspaceId: elsewhere.workspace.id,
          autonomy: "supervised",
        }).pipe(Effect.flip);
        expect(refused.message).toContain("only propose changes to your own workspace");
        // Its home can't move while it is open, in it.
        const home = yield* call(thread.id, "orchestrator", "workspace_update", {
          addProjects: [other.root],
          home: other.root,
        }).pipe(Effect.flip);
        expect(home.message).toContain("home can't move while it is open");
        yield* noCard(thread.id);

        // Its own autonomy and worker mode: a card every time, approved or not, for that call alone.
        for (const [change, decision] of [
          [{ workerMode: "bypassPermissions" }, "allow"],
          [{ workerMode: "default" }, "deny"],
          [{ addProjects: [other.root] }, "deny"],
        ] as const) {
          const asked = yield* call(thread.id, "orchestrator", "workspace_update", change).pipe(
            Effect.exit,
            Effect.forkScoped,
          );
          const card = yield* cardIn(thread.id);
          expect(card.scopes).toEqual(["once"]);
          expect(card.suggestions).toEqual([]);
          yield* answer(thread.id, card, decision);
          yield* Fiber.join(asked);
        }
        const after = yield* store.getWorkspace(workspaceId);
        expect(after.charter.workerMode).toBe("bypassPermissions");
        expect(after.workspace.projectIds).not.toContain(other.id);
        expect(after.charter.autonomy).toBe("full");

        // And a workspace of its own making is on a card too.
        const created = yield* call(thread.id, "orchestrator", "workspace_create", {
          name: "Spin-off",
          projects: [other.root],
          autonomy: "full",
        }).pipe(Effect.flip, Effect.forkScoped);
        yield* answer(thread.id, yield* cardIn(thread.id), "deny");
        expect((yield* Fiber.join(created)).message).toContain("declined");
        expect(yield* workspaceNamed("Spin-off")).toBeUndefined();
      }),
    ),
  );

  it.effect("is never a worker's: not bound, and refused when called through another binding", () =>
    inWorkspaces((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const registry = yield* AppToolRegistry;
        const { session, workspaceId } = yield* openOrchestrator(world);
        const { thread: worker } = yield* spawn(session, { feature: "docs" });
        const bound = registry.forTransport(worker.id, "worker").map((t) => t.descriptor.name);
        for (const name of ["workspace_create", "workspace_update", "workspace_list"]) {
          expect(bound).not.toContain(name);
        }
        const before = yield* store.getWorkspace(workspaceId);
        for (const [name, input] of [
          ["workspace_update", { autonomy: "full" }],
          ["workspace_update", { workerMode: "bypassPermissions" }],
          ["workspace_create", { name: "Mine", projects: [world.repo], autonomy: "full" }],
          ["workspace_list", {}],
        ] as const) {
          const error = yield* call(worker.id, "orchestrator", name, input).pipe(Effect.flip);
          expect(error.message, name).toContain("Workers can't create or change workspaces");
        }
        yield* noCard(worker.id);
        expect(yield* store.getWorkspace(workspaceId)).toEqual(before);
      }),
    ),
  );
});

describe("workspace_list", () => {
  it.effect("lists every workspace to a plain thread, and its own to an orchestrator", () =>
    inWorkspaces((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const orchestration = yield* Orchestration;
        const { thread, workspaceId, project } = yield* openOrchestrator(world);
        const other = yield* store.ensureProject({ root: newRepo(world, "other"), name: "other" });
        yield* orchestration.saveWorkspace({
          name: "Elsewhere",
          projectIds: [other.id],
          homeProjectId: other.id,
        });
        type Listed = {
          readonly workspaces: ReadonlyArray<{
            readonly id: string;
            readonly name: string;
            readonly projects: ReadonlyArray<{ readonly root: string }>;
            readonly home?: { readonly id: string };
            readonly autonomy: string;
            readonly orchestratorThreadId?: string;
            readonly settings: ReadonlyArray<{ readonly key: string }>;
          }>;
        };
        const plain = yield* plainThread(world);
        const all = (yield* call(plain.id, "plain", "workspace_list", {})) as Listed;
        expect(all.workspaces.map((each) => each.name)).toEqual(["shop", "Elsewhere"]);
        expect(all.workspaces[0]).toMatchObject({
          id: workspaceId,
          projects: [{ root: world.repo }],
          home: { id: project.id },
          autonomy: "publish",
          orchestratorThreadId: thread.id,
        });
        expect(all.workspaces[0]!.settings.map((row) => row.key)).toContain(
          "workspace.workerModels",
        );
        const one = (yield* call(plain.id, "plain", "workspace_list", {
          workspaceId: "elsewhere",
        })) as Listed;
        expect(one.workspaces.map((each) => each.name)).toEqual(["Elsewhere"]);
        const own = (yield* call(thread.id, "orchestrator", "workspace_list", {})) as Listed;
        expect(own.workspaces.map((each) => each.id)).toEqual([workspaceId]);
      }),
    ),
  );
});
