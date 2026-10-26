// Dreams across a restart, and imports.
import { describe, expect, it } from "@effect/vitest";
import { type AgentKind, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { hasGit, run } from "../git/test-repo.ts";
import { encodeCwdExact } from "./claude-project-path.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { Dreams } from "./dreams.ts";
import { IMPORT_TOKENS_PER_SESSION } from "./import.ts";
import { OrchestrationMemory } from "./memory.ts";
import { Orchestration } from "./service.ts";
import {
  completeTurn,
  makeWorld,
  openOrchestrator,
  openProject,
  settle,
  waitSent,
} from "./test-harness.ts";
import {
  githubToken,
  type History,
  pastSession,
  withDreams,
  writeOutput,
  startDream,
  finishDream,
  filesUnder,
} from "./dreams-service-kit.ts";

describe.skipIf(!hasGit)("dreams", () => {
  it.effect("reload revalidates a completed row without a report, leaving its persisted run", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const first = yield* withDreams(
        world,
        Effect.gen(function* () {
          const { workspaceId } = yield* openOrchestrator(world);
          const { dream } = yield* startDream(workspaceId);
          const store = yield* ThreadStore;
          // Seeded output but no report, persisted as completed.
          yield* store.putDream({ ...dream, status: "completed" });
          return { workspaceId, dream };
        }),
      );
      yield* withDreams(
        world,
        Effect.gen(function* () {
          const dreams = yield* Dreams;
          const store = yield* ThreadStore;
          expect((yield* dreams.list(first.workspaceId))[0]).toMatchObject({
            status: "failed",
            failure: "missing_report",
          });
          expect((yield* dreams.review(first.dream.id)).dream).toMatchObject({
            status: "failed",
            failure: "missing_report",
          });
          expect(yield* store.getDream(first.dream.id)).toMatchObject({ status: "completed" });
          expect(yield* Effect.flip(dreams.adopt(first.dream.id))).toMatchObject({
            _tag: "InvalidState",
          });
        }),
      );
    }).pipe(Effect.scoped),
  );

  for (const agent of ["claude", "codex"] as const)
    for (const output of ["valid", "missing-report"] as const)
      it.effect(`a restart resumes closed Dream validation on ${agent} with ${output} output`, () =>
        Effect.gen(function* () {
          const world = yield* makeWorld;
          const report = "# Review\n\nReviewed the snapshot and kept its durable memory.\n";
          const first = yield* withDreams(
            world,
            Effect.gen(function* () {
              const { workspaceId } = yield* openOrchestrator(world);
              const dream = yield* (yield* Dreams).start({
                workspaceId,
                kind: "dream",
                model: { agent, model: "default" },
              });
              const session = yield* waitSent(dream.threadId as ThreadId, 1);
              if (output === "valid")
                yield* session.callTool("dream_write", {
                  path: "output/REPORT.md",
                  content: report,
                });
              // Ordinary persisted-state fixture: closed authority, validation not yet settled.
              yield* (yield* ThreadStore).putDream({ ...dream, filesClosedAt: 0 });
              return { workspaceId, dream };
            }),
          );
          const status = output === "valid" ? "completed" : "failed";
          const cardStatuses = (store: typeof ThreadStore.Service) =>
            store
              .listMessages(first.dream.threadId as ThreadId)
              .pipe(
                Effect.map((messages) =>
                  messages.flatMap((message) =>
                    message.parts.flatMap((part) =>
                      part.type === "data-dream-report" ? [part.data.status] : [],
                    ),
                  ),
                ),
              );
          yield* withDreams(
            world,
            Effect.gen(function* () {
              const store = yield* ThreadStore;
              const dreams = yield* Dreams;
              const recovered = yield* store.getDream(first.dream.id);
              expect(recovered).toMatchObject({ status, filesClosedAt: 0 });
              if (output === "missing-report") expect(recovered.failure).toBe("missing_report");
              expect(yield* cardStatuses(store)).toEqual([status]);
              expect((yield* dreams.review(first.dream.id)).dream.status).toBe(status);
              if (output === "valid")
                expect((yield* dreams.review(first.dream.id)).report).toBe(report);
              // Reopening the synthetic thread cannot reopen its closed file capability or
              // duplicate completion. Recovery itself launches no provider session.
              const fake = yield* FakeAgentControl;
              expect(
                fake.sessions.some((session) => session.options.threadId === first.dream.threadId),
              ).toBe(false);
              yield* (yield* ThreadRuntimes).send(first.dream.threadId as ThreadId, {
                text: "done",
              });
              const session = yield* waitSent(first.dream.threadId as ThreadId, 1);
              expect(
                yield* Effect.result(
                  session.callTool("dream_write", { path: "output/REPORT.md", content: "" }),
                ),
              ).toMatchObject({ _tag: "Failure" });
              yield* completeTurn(session, "done");
              yield* settle;
              expect(yield* cardStatuses(store)).toEqual([status]);
              const replacement = yield* startDream(first.workspaceId);
              expect(replacement.dream.filesClosedAt).toBeUndefined();
              yield* dreams.cancel(replacement.dream.id);
            }),
          );
          yield* withDreams(
            world,
            Effect.gen(function* () {
              const store = yield* ThreadStore;
              expect(yield* store.getDream(first.dream.id)).toMatchObject({
                status,
                filesClosedAt: 0,
              });
              expect(yield* cardStatuses(store)).toEqual([status]);
            }),
          );
        }).pipe(Effect.scoped),
      );

  it.effect("a restart re-attaches a dream whose thread is there and fails one whose isn't", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const first = yield* withDreams(
        world,
        Effect.gen(function* () {
          const { workspaceId } = yield* openOrchestrator(world);
          return { workspaceId, dream: (yield* startDream(workspaceId)).dream };
        }),
      );

      const second = yield* withDreams(
        world,
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const runtimes = yield* ThreadRuntimes;
          expect((yield* store.getDream(first.dream.id)).status).toBe("running");
          writeOutput(first.dream, { "decisions.md": "2026-09-24: survived a restart\n" });
          yield* runtimes.send(first.dream.threadId as ThreadId, { text: "carry on" });
          const session = yield* waitSent(first.dream.threadId as ThreadId, 1);
          yield* finishDream(first.dream, session, "completed");

          const { dream } = yield* startDream(first.workspaceId);
          // As a crash between the thread's removal and the dream hearing of it would leave it.
          yield* store.removeThread(dream.threadId as ThreadId);
          expect((yield* store.getDream(dream.id)).status).toBe("running");
          return dream;
        }),
      );

      yield* withDreams(
        world,
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          expect(yield* store.getDream(second.id)).toMatchObject({
            status: "failed",
            failure: "agent_error",
          });
          expect((yield* store.getDream(first.dream.id)).status).toBe("completed");
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("an import previews what is really there, then drafts memory from it", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const worktree = nodePath.join(world.dir, "wt-feat");
      run(world.repo, "worktree", "add", "-q", "-b", "feat", worktree);
      const history: History = {
        claude: [
          pastSession("s-new", 3000, world.repo),
          pastSession("s-old", 1000, world.repo),
          // Claude lists a worktree's sessions from the repo root too: one session, not two.
          pastSession("s-wt", 2000, world.repo, worktree),
          pastSession("s-wt", 2000, worktree, worktree),
        ],
        // Codex names each session's folder itself. The same id under two
        // kinds is two sessions; one listed twice, as Codex's two homes could, is one.
        codex: [
          pastSession("c-1", 4000, world.repo, world.repo),
          pastSession("c-1", 4000, world.repo, world.repo),
          pastSession("s-new", 500, worktree, worktree),
        ],
      };
      const configDir = nodePath.join(world.dir, "claude-config");
      const seedDir = nodePath.join(configDir, "projects", encodeCwdExact(world.repo), "memory");
      fs.mkdirSync(seedDir, { recursive: true });
      fs.writeFileSync(nodePath.join(seedDir, "feedback_testing.md"), "Prefers vitest over e2e.\n");
      fs.writeFileSync(nodePath.join(seedDir, "notes.txt"), "not markdown\n");

      yield* withDreams(
        world,
        Effect.gen(function* () {
          const dreams = yield* Dreams;
          const memory = yield* OrchestrationMemory;
          const project = yield* openProject(world);
          const { workspace } = yield* (yield* Orchestration).saveWorkspace({
            name: "shop",
            projectIds: [project.id],
            homeProjectId: project.id,
          });

          const preview = yield* dreams.preview({ workspaceId: workspace.id, includeMemory: true });
          const row = (agent: AgentKind, cwd: string, times: ReadonlyArray<number>) => ({
            projectId: project.id,
            project: "shop",
            agent,
            cwd,
            sessions: times.length,
            oldest: Math.min(...times),
            newest: Math.max(...times),
            estimatedTokens: times.length * IMPORT_TOKENS_PER_SESSION,
          });
          // One row per agent and folder, newest first.
          expect(preview.sources).toEqual([
            row("codex", world.repo, [4000]),
            row("claude", world.repo, [3000, 1000]),
            row("claude", worktree, [2000]),
            row("codex", worktree, [500]),
          ]);
          expect(preview).toMatchObject({
            worktreesCovered: 1,
            worktreesTotal: 1,
            closedThreadsKept: 0,
            archivedThreads: 0,
            seedFiles: 1,
          });
          const notes = preview.notes.join("\n");
          expect(notes).not.toMatch(/of (codex|claude) found but left out/);
          expect(notes).toContain("Claude does from the repo root, Codex doesn't.");
          expect(notes).toContain("flat guess");
          expect(notes).toContain("stay on this machine");
          expect("seedFiles" in (yield* dreams.preview({ workspaceId: workspace.id }))).toBe(false);
          const narrow = yield* dreams.preview({ workspaceId: workspace.id, perRepo: 2 });
          expect(narrow.sources.map((source) => [source.agent, source.sessions])).toEqual([
            ["codex", 1],
            ["claude", 1],
          ]);

          // Nothing was started by looking: an import is offered, never automatic.
          expect(yield* dreams.list(workspace.id)).toEqual([]);

          const dream = yield* dreams.start({
            workspaceId: workspace.id,
            kind: "import",
            includeMemory: true,
          });
          const dreamSession = yield* waitSent(dream.threadId as ThreadId, 1);
          expect(dream).toMatchObject({ kind: "import", inputs: { memoryVersion: "" } });
          expect(dream.inputs.agentSessions.map((s) => [s.agent, s.agentSessionId, s.cwd])).toEqual(
            [
              ["codex", "c-1", world.repo],
              ["claude", "s-new", world.repo],
              ["claude", "s-wt", worktree],
              ["claude", "s-old", world.repo],
              ["codex", "s-new", worktree],
            ],
          );
          expect(
            dream.inputs.agentSessions.every(
              (entry) => entry.agent === "claude" || entry.agent === "codex",
            ),
          ).toBe(true);
          expect(filesUnder(dream.outputDir)).toEqual([
            "input/seed/001-feedback-testing-md.md",
            "input/sessions/001-session-c-1.md",
            "input/sessions/002-session-s-new.md",
            "input/sessions/003-session-s-wt.md",
            "input/sessions/004-session-s-old.md",
            "input/sessions/005-session-s-new.md",
          ]);
          const sessionFile = (name: string) =>
            fs.readFileSync(nodePath.join(dream.outputDir, "input", "sessions", name), "utf8");
          expect(sessionFile("001-session-c-1.md")).toContain("codex session c-1");
          expect(filesUnder(dream.outputDir).some((path) => path.includes("session-o-1"))).toBe(
            false,
          );
          const rendered = sessionFile("002-session-s-new.md");
          expect(rendered).toContain("claude session s-new");
          expect(rendered).not.toContain(githubToken);
          expect(dreamSession.sent[0]?.text).toContain("Draft the first long-term memory");
          expect(dreamSession.sent[0]?.text).toContain("input/seed/ — 1 file");
          expect(
            (yield* ThreadStore.pipe(
              Effect.flatMap((s) => s.getThread(dream.threadId as ThreadId)),
            )).title,
          ).toBe("Import · shop");

          writeOutput(dream, {
            "MEMORY.md": "# Memory index\n\n- repos/shop.md\n",
            "repos/shop.md": "2026-09-24: deploys on merge (001-session-s-new.md)\n",
            "REPORT.md": "# Report\n",
          });
          yield* finishDream(dream, dreamSession, "completed");
          const review = yield* dreams.review(dream.id);
          expect(review.memoryVersion).toBe("");
          expect((yield* dreams.adopt(dream.id, { basedOn: "" })).adoptedVersion).toBe("0001");
          expect(yield* memory.read(workspace.id, "repos/shop.md")).toContain("deploys on merge");

          // An explicit selection is taken as it is, and what can't be read is said, not hidden.
          const picked = yield* dreams.start({
            workspaceId: workspace.id,
            kind: "dream",
            agentSessions: [
              { agent: "claude", cwd: world.repo, agentSessionId: "s-old" },
              { agent: "claude", cwd: world.repo, agentSessionId: "s-gone" },
              { agent: "codex", cwd: world.repo, agentSessionId: "c-1" },
              // Another folder's session is not this folder's to read, whatever the id.
              { agent: "codex", cwd: worktree, agentSessionId: "c-1" },
            ],
          });
          expect(picked.inputs.agentSessions.map((s) => s.agentSessionId)).toEqual([
            "s-old",
            "c-1",
          ]);
          expect(picked.inputs.memoryVersion).toBe("0001");
          expect(picked.notes).toEqual([
            "claude session s-gone was left out: .",
            "codex session c-1 was left out: .",
          ]);
        }),
        { history, claudeConfigDirs: [configDir] },
      );
    }).pipe(Effect.scoped),
  );
});
