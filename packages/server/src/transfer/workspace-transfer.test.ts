// Moving a workspace between two servers, each the real orchestration service, tools, runtimes,
// store, memory and archive over the fake agent: the first exports a workspace with history, the
// second imports the bundle as it would arrive over HTTP, and its orchestrator carries on there.
import { describe, expect, it } from "@effect/vitest";
import {
  applySettingsPatch,
  ImportWorkspaceInput,
  type ThreadId,
  type WorkspaceBundle,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as nodePath from "node:path";
import { hasGit } from "../git/test-repo.ts";
import { ThreadArchive } from "../orchestration/archive.ts";
import { OrchestrationMemory } from "../orchestration/memory.ts";
import {
  completeTurn,
  makeWorld,
  openOrchestrator,
  openProject,
  outboxOf,
  serverLayer,
  spawn,
  waitSent,
  type Server,
  type World,
} from "../orchestration/test-harness.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import {
  bundleProblem,
  handoverNote,
  scrubbed,
  shareableRemote,
  TRANSFER_OFF,
  WorkspaceTransfer,
} from "./workspace-transfer.ts";

/** The server over `world` with the transcript archive and the transfer service on top. */
const transferLayer = (world: World) =>
  WorkspaceTransfer.layer.pipe(
    Layer.provideMerge(ThreadArchive.layerAt(nodePath.join(world.dir, "memory"))),
    Layer.provideMerge(serverLayer(world)),
  );

/** One server over `world`, built for `body` and torn down after it. */
const onServer = <A, E>(
  world: World,
  body: Effect.Effect<A, E, Server | WorkspaceTransfer | ThreadArchive | Scope.Scope>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(transferLayer(world));
      return yield* body.pipe(Effect.provide(context));
    }),
  );

const hostedFeatures = (on: boolean) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    yield* store.updateSettings(
      (settings) => applySettingsPatch(settings, { experimental: { embedding: on } }),
      [["experimental", "embedding"]],
    );
  });

/** The bundle as it reaches another server: serialised, sent, and decoded as the route decodes it. */
const overTheWire = (bundle: WorkspaceBundle, projects: ImportWorkspaceInput["projects"]) =>
  Schema.decodeUnknownSync(ImportWorkspaceInput)(
    JSON.parse(JSON.stringify(Schema.encodeSync(ImportWorkspaceInput)({ bundle, projects }))),
  );

const GOALS = "# Goals\n\n- 2026-11-10: ship the mail trigger before the billing rework (user).\n";
const INDEX =
  "# Memory index\n\n- goals.md: what the user wants, in order\n- The shop repo deploys from main only (2026-11-10, user).\n";

/**
 * A workspace with history on a desktop server: an orchestrator that was told something by the
 * user and wrote it to memory, and a worker it spawned that reported progress. Returns its bundle.
 */
const exportedFrom = (laptop: World) =>
  onServer(
    laptop,
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const runtimes = yield* ThreadRuntimes;
      const transfer = yield* WorkspaceTransfer;
      const { session, thread, workspaceId } = yield* openOrchestrator(laptop);
      yield* runtimes.send(thread.id, { text: "Ship the mail trigger before anything else." });
      yield* waitSent(thread.id, 2);
      yield* session.callTool("memory_write", { path: "goals.md", content: GOALS });
      yield* session.callTool("memory_write", { path: "MEMORY.md", content: INDEX });
      yield* completeTurn(session, "On it: a worker will take the mail trigger.");
      const worker = yield* spawn(session, { feature: "mail-trigger", title: "Mail trigger" });
      yield* worker.session.callTool("report", {
        state: "progress",
        summary: "The trigger parses inbound mail; delivery is next.",
      });
      // The digest of that report, taken and answered, so the orchestrator is idle at the export.
      yield* TestClock.adjust("60 seconds");
      const told = yield* waitSent(thread.id, 3);
      yield* completeTurn(told, "Noted.");
      yield* completeTurn(worker.session, "Parsing works.");

      yield* hostedFeatures(true);
      const bundle = yield* transfer.exportWorkspace({ workspaceId });
      // A move pauses what it leaves behind, so two orchestrators never work the same branches.
      expect((yield* store.getWorkspace(workspaceId)).paused?.reason).toBe("user");
      return { bundle, orchestratorId: thread.id, workerId: worker.thread.id, workspaceId };
    }),
  );

describe.skipIf(!hasGit)("moving a workspace to another server", () => {
  it.effect(
    "a workspace with history moves and its orchestrator carries on with its memory",
    () =>
      Effect.gen(function* () {
        const laptop = yield* makeWorld;
        const hosted = yield* makeWorld;
        const moved = yield* exportedFrom(laptop);
        const { bundle } = moved;

        expect(bundle.orchestrator?.thread.id).toBe(moved.orchestratorId);
        // Nothing of the machine it came from is in the bundle's thread record.
        expect(bundle.orchestrator?.thread.agentSessionId).toBeUndefined();
        expect(bundle.orchestrator?.thread.additionalDirectories).toBeUndefined();
        expect(bundle.workspace.paused).toBeUndefined();
        expect(bundle.memory.map((file) => file.path).toSorted()).toEqual([
          "MEMORY.md",
          "goals.md",
        ]);
        expect(bundle.workers).toHaveLength(1);
        expect(bundle.workers[0]).toMatchObject({
          threadId: moved.workerId,
          title: "Mail trigger",
          feature: "mail-trigger",
          lastReport: { state: "progress" },
        });

        yield* onServer(
          hosted,
          Effect.gen(function* () {
            yield* hostedFeatures(true);
            const store = yield* ThreadStore;
            const transfer = yield* WorkspaceTransfer;
            const archive = yield* ThreadArchive;
            const memory = yield* OrchestrationMemory;
            const fake = yield* FakeAgentControl;
            // The same repository, at this server's own path for it.
            const here = yield* openProject(hosted);
            expect(here.root).not.toBe(bundle.projects[0].root);

            const result = yield* transfer.importWorkspace(
              overTheWire(bundle, { [bundle.projects[0].id]: { root: hosted.repo } }),
            );
            expect(result.orchestrator).toBe("restored");
            expect(result.orchestratorThreadId).toBe(moved.orchestratorId);
            expect(result.workspace.workspace).toMatchObject({
              id: moved.workspaceId,
              name: "shop",
              projectIds: [here.id],
              homeProjectId: here.id,
              orchestratorThreadId: moved.orchestratorId,
            });
            expect(result.workspace.paused).toBeUndefined();

            // The same thread, in this server's folder, on a session of its own.
            const thread = yield* store.getThread(moved.orchestratorId);
            expect(thread).toMatchObject({ role: "orchestrator", projectId: here.id });
            expect(thread.checkout).toMatchObject({ kind: "main", path: hosted.repo });
            yield* TestClock.adjust("60 seconds");
            const session = yield* waitSent(moved.orchestratorId, 1);
            expect(session.options.resumeId).toBeUndefined();

            // Its first digest here is a boot: its memory index, and what the move left behind.
            const boot = session.sent[0]!;
            expect(boot.notice).toMatchObject({ variant: "boot" });
            expect(boot.text).toContain("The shop repo deploys from main only");
            expect(boot.text).toContain("was moved to this server from another Gram");
            expect(boot.text).toContain(`shop at ${hosted.repo}`);
            expect(boot.text).toContain("“Mail trigger” [mail-trigger]");
            expect(boot.text).toContain("last report progress: The trigger parses inbound mail");

            // The conversation came with it, in order, ahead of the boot digest.
            const texts = (yield* store.listMessages(moved.orchestratorId)).map((message) =>
              message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
            );
            const said = texts.findIndex((text) =>
              text.includes("Ship the mail trigger before anything else."),
            );
            const answered = texts.findIndex((text) => text.includes("On it: a worker will take"));
            expect(said).toBeGreaterThanOrEqual(0);
            expect(answered).toBeGreaterThan(said);

            // Its memory is the memory it wrote, read through its own tool.
            expect(yield* session.callTool("memory_read", { path: "goals.md" })).toMatchObject({
              content: GOALS,
            });
            expect(yield* memory.index(moved.workspaceId)).toBe(INDEX);

            // The worker is a finished one here: its transcript, and no thread or worktree.
            expect((yield* archive.list(moved.workspaceId)).map((entry) => entry.threadId)).toEqual(
              [moved.workerId],
            );
            expect(yield* archive.read(moved.workspaceId, moved.workerId)).toContain(
              "Source: worker thread (mail-trigger)",
            );
            expect(
              (yield* store.listThreads).filter((each) => each.workspaceId === moved.workspaceId),
            ).toHaveLength(1);

            // And it carries on: the turn ends, and it starts a worker here on the same feature.
            yield* completeTurn(session, "Read. Carrying on with the mail trigger.");
            expect((yield* outboxOf(moved.workspaceId)).booted).toBe(true);
            const next = yield* spawn(session, {
              feature: "mail-trigger",
              title: "Mail trigger, continued",
            });
            expect(next.thread.checkout.repoRoot ?? next.thread.checkout.path).toContain(
              hosted.dir,
            );
            expect(next.thread.spawnedBy).toMatchObject({ threadId: moved.orchestratorId });
            expect(fake.sessions.map((each) => each.options.threadId)).toContain(next.thread.id);

            // The audit says where it came from.
            const events = yield* store.listOrchestrationEvents(moved.workspaceId, 0);
            expect(events.filter((event) => event.kind === "move").at(-1)?.data).toMatchObject({
              direction: "imported",
            });
            expect(events.some((event) => event.kind === "spawn")).toBe(true);
          }),
        );
      }),
    { timeout: 120_000 },
  );

  it.effect(
    "an import replaces nothing, and refuses what it can't place or read",
    () =>
      Effect.gen(function* () {
        const laptop = yield* makeWorld;
        const hosted = yield* makeWorld;
        const { bundle, workspaceId } = yield* exportedFrom(laptop);
        const place = { [bundle.projects[0].id]: { root: hosted.repo } };

        yield* onServer(
          hosted,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const transfer = yield* WorkspaceTransfer;
            const fake = yield* FakeAgentControl;
            const refused = (input: ImportWorkspaceInput) =>
              transfer.importWorkspace(input).pipe(
                Effect.flip,
                Effect.map((error) => error.message),
              );
            const nothingHere = Effect.gen(function* () {
              expect(yield* store.listWorkspaces).toEqual([]);
              expect(yield* store.listThreads).toEqual([]);
              expect(yield* store.listClosed).toEqual([]);
              expect(fake.sessions).toEqual([]);
            });

            // Off unless the hosted features are on, here as on the server it came from.
            expect(yield* refused(overTheWire(bundle, place))).toBe(TRANSFER_OFF);
            yield* nothingHere;
            yield* hostedFeatures(true);

            expect(yield* refused(overTheWire(bundle, {}))).toContain(
              "Say where each of the workspace's repositories is on this server",
            );
            expect(
              yield* refused(
                overTheWire(bundle, {
                  [bundle.projects[0].id]: { root: nodePath.join(hosted.dir, "nowhere") },
                }),
              ),
            ).toContain("nowhere");
            expect(
              yield* refused(
                overTheWire({ ...bundle, app: { ...bundle.app, schema: 10_000 } }, place),
              ),
            ).toContain("newer Gram");
            expect(
              yield* refused(
                overTheWire(
                  {
                    ...bundle,
                    memory: [{ path: "../../escape.md", content: "x" }],
                  },
                  place,
                ),
              ),
            ).toContain("memory can't be kept");
            expect(
              yield* refused(
                overTheWire(
                  {
                    ...bundle,
                    workspace: {
                      ...bundle.workspace,
                      workspace: {
                        ...bundle.workspace.workspace,
                        id: "../other" as typeof workspaceId,
                      },
                    },
                  },
                  place,
                ),
              ),
            ).toContain("workspace id");
            yield* nothingHere;

            const first = yield* transfer.importWorkspace(overTheWire(bundle, place));
            expect(first.orchestrator).toBe("restored");
            yield* TestClock.adjust("60 seconds");
            const session = yield* waitSent(first.orchestratorThreadId as ThreadId, 1);
            yield* completeTurn(session);
            const before = yield* store.listMessages(first.orchestratorThreadId as ThreadId);

            // The same bundle again, and one that reuses the orchestrator under another workspace.
            expect(yield* refused(overTheWire(bundle, place))).toContain("already on this server");
            const other = "11111111-2222-4333-8444-555555555555" as typeof workspaceId;
            expect(
              yield* refused(
                overTheWire(
                  {
                    ...bundle,
                    workspace: {
                      ...bundle.workspace,
                      workspace: { ...bundle.workspace.workspace, id: other },
                    },
                    orchestrator: {
                      ...bundle.orchestrator!,
                      thread: { ...bundle.orchestrator!.thread, workspaceId: other },
                    },
                  },
                  place,
                ),
              ),
            ).toContain("already on this server");
            expect((yield* store.listWorkspaces).map(({ workspace }) => workspace.id)).toEqual([
              workspaceId,
            ]);
            expect(yield* store.listMessages(first.orchestratorThreadId as ThreadId)).toEqual(
              before,
            );
          }),
        );

        // And nothing is exported while the hosted features are off.
        yield* onServer(
          laptop,
          Effect.gen(function* () {
            const transfer = yield* WorkspaceTransfer;
            yield* hostedFeatures(false);
            const error = yield* transfer.exportWorkspace({ workspaceId }).pipe(Effect.flip);
            expect(error.message).toBe(TRANSFER_OFF);
          }),
        );
      }),
    { timeout: 120_000 },
  );
});

describe("what a bundle may say", () => {
  it("names a remote without its credentials, and no path of the machine", () => {
    expect(shareableRemote("https://github.com/acme/shop.git")).toBe(
      "https://github.com/acme/shop.git",
    );
    expect(shareableRemote("https://x-access-token:s3cret@github.com/acme/shop.git")).toBe(
      "https://github.com/acme/shop.git",
    );
    expect(shareableRemote("https://s3cret@github.com/acme/shop.git?token=abc#frag")).toBe(
      "https://github.com/acme/shop.git",
    );
    expect(shareableRemote("ssh://git:pw@example.com:2222/acme/shop.git")).toBe(
      "ssh://git@example.com:2222/acme/shop.git",
    );
    expect(shareableRemote("git@github.com:acme/shop.git")).toBe("git@github.com:acme/shop.git");
    expect(shareableRemote("/Users/someone/code/shop")).toBeUndefined();
    expect(shareableRemote("file:///Users/someone/code/shop")).toBeUndefined();
  });

  it("scrubs every string of what looks like a credential, and keeps the shape", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const out = scrubbed({
      id: "m1",
      parts: [
        { type: "text", text: `export GH_TOKEN=${token}` },
        { n: 3, ok: true, none: null },
      ],
    });
    expect(JSON.stringify(out)).not.toContain(token);
    expect(out).toMatchObject({
      id: "m1",
      parts: [{ type: "text" }, { n: 3, ok: true, none: null }],
    });
  });

  it("tells the orchestrator what moved, where its repositories are, and what its workers were on", () => {
    const note = handoverNote(
      {
        exportedAt: Date.UTC(2026, 10, 10, 23, 5),
        workers: [
          {
            threadId: "w1" as ThreadId,
            title: "Mail trigger",
            feature: "mail-trigger",
            projectId: "p1" as never,
            branch: "gram/mail-trigger",
            prs: ["acme/shop#12"],
            lastReport: { state: "progress", summary: "Parsing works.", at: 1 },
            uncommittedFiles: 2,
          },
        ],
        wakes: [{ at: Date.UTC(2026, 10, 12, 9, 0), note: "check the deploy" }],
      },
      [{ name: "shop", root: "/srv/repos/shop" }],
    );
    expect(note).toContain("exported on 2026-11-10 23:05 UTC");
    expect(note).toContain("shop at /srv/repos/shop");
    expect(note).toContain(
      "- “Mail trigger” [mail-trigger], branch gram/mail-trigger, acme/shop#12, last report progress: Parsing works., 2 changed files not committed stayed behind",
    );
    expect(note).toContain("- 2026-11-12 09:00 UTC: check the deploy");
  });

  it("refuses a bundle whose parts don't belong together", () => {
    const base = {
      workspace: {
        workspace: {
          id: "ws-1",
          name: "shop",
          projectIds: ["p1"],
          homeProjectId: "p1",
          createdAt: 1,
        },
        charter: {},
      },
      projects: [{ id: "p1", name: "shop", root: "/x" }],
      workers: [],
      archive: [],
      memory: [],
    } as unknown as WorkspaceBundle;
    expect(bundleProblem(base)).toBeUndefined();
    expect(
      bundleProblem({ ...base, projects: [{ ...base.projects[0], id: "p2" as never }] }),
    ).toContain("doesn't describe");
    expect(
      bundleProblem({
        ...base,
        archive: [{ threadId: "../../etc/passwd" as ThreadId, text: "x", archivedAt: 1 }],
      }),
    ).toContain("thread id");
  });
});
