import { describe, expect, it } from "@effect/vitest";
import type { AgentEvent, MessageId, RequestId, ServerEvent, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventHub } from "../events/event-hub.ts";
import { FakeAgentControl } from "./fake-agent.ts";
import { RuntimeTestLayer, waitFor } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

const messageId = "m1" as MessageId;

const tool = (toolCallId: string, toolName: string, input: unknown): AgentEvent =>
  ({
    type: "chunk",
    messageId,
    chunk: { type: "tool-input-available", toolCallId, toolName, input },
  }) as AgentEvent;

const running = Effect.gen(function* () {
  const runtimes = yield* ThreadRuntimes;
  const hub = yield* EventHub;
  const fake = yield* FakeAgentControl;
  const events: Array<ServerEvent> = [];
  yield* Effect.forkScoped(
    Stream.runForEach(
      hub.serverEvents(Effect.succeed<ServerEvent>({ type: "threads.snapshot", threads: [] })),
      (e) => Effect.sync(() => void events.push(e)),
    ),
  );
  yield* waitFor(
    "the subscription",
    Effect.sync(() => events.length > 0),
  );
  // A real folder: for a missing one the snapshot shows the missing-folder message instead.
  const root = mkdtempSync(join(tmpdir(), "gram-activity-"));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => rmSync(root, { recursive: true, force: true })),
  );
  const thread = yield* runtimes.create({
    projectRoot: root,
    checkout: { kind: "main", path: root },
    input: { text: "one" },
  });
  const session = yield* waitFor(
    "the first send",
    fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
  );
  const statuses = () =>
    events.flatMap((e) => (e.type === "thread.status" && e.threadId === thread.id ? [e] : []));
  yield* waitFor(
    "running",
    Effect.sync(() => statuses().at(-1)?.status === "running"),
  );
  return { runtimes, session, thread, statuses, root };
});

const details = (statuses: () => ReadonlyArray<{ readonly detail?: string }>) =>
  statuses().map((s) => s.detail);

describe("ThreadRuntimes activity line", () => {
  it.effect("publishes a throttled line from tool events and clears it on idle", () =>
    Effect.gen(function* () {
      const { runtimes, session, thread, statuses, root } = yield* running;

      yield* session.emit(
        { type: "chunk", messageId, chunk: { type: "start", messageId } },
        tool("a", "Read", { file_path: join(root, "src", "app.ts") }),
      );
      yield* TestClock.adjust("250 millis");
      yield* waitFor(
        "the read line",
        Effect.sync(() => details(statuses).includes("Reading src/app.ts")),
      );

      yield* session.emit(
        tool("b", "Bash", { command: "pnpm test" }),
        tool("c", "Edit", { file_path: join(root, "a.ts") }),
        tool("d", "Edit", { file_path: join(root, "b.ts") }),
      );
      for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
      expect(details(statuses).at(-1)).toBe("Reading src/app.ts");

      yield* TestClock.adjust("250 millis");
      yield* waitFor(
        "the throttled line",
        Effect.sync(() => details(statuses).at(-1) === "Editing 2 files"),
      );
      expect(details(statuses)).not.toContain("Running pnpm test");
      const [summary] = yield* runtimes.snapshot;
      expect(summary?.activity).toBe("Editing 2 files");

      yield* session.completeTurn();
      yield* waitFor(
        "idle",
        Effect.sync(() => statuses().at(-1)?.status === "idle"),
      );
      expect(statuses().at(-1)).not.toHaveProperty("detail");
      const [after] = yield* runtimes.snapshot;
      expect(after?.thread.id).toBe(thread.id);
      expect(after?.activity).toBeUndefined();
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("carries a compaction on thread.status and the snapshot while it lasts", () =>
    Effect.gen(function* () {
      const { runtimes, session, thread, statuses } = yield* running;
      const compaction = { startedAt: 1_000, preTokens: 182_000 };
      yield* session.emit({ type: "status", status: "compacting", compaction });
      yield* waitFor(
        "the compaction",
        Effect.sync(() => statuses().at(-1)?.compaction !== undefined),
      );
      expect(statuses().at(-1)).toMatchObject({
        status: "running",
        detail: "Compacting context",
        compaction,
      });
      // The trigger arrives a moment later (Claude's PreCompact hook), on the same status.
      yield* session.emit({
        type: "status",
        status: "compacting",
        compaction: { ...compaction, trigger: "auto" },
      });
      yield* waitFor(
        "the trigger",
        Effect.sync(() => statuses().at(-1)?.compaction?.trigger === "auto"),
      );
      const [during] = yield* runtimes.snapshot;
      expect(during?.compaction).toEqual({ ...compaction, trigger: "auto" });
      expect(yield* runtimes.compacting(thread.id)).toBe(true);
      // Ten silent minutes of compaction with a tool open aren't a stalled tool.
      yield* session.emit(tool("t", "Bash", { command: "pnpm build" }));
      yield* TestClock.adjust("11 minutes");
      expect(yield* runtimes.quiet(thread.id)).toBeUndefined();

      yield* session.emit({ type: "status", status: "running" });
      yield* waitFor(
        "the compaction's end",
        Effect.sync(() => statuses().at(-1)?.compaction === undefined),
      );
      expect(statuses().at(-1)?.status).toBe("running");
      expect(yield* runtimes.compacting(thread.id)).toBe(false);
      const [after] = yield* runtimes.snapshot;
      expect(after).not.toHaveProperty("compaction");
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("says it's waiting for approval with the status change", () =>
    Effect.gen(function* () {
      const { session, statuses } = yield* running;
      yield* session.emit(
        {
          type: "request",
          request: {
            kind: "approval",
            id: "r1" as RequestId,
            toolName: "Bash",
            displayName: "Bash",
            input: { command: "git push" },
            suggestions: [],
          },
        },
        { type: "status", status: "awaitingApproval" },
      );
      yield* waitFor(
        "the approval status",
        Effect.sync(() => statuses().some((s) => s.status === "needsApproval")),
      );
      expect(statuses().find((s) => s.status === "needsApproval")?.detail).toBe(
        "Waiting for approval",
      );
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect(
    "keeps a compaction and its clock through a provider retry and reconnect snapshot",
    () =>
      Effect.gen(function* () {
        const { runtimes, session, thread, statuses } = yield* running;
        const compaction = { startedAt: 1_000, preTokens: 186_375, trigger: "auto" as const };
        yield* session.emit({ type: "status", status: "compacting", compaction });
        yield* waitFor(
          "compacting",
          Effect.sync(() => statuses().at(-1)?.compaction !== undefined),
        );
        yield* session.emit({
          type: "status",
          status: "retrying",
          detail: "Reconnecting",
          compaction,
        });
        yield* waitFor(
          "retrying",
          Effect.sync(() => statuses().at(-1)?.detail === "Reconnecting"),
        );
        expect(statuses().at(-1)?.compaction).toEqual(compaction);
        expect((yield* runtimes.snapshot)[0]?.compaction).toEqual(compaction);
        expect(yield* runtimes.compacting(thread.id)).toBe(true);
        yield* session.emit({ type: "status", status: "compacting", compaction });
        yield* TestClock.adjust("250 millis");
        yield* waitFor(
          "reconnected",
          Effect.sync(() => statuses().at(-1)?.detail === "Compacting context"),
        );
        expect((yield* runtimes.snapshot)[0]?.compaction?.startedAt).toBe(1_000);
        yield* session.emit({ type: "status", status: "running" });
        yield* waitFor(
          "compaction completed",
          Effect.sync(() => statuses().at(-1)?.compaction === undefined),
        );
        expect((yield* runtimes.snapshot)[0]).not.toHaveProperty("compaction");
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  for (const reason of ["completed", "interrupted", "error"] as const) {
    it.effect(`clears compaction on ${reason} and preserves a queued user input`, () =>
      Effect.gen(function* () {
        const { runtimes, session, thread, statuses } = yield* running;
        yield* session.emit({
          type: "status",
          status: "compacting",
          compaction: { startedAt: 1_000 },
        });
        yield* waitFor(
          "compacting",
          Effect.sync(() => statuses().at(-1)?.compaction !== undefined),
        );
        expect(yield* runtimes.send(thread.id, { text: "queued user instruction" })).toEqual({
          queued: true,
        });
        expect(session.sent).toHaveLength(1);
        // Completing the item resumes this turn; the queue still waits for its terminal event.
        if (reason === "completed") {
          yield* session.emit({ type: "status", status: "running" });
          yield* waitFor(
            "item completed",
            Effect.sync(() => statuses().at(-1)?.compaction === undefined),
          );
          expect(session.sent).toHaveLength(1);
        }
        yield* session.emit({ type: "turnEnd", reason });
        yield* waitFor(
          "queued input delivered",
          Effect.sync(() => session.sent.length === 2),
        );
        expect(session.sent[1]?.text).toBe("queued user instruction");
        expect((yield* runtimes.snapshot)[0]).not.toHaveProperty("compaction");
      }).pipe(Effect.provide(RuntimeTestLayer)),
    );
  }

  it.effect("keeps a background subagent's line while the thread is idle, then clears it", () =>
    Effect.gen(function* () {
      const { runtimes, session, statuses } = yield* running;
      const subagent = "sub-1" as MessageId;
      yield* session.emit(
        { type: "chunk", messageId, chunk: { type: "start", messageId } },
        tool("bg1", "Agent", { description: "List files", subagent_type: "Explore" }),
        {
          type: "chunk",
          messageId: subagent,
          chunk: {
            type: "start",
            messageId: subagent,
            messageMetadata: { parentToolUseId: "bg1" },
          },
        } as AgentEvent,
        { type: "chunk", messageId: subagent, chunk: { type: "reasoning-start", id: "r" } },
        { type: "chunk", messageId, chunk: { type: "finish" } },
        { type: "turnEnd", reason: "completed" },
      );
      yield* waitFor(
        "idle with the subagent's line",
        Effect.sync(() => {
          const last = statuses().at(-1);
          return last?.status === "idle" && last.detail === "Explore: Thinking";
        }),
      );
      expect((yield* runtimes.snapshot)[0]?.activity).toBe("Explore: Thinking");

      yield* session.emit({ type: "chunk", messageId: subagent, chunk: { type: "finish" } });
      yield* TestClock.adjust("250 millis");
      yield* waitFor(
        "the cleared line",
        Effect.sync(() => {
          const last = statuses().at(-1);
          return last?.status === "idle" && last.detail === undefined;
        }),
      );
      expect((yield* runtimes.snapshot)[0]?.activity).toBeUndefined();
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});

export type { ThreadId };
