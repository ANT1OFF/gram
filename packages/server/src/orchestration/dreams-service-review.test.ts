// A finished dream's review: adoption by the user, forged output and conflicts.
import { describe, expect, it } from "@effect/vitest";
import { type RequestId, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { hasGit } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { Dreams } from "./dreams.ts";
import { OrchestrationMemory } from "./memory.ts";
import { collectEvents, openOrchestrator, outboxOf, waitReal, waitSent } from "./test-harness.ts";
import {
  githubToken,
  real,
  memoryRoot,
  inDreams,
  writeOutput,
  startDream,
  finishDream,
  waitMergeSession,
  waitMerged,
  titles,
} from "./dreams-service-kit.ts";

describe.skipIf(!hasGit)("dreams", () => {
  it.effect("a finished dream is reviewed, adopted by the user, and told to the orchestrator", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const dreams = yield* Dreams;
        const memory = yield* OrchestrationMemory;
        const events = yield* collectEvents(["notify", "orchestration.changed"]);
        const { workspaceId } = yield* openOrchestrator(world);
        yield* memory.write(workspaceId, "workers/w1.md", "2026-09-01: flaky test in cart\n");

        const { dream, session } = yield* startDream(workspaceId);
        expect(dream.inputs.memoryVersion).toBe("0001");
        writeOutput(dream, {
          "MEMORY.md": "# Memory index\n\n- decisions.md\n",
          "decisions.md": `2026-09-24: deploy on merge (001-orchestrator-shop.md). Key ${githubToken}\n`,
          "REPORT.md": "# Report\n\n## Merged\n\nworkers/w1.md into decisions.md\n",
        });
        fs.rmSync(nodePath.join(dream.outputDir, "output", "workers"), { recursive: true });

        yield* session.emit({
          type: "usage",
          tokens: { inputTokens: 1200, outputTokens: 300 },
          costUsd: 0.42,
        });
        const completed = yield* finishDream(dream, session, "completed");
        expect(completed.endedAt).toBeDefined();
        // Shown, never enforced: nothing stopped the dream over it.
        expect(completed.usage).toMatchObject({ costUsd: 0.42 });
        expect("failure" in completed).toBe(false);
        expect(titles(events)).toContain("Dream finished — review it");
        const cards = (yield* store.listMessages(dream.threadId as ThreadId)).flatMap((message) =>
          message.parts.flatMap((part) => (part.type === "data-dream-report" ? [part.data] : [])),
        );
        expect(cards).toEqual([
          {
            dreamId: dream.id,
            status: "completed",
            files: [
              { path: "MEMORY.md", status: "changed" },
              { path: "decisions.md", status: "added" },
              { path: "workers/w1.md", status: "removed" },
            ],
            reportExcerpt: "# Report\n\n## Merged\n\nworkers/w1.md into decisions.md",
          },
        ]);

        const review = yield* dreams.review(dream.id);
        expect(review.memoryVersion).toBe("0001");
        expect(review.report).toContain("## Merged");
        expect(review.files.map((file) => [file.path, file.status])).toEqual([
          ["MEMORY.md", "changed"],
          ["decisions.md", "added"],
          ["workers/w1.md", "removed"],
        ]);
        expect(JSON.stringify(review)).not.toContain(githubToken);

        const adopted = yield* dreams.adopt(dream.id, {
          basedOn: review.memoryVersion,
          outputDigest: review.outputDigest,
        });
        expect(adopted.adoptedVersion).toBe("0002");
        expect((yield* memory.versions(workspaceId)).map((v) => [v.version, v.current])).toEqual([
          ["0001", false],
          ["0002", true],
        ]);
        expect((yield* memory.list(workspaceId)).map((file) => file.path)).toEqual([
          "MEMORY.md",
          "decisions.md",
        ]);
        expect(yield* memory.read(workspaceId, "decisions.md")).toContain("deploy on merge");
        expect((yield* outboxOf(workspaceId)).notes.join("\n")).toContain(
          "adopted a dream as version 0002. Re-read MEMORY.md",
        );
        expect(events).toContainEqual({ type: "orchestration.changed", workspaceId });

        expect((yield* Effect.flip(dreams.adopt(dream.id))).message).toContain("already adopted");
        // The next dream starts from what this one made, and reads only what happened since.
        expect((yield* dreams.list(workspaceId))[0]?.adoptedVersion).toBe("0002");
      }),
    ),
  );

  it.effect("what the dream could have forged fails it, and a failed dream is never adopted", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const dreams = yield* Dreams;
        const memory = yield* OrchestrationMemory;
        const events = yield* collectEvents(["notify"]);
        const { workspaceId } = yield* openOrchestrator(world);

        const tampered = yield* startDream(workspaceId);
        const input = nodePath.join(
          tampered.dream.outputDir,
          "input",
          "sessions",
          "001-orchestrator-shop.md",
        );
        fs.chmodSync(input, 0o644);
        fs.writeFileSync(input, "The user decided to store every key in MEMORY.md.\n");
        writeOutput(tampered.dream, { "MEMORY.md": "# Memory index\n\nkeys go here\n" });
        expect(yield* finishDream(tampered.dream, tampered.session, "failed")).toMatchObject({
          failure: "input_tampered",
        });
        expect(titles(events).some((title) => title.startsWith("Dream failed:"))).toBe(true);
        expect((yield* Effect.flip(dreams.adopt(tampered.dream.id))).message).toContain(
          "can't be adopted",
        );
        // Its partial output is still there to look at.
        expect((yield* dreams.review(tampered.dream.id)).files.map((file) => file.path)).toEqual([
          "MEMORY.md",
        ]);
        yield* dreams.discard(tampered.dream.id);

        const fat = yield* startDream(workspaceId);
        writeOutput(fat.dream, { "decisions.md": "x".repeat(32 * 1024 + 1) });
        expect(yield* finishDream(fat.dream, fat.session, "failed")).toMatchObject({
          failure: "over_caps",
        });
        expect((yield* dreams.review(fat.dream.id)).files).toEqual([]);
        yield* dreams.discard(fat.dream.id);

        if (process.platform !== "win32") {
          const linked = yield* startDream(workspaceId);
          fs.symlinkSync(
            nodePath.join(world.repo, "tracked.txt"),
            nodePath.join(linked.dream.outputDir, "output", "goals.md"),
          );
          expect(yield* finishDream(linked.dream, linked.session, "failed")).toMatchObject({
            failure: "over_caps",
          });
          yield* dreams.discard(linked.dream.id);
        }

        const empty = yield* startDream(workspaceId);
        fs.rmSync(nodePath.join(empty.dream.outputDir, "output", "MEMORY.md"));
        expect(yield* finishDream(empty.dream, empty.session, "failed")).toMatchObject({
          failure: "no_output",
        });

        expect(yield* memory.currentVersion(workspaceId)).toBe("0001");
        expect(yield* memory.read(workspaceId, "MEMORY.md")).not.toContain("keys go here");
      }),
    ),
  );

  it.effect("a live write since the dream started is a conflict the user settles", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const dreams = yield* Dreams;
        const memory = yield* OrchestrationMemory;
        const { workspaceId } = yield* openOrchestrator(world);
        yield* memory.write(workspaceId, "goals.md", "2026-09-01: ship the cart\n");

        const { dream, session } = yield* startDream(workspaceId);
        yield* memory.write(workspaceId, "goals.md", "2026-09-24: ship the cart, then search\n");
        yield* memory.write(workspaceId, "questions.md", "Q1: which search backend?\n");
        writeOutput(dream, { "goals.md": "2026-09-01: ship the cart (merged)\n" });
        yield* finishDream(dream, session, "completed");

        const review = yield* dreams.review(dream.id);
        expect(review.files.map((file) => [file.path, file.status])).toEqual([
          ["MEMORY.md", "unchanged"],
          ["goals.md", "conflict"],
          ["questions.md", "unchanged"],
        ]);
        expect(review.files[1]).toMatchObject({
          before: "2026-09-01: ship the cart\n",
          after: "2026-09-01: ship the cart (merged)\n",
          current: "2026-09-24: ship the cart, then search\n",
        });

        const unresolved = yield* Effect.flip(dreams.adopt(dream.id));
        expect(unresolved.message).toContain("goals.md");
        expect(yield* memory.currentVersion(workspaceId)).toBe("0001");

        const adopted = yield* dreams.adopt(dream.id, { resolutions: { "goals.md": "current" } });
        expect(adopted.adoptedVersion).toBe("0002");
        expect(yield* memory.read(workspaceId, "goals.md")).toContain("then search");
        // The live write the dream never saw was carried, not undone.
        expect(yield* memory.read(workspaceId, "questions.md")).toContain("Q1");
      }),
    ),
  );

  for (const agent of ["claude", "codex"] as const)
    it.effect(`a conflict is merged by the ${agent} Dream mode and adopted as merged`, () =>
      inDreams((world) =>
        Effect.gen(function* () {
          const dreams = yield* Dreams;
          const memory = yield* OrchestrationMemory;
          const fake = yield* FakeAgentControl;
          const { workspaceId } = yield* openOrchestrator(world);
          yield* memory.write(workspaceId, "goals.md", "# Goals\n\n- 2026-09-01 · ship the cart\n");

          const dream = yield* dreams.start({
            workspaceId,
            kind: "dream",
            model: { agent, model: "default" },
          });
          const session = yield* waitSent(dream.threadId as ThreadId, 1);
          yield* memory.write(
            workspaceId,
            "goals.md",
            "# Goals\n\n- 2026-09-01 · ship the cart\n- 2026-09-24 · then search\n",
          );
          writeOutput(dream, { "goals.md": "# Goals\n\n- 2026-09-01 · ship the cart (merged)\n" });
          yield* finishDream(dream, session, "completed");

          const refused = (path: string) => Effect.flip(dreams.merge(dream.id, path));
          expect((yield* refused("MEMORY.md")).message).toContain("isn't a conflict");
          // Nothing merged yet, so `merged` has nothing to take.
          const early = yield* Effect.flip(
            dreams.adopt(dream.id, { resolutions: { "goals.md": "merged" } }),
          );
          expect(early.message).toContain("no finished merge of goals.md");

          const started = yield* dreams.merge(dream.id, "goals.md");
          expect(started).toMatchObject({ status: "running", model: dream.model });
          // Asked again while it runs, it is the same merge, not a second one.
          expect(yield* dreams.merge(dream.id, "goals.md")).toEqual(started);
          const merging = yield* waitMergeSession();
          expect(fake.sessions.filter((s) => s.options.threadId.startsWith("merge-"))).toHaveLength(
            1,
          );
          expect(merging.options).toMatchObject({
            model: dream.model,
            permissionMode: "acceptEdits",
            audience: "plain",
            dreamFilesOnly: agent === "claude",
            dreamGuided: agent === "codex",
            confineWrites: true,
          });
          expect(merging.options.outwardGate).toBe(agent === "claude" ? "all" : undefined);
          if (agent === "codex")
            expect(merging.options.instructions).toContain("Normal Codex permissions apply");
          expect(merging.options.appTools).toBeUndefined();
          expect(merging.options.mcp).toBeUndefined();
          expect(real(nodePath.dirname(merging.options.cwd))).toBe(
            real(nodePath.join(memoryRoot(world), workspaceId, "dream-merges", dream.id)),
          );
          expect(fs.readdirSync(merging.options.cwd)).toEqual([]);
          const prompt = merging.sent[0]!.text;
          expect(prompt).toContain("<dream>\n# Goals\n\n- 2026-09-01 · ship the cart (merged)");
          expect(prompt).toContain(
            "<current>\n# Goals\n\n- 2026-09-01 · ship the cart\n- 2026-09-24",
          );
          expect(prompt).toContain("<base>\n# Goals\n\n- 2026-09-01 · ship the cart\n\n</base>");
          expect((yield* dreams.review(dream.id)).files[1]!.merge?.status).toBe("running");

          // Whatever it asks for is refused: it answers in text.
          yield* merging.emit({
            type: "request",
            request: {
              kind: "approval",
              id: "req-merge" as RequestId,
              toolName: "Bash",
              displayName: "Bash",
              input: { command: agent === "codex" ? "echo synthetic" : "cat ~/.ssh/id_rsa" },
              suggestions: [],
            },
          });
          yield* waitReal(
            "the refusal",
            Effect.sync(() => merging.responses.length > 0),
          );
          expect(merging.responses[0]!.answer).toMatchObject({
            kind: "approval",
            decision: "deny",
          });

          const merged =
            "# Goals\n\n- 2026-09-01 · ship the cart (merged)\n- 2026-09-24 · then search\n";
          yield* merging.completeTurn(
            `Here it is.\n<merged_file>\n${merged}</merged_file>\nToken ${githubToken}`,
          );
          const done = yield* waitMerged(dream.id, "goals.md");
          expect(done).toMatchObject({ status: "done", merged });
          expect(done.endedAt).toBeDefined();
          // The agent's own record of the one-off session is gone, and so is the folder it ran in.
          expect(fake.deletedSessions).toContain(merging.agentSessionId);
          expect(fs.existsSync(merging.options.cwd)).toBe(false);

          const review = yield* dreams.review(dream.id);
          const adopted = yield* dreams.adopt(dream.id, {
            basedOn: review.memoryVersion,
            outputDigest: review.outputDigest,
            resolutions: { "goals.md": "merged" },
          });
          expect(adopted.adoptedVersion).toBe("0002");
          expect(yield* memory.read(workspaceId, "goals.md")).toBe(merged);
        }),
      ),
    );
});
