// A running memory update reads its own workspace's past conversations, and nothing else does.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { hasGit } from "../git/test-repo.ts";
import { openOrchestrator } from "./test-harness.ts";
import { finishDream, inDreams, startDream, writeOutput } from "./dreams-service-kit.ts";
import { pageOf, TRANSCRIPT_READ_MAX_CHARS } from "./transcript-read-tool.ts";
import type { TranscriptBlock } from "./transcripts.ts";

const block = (seq: number, body: string): TranscriptBlock => ({
  seq,
  id: `m${seq}`,
  role: seq % 2 === 0 ? "user" : "assistant",
  body,
  at: Date.UTC(2026, 10, 1 + seq),
});

describe("pageOf", () => {
  it("reads from a seq, within the count and the size, and says where to read on", () => {
    const blocks = [1, 2, 3, 4, 5].map((seq) => block(seq, `message ${seq}`));
    expect(pageOf(blocks, 2, 2)).toEqual({
      messages: [
        { seq: 2, role: "user", date: "2026-11-03", text: "message 2" },
        { seq: 3, role: "assistant", date: "2026-11-04", text: "message 3" },
      ],
      next: 4,
    });
    expect(pageOf(blocks, 5, 10)).toEqual({
      messages: [{ seq: 5, role: "assistant", date: "2026-11-06", text: "message 5" }],
    });
    expect(pageOf(blocks, 9, 10)).toEqual({ messages: [] });
    // Big messages are cut, and a page stops before it would pass the cap, but holds one at least.
    const big = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map((seq) =>
      block(seq, "x".repeat(10_000)),
    );
    const page = pageOf(big, 0, 60);
    expect(page.messages[0]!.text).toContain("more characters]");
    const total = page.messages.reduce((sum, m) => sum + m.text.length, 0);
    expect(total).toBeLessThanOrEqual(TRANSCRIPT_READ_MAX_CHARS);
    expect(page.next).toBe(page.messages.length + 1);
  });
});

describe.skipIf(!hasGit)("read_transcript", () => {
  it.effect("reads the workspace's threads only while the memory update runs", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const { thread, session: orchestrator, workspaceId } = yield* openOrchestrator(world);
        const { dream, session } = yield* startDream(workspaceId);

        const read = (yield* session.callTool("read_transcript", {
          threadId: thread.id,
        })) as { threadId: string; source: string; messages: ReadonlyArray<{ seq: number }> };
        expect(read).toMatchObject({ threadId: thread.id, source: "thread" });
        expect(read.messages.length).toBeGreaterThan(0);

        // The snapshot's index names the orchestrator's session, so the dream can choose.
        const index = String(yield* session.callTool("dream_read", { path: "input/INDEX.md" }));
        expect(index).toContain("# Sessions in this snapshot");
        expect(index).toContain("001-orchestrator-shop.md");
        expect(index).toContain("orchestrator");

        // Its own thread, and an id that names nothing, are not conversations to read.
        for (const threadId of [dream.threadId!, "no-such-thread"]) {
          expect(
            yield* Effect.flip(session.callTool("read_transcript", { threadId })),
          ).toMatchObject({ _tag: "AppToolError" });
        }
        // The orchestrator is not given the tool at all.
        expect(
          yield* Effect.flip(orchestrator.callTool("read_transcript", { threadId: thread.id })),
        ).toBeDefined();

        // Once the dream has ended, its thread keeps its role, not its reach.
        writeOutput(dream, { "MEMORY.md": "# Memory index\n" });
        yield* finishDream(dream, session, "completed");
        expect(
          yield* Effect.flip(session.callTool("read_transcript", { threadId: thread.id })),
        ).toMatchObject({ _tag: "AppToolError" });
      }),
    ),
  );
});
