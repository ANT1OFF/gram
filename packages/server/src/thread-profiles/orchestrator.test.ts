// An orchestrator started from a profile (`ThreadProfile.role`): the workspace made for it, the
// slot, its session, and the workers it spawns in that workspace's folder.
import { describe, expect, it } from "@effect/vitest";
import {
  applySettingsPatch,
  type ThreadId,
  type ThreadProfile,
  type WorkspaceId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hasGit } from "../git/test-repo.ts";
import { Conversations } from "../embedding/conversations.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { inServer, sessionsOf } from "../orchestration/service-kit.ts";
import { completeTurn, waitSent } from "../orchestration/test-harness.ts";
import { HOME_PROFILE_FILE, PROFILE_HOMES_DIR } from "./home.ts";
import { PROFILE_THREADS_DIR } from "./own-folder.ts";
import { profileStarterHere } from "./service.ts";
import { ORCHESTRATOR_NEEDS_A_MACHINE } from "./start.ts";

const GATEWAY = "https://mcp.example.test/agent";
const CHARTER = "You are the support desk for #runbooks. Answer short things yourself.";

const profile = (over: Partial<ThreadProfile> = {}): ThreadProfile => ({
  version: 1,
  name: "Runbooks desk",
  source: { id: "agent-12", version: "4" },
  agent: "claude",
  charter: CHARTER,
  files: [{ path: "AGENTS.md", content: "# House rules\n" }],
  skills: [{ name: "triage", description: "Sorts a request.", body: "Read it, then sort it." }],
  model: { model: "opus" },
  connectors: { server: { name: "agent", url: GATEWAY } },
  autonomy: "publish",
  workplace: { kind: "scratch" },
  role: { kind: "orchestrator", workspace: { name: "Runbooks" } },
  ...over,
});

const ID = "0b4c2f9e-6a51-4c3e-9d7a-2f1e8b6c5a40" as ThreadId;

const turnOn = Effect.gen(function* () {
  const store = yield* ThreadStore;
  yield* store.updateSettings(
    (settings) => applySettingsPatch(settings, { experimental: { embedding: true } }),
    [["experimental", "embedding"]],
  );
});

describe.skipIf(!hasGit)("an orchestrator started from a profile", () => {
  it.effect("orchestrates a workspace made for it, once however often it is asked", () =>
    inServer((world) =>
      Effect.gen(function* () {
        yield* turnOn;
        const store = yield* ThreadStore;
        const starter = yield* profileStarterHere;
        const first = yield* starter.startOne(profile({ input: "Introduce yourself." }), {
          threadId: ID,
        });
        expect(first.created).toBe(true);
        const thread = first.thread;
        const workspaceId = ID as string as WorkspaceId;
        expect(thread).toMatchObject({
          id: ID,
          role: "orchestrator",
          workspaceId,
          title: "Orchestrator · Runbooks",
          model: { agent: "claude", model: "opus" },
          profile: { charter: CHARTER, server: { name: "agent", url: GATEWAY } },
        });

        // The workspace: its own, holding the slot, with the profile's level and model.
        const state = yield* store.getWorkspace(workspaceId);
        expect(state.workspace).toMatchObject({
          name: "Runbooks",
          fromProfile: true,
          orchestratorThreadId: ID,
        });
        expect(state.charter).toMatchObject({
          autonomy: "publish",
          orchestratorModel: { agent: "claude", model: "opus" },
          workerModels: [{ agent: "claude", model: "opus" }],
        });
        const home = join(world.dir, PROFILE_HOMES_DIR, ID);
        const [project] = (yield* store.listProjects).filter((p) => p.root === home);
        expect(state.workspace.projectIds).toEqual([project!.id]);
        expect(existsSync(join(home, HOME_PROFILE_FILE))).toBe(true);

        // Its own folder, laid with the profile's files; its session holds the charter and server.
        expect(readFileSync(join(thread.checkout.path, "AGENTS.md"), "utf8")).toBe(
          "# House rules\n",
        );
        const session = yield* waitSent(ID, 1);
        // What waits is sent as the first turn ends, so the thread never rests between.
        yield* session.completeTurn();
        yield* waitSent(ID, 2);
        expect(session.options).toMatchObject({
          audience: "orchestrator",
          mcpServer: { url: GATEWAY },
        });
        expect(session.options.instructions).toContain(CHARTER);
        expect(session.options.instructions).toContain('`project` "Runbooks"');
        // The profile's first message, and the boot digest behind it.
        expect(session.sent[0]?.text).toBe("Introduce yourself.");
        expect(session.sent[1]?.text).toContain("Orchestration boot #1");

        const again = yield* starter.startOne(profile(), { threadId: ID });
        expect(again).toMatchObject({ created: false, thread: { id: ID } });
        expect(
          (yield* store.listWorkspaces).filter((each) => each.workspace.fromProfile === true),
        ).toHaveLength(1);
        expect(yield* sessionsOf(ID)).toHaveLength(1);
      }),
    ),
  );

  it.effect("spawns workers in folders of their own, held to the profile's server", () =>
    inServer((world) =>
      Effect.gen(function* () {
        yield* turnOn;
        const store = yield* ThreadStore;
        const starter = yield* profileStarterHere;
        yield* starter.startOne(profile(), { threadId: ID });
        const orchestrator = yield* waitSent(ID, 1);
        yield* completeTurn(orchestrator);

        // A conversation the orchestrator owns, handed to the worker it spawns.
        const conversations = yield* Conversations;
        const chat = { id: "chat:42", label: "#on-call" };
        yield* conversations.arrive(ID, chat);
        const result = (yield* orchestrator.callTool("spawn_worker", {
          project: "Runbooks",
          feature: "rota",
          title: "Draft the on-call rota",
          brief: "Draft next week's rota.",
          conversations: [chat.id],
        })) as { readonly threadId: ThreadId };
        const session = yield* waitSent(result.threadId, 1);
        const worker = yield* store.getThread(result.threadId);
        expect(worker.checkout).toEqual({
          kind: "main",
          path: join(world.dir, PROFILE_THREADS_DIR, worker.id),
        });
        expect(worker.spawnedBy).toMatchObject({ threadId: ID, feature: "rota" });
        expect(worker.conversations).toEqual([chat]);
        expect((yield* store.getThread(ID)).conversations).toBeUndefined();
        // The profile's files and skills, none of the orchestrator's charter, the same server.
        expect(readFileSync(join(worker.checkout.path, "AGENTS.md"), "utf8")).toBe(
          "# House rules\n",
        );
        expect(existsSync(join(worker.checkout.path, ".claude/skills/triage/SKILL.md"))).toBe(true);
        expect(worker.profile).toMatchObject({ charter: "", server: { url: GATEWAY } });
        expect(session.options.mcpServer).toEqual({ name: "agent", url: GATEWAY });
        expect(session.options.instructions ?? "").not.toContain(CHARTER);

        // A folder holds no repository to stand beside others in.
        const refused = yield* orchestrator
          .callTool("spawn_worker", {
            project: "Runbooks",
            alsoIn: [world.repo],
            feature: "docs",
            title: "Docs",
            brief: "Write docs.",
          })
          .pipe(Effect.flip);
        expect(String(refused)).toContain("folder of its own");
      }),
    ),
  );

  it.effect("is refused before anything is made where it can't be one", () =>
    inServer((world) =>
      Effect.gen(function* () {
        yield* turnOn;
        const store = yield* ThreadStore;
        const starter = yield* profileStarterHere;
        const repositories = yield* starter
          .startOne(
            profile({ workplace: { kind: "repositories", repositories: [{ url: world.repo }] } }),
            { threadId: ID },
          )
          .pipe(Effect.flip);
        expect(repositories.message).toContain("folder of its own");
        const later = yield* starter
          .startOne(profile(), { threadId: ID, machine: "later" })
          .pipe(Effect.flip);
        expect(later.message).toBe(ORCHESTRATOR_NEEDS_A_MACHINE);
        expect(yield* store.listThreads).toEqual([]);
        expect(yield* store.listWorkspaces).toEqual([]);
      }),
    ),
  );
});
