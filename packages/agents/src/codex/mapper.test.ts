import { fileEditsOf, MessageId, type AgentEvent } from "@gram/contracts";
import { describe, expect, it } from "vitest";
import { codexFailure, httpFailure } from "../failure.ts";
import { hunksOf, makeCodexMapper, type CodexCompactionPhase } from "./mapper.ts";
import type { ServerNotification } from "./protocol/ServerNotification.ts";
import type { ThreadItem } from "./protocol/v2/ThreadItem.ts";
import { codexFixture, serverMessages } from "./testing.ts";

/** Replays a fixture's notifications through a fresh mapper. */
const replay = (name: string, gateway = false): Array<AgentEvent> => {
  let n = 0;
  const mapper = makeCodexMapper({
    newMessageId: () => MessageId.make(`m${++n}`),
    freshSession: true,
    gateway,
  });
  return serverMessages(codexFixture(name))
    .filter((message) => !("id" in message))
    .flatMap((message) => mapper.map(message as ServerNotification));
};

const chunks = (events: ReadonlyArray<AgentEvent>) =>
  events.flatMap((event) => (event.type === "chunk" ? [event.chunk] : []));

const text = (events: ReadonlyArray<AgentEvent>, type: "text-delta" | "reasoning-delta") =>
  chunks(events)
    .flatMap((chunk) => (chunk.type === type ? [chunk.delta] : []))
    .join("");

const turnIdOf = (name: string): string => {
  const started = serverMessages(codexFixture(name)).find((m) => m.method === "turn/started");
  return (started as { params: { turn: { id: string } } }).params.turn.id;
};

const controls = (events: ReadonlyArray<AgentEvent>) =>
  events
    .filter((event) => event.type !== "chunk")
    .map((event) => (event.type === "status" ? `status:${event.status}` : event.type));

/** Codex's rolling limits update: a 5-hour window at `primary`%, a weekly one at 30%. */
const limitsUpdate = (
  rateLimitReachedType: "rate_limit_reached" | null,
  primary: number,
  limitId: string | null = "codex",
): ServerNotification => ({
  method: "account/rateLimits/updated",
  params: {
    rateLimits: {
      limitId,
      limitName: null,
      normalModelSlug: null,
      primary: { usedPercent: primary, windowDurationMins: 300, resetsAt: 1_790_000_000 },
      secondary: { usedPercent: 30, windowDurationMins: 10_080, resetsAt: null },
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: null,
      rateLimitReachedType,
    },
  },
});

describe("makeCodexMapper", () => {
  it("retains a native image view's actual source instead of an empty result", () => {
    const mapper = makeCodexMapper({ newMessageId: () => MessageId.make("image-message") });
    const events = mapper.map({
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: "turn",
        completedAtMs: 1,
        item: { type: "imageView", id: "view", path: "/synthetic/shot.png" },
      },
    });
    expect(chunks(events)).toContainEqual({
      type: "tool-output-available",
      toolCallId: "view",
      output: { type: "image", path: "/synthetic/shot.png" },
      providerExecuted: true,
      dynamic: true,
    });
    expect(events.filter((event) => event.type === "toolImageSource")).toEqual([
      {
        type: "toolImageSource",
        origin: "codex-image-view",
        messageId: "image-message",
        toolCallId: "view",
        path: "/synthetic/shot.png",
      },
    ]);
    expect(events.filter((event) => event.type === "toolImageRead")).toEqual([
      {
        type: "toolImageRead",
        origin: "codex-image-view",
        messageId: "image-message",
        toolCallId: "view",
        path: "/synthetic/shot.png",
      },
    ]);
    expect(events.findIndex((event) => event.type === "toolImageRead")).toBeLessThan(
      events.findIndex((event) => event.type === "toolImageSource"),
    );
    expect(events.findIndex((event) => event.type === "toolImageSource")).toBeLessThan(
      events.findIndex(
        (event) => event.type === "chunk" && event.chunk.type === "tool-output-available",
      ),
    );
  });

  it("stores a patch's file changes as an Edit the shared file-edit shape reads per file", () => {
    const mapper = makeCodexMapper({ newMessageId: () => MessageId.make("patch") });
    const item: Omit<Extract<ThreadItem, { type: "fileChange" }>, "status"> = {
      type: "fileChange",
      id: "patch-1",
      changes: [
        {
          path: "/synthetic/a.ts",
          kind: { type: "update", move_path: "/synthetic/b.ts" },
          diff: "@@ -3,3 +3,4 @@\n x\n-old\n+new\n+more\n y\n",
        },
        { path: "/synthetic/c.ts", kind: { type: "add" }, diff: "one\ntwo\n" },
        { path: "/synthetic/d.ts", kind: { type: "delete" }, diff: "gone\n" },
      ],
    };
    const params = { threadId: "thread", turnId: "turn" };
    const events = [
      ...mapper.map({
        method: "item/started",
        params: { ...params, startedAtMs: 1, item: { ...item, status: "inProgress" } },
      }),
      ...mapper.map({
        method: "item/completed",
        params: { ...params, completedAtMs: 2, item: { ...item, status: "completed" } },
      }),
    ];
    const input = chunks(events).find((chunk) => chunk.type === "tool-input-available");
    const output = chunks(events).find((chunk) => chunk.type === "tool-output-available");
    expect(input).toMatchObject({ toolName: "Edit" });
    const edits = fileEditsOf(
      input?.type === "tool-input-available" ? input.toolName : "",
      input?.type === "tool-input-available" ? input.input : undefined,
      output?.type === "tool-output-available" ? output.output : undefined,
    );
    expect(
      edits.map(({ path, movedTo, kind, additions, deletions, numbered }) => ({
        path,
        movedTo,
        kind,
        additions,
        deletions,
        numbered,
      })),
    ).toEqual([
      {
        path: "/synthetic/a.ts",
        movedTo: "/synthetic/b.ts",
        kind: "modify",
        additions: 2,
        deletions: 1,
        numbered: true,
      },
      {
        path: "/synthetic/c.ts",
        movedTo: undefined,
        kind: "create",
        additions: 2,
        deletions: 0,
        numbered: true,
      },
      {
        path: "/synthetic/d.ts",
        movedTo: undefined,
        kind: "delete",
        additions: 0,
        deletions: 1,
        numbered: true,
      },
    ]);
    expect(edits[0]?.hunks).toEqual([
      {
        oldStart: 3,
        oldLines: 3,
        newStart: 3,
        newLines: 4,
        lines: [" x", "-old", "+new", "+more", " y"],
      },
    ]);
  });

  it("refuses native image admission from another provider thread", () => {
    const mapper = makeCodexMapper({
      newMessageId: () => MessageId.make("native"),
      threadId: "owner",
    });
    const item = { type: "imageView", id: "view", path: "/tmp/synthetic.png" } as const;
    const params = { threadId: "other", turnId: "turn", item };
    for (const notification of [
      { method: "item/started", params: { ...params, startedAtMs: 1 } },
      { method: "item/completed", params: { ...params, completedAtMs: 1 } },
    ] satisfies ServerNotification[]) {
      expect(mapper.map(notification)).toEqual([]);
    }
  });

  it("admits native images once in their owning turn, including completion-only new turns", () => {
    let id = 0;
    const mapper = makeCodexMapper({ newMessageId: () => MessageId.make(`image-${++id}`) });
    const image = (turnId: string, path = "/synthetic/shot.png", method = "item/completed") =>
      mapper.map({
        method,
        params: {
          threadId: "thread",
          turnId,
          completedAtMs: 1,
          item: { type: "imageView", id: "view", path },
        },
      } as ServerNotification);
    const end = (turnId: string) =>
      mapper.map({
        method: "turn/completed",
        params: {
          threadId: "thread",
          turn: {
            id: turnId,
            rootTurnId: null,
            status: "completed",
            items: [],
            itemsView: "full",
            error: null,
            startedAt: 1,
            completedAt: 2,
            durationMs: 1,
          },
        },
      });
    expect(image("A").filter((event) => event.type === "toolImageSource")).toHaveLength(1);
    expect(image("A", "/synthetic/changed.png")).toEqual([]);
    end("A");
    expect(image("A")).toEqual([]);
    expect(image("A", undefined, "item/started")).toEqual([]);
    expect(image("B", undefined, "item/started")).not.toEqual([]);
    expect(image("unowned")).toEqual([]);
    expect(image("B", "/synthetic/wrong.png")).toEqual([]);
    expect(image("B").filter((event) => event.type === "toolImageSource")).toHaveLength(1);
    end("B");
    expect(image("C").filter((event) => event.type === "toolImageSource")).toHaveLength(1);
  });

  it("extracts native dynamic image blocks without fetching output-controlled URLs", () => {
    const mapper = makeCodexMapper({ newMessageId: () => MessageId.make("image-message") });
    const events = mapper.map({
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: "turn",
        completedAtMs: 1,
        item: {
          type: "dynamicToolCall",
          id: "view",
          namespace: "functions",
          tool: "view_image",
          arguments: { path: "/synthetic/image.png" },
          status: "completed",
          success: true,
          durationMs: 1,
          contentItems: [
            { type: "inputText", text: "Viewed" },
            { type: "inputImage", imageUrl: "data:image/png;base64,aGVsbG8=" },
            { type: "inputImage", imageUrl: "https://example.com/private.png" },
          ],
        },
      },
    });
    expect(
      events.filter((e) => e.type === "toolImageRead" || e.type === "toolImageSource"),
    ).toEqual([]);
    expect(events.filter((e) => e.type === "toolImage")).toEqual([
      {
        type: "toolImage",
        messageId: "image-message",
        toolCallId: "view",
        mediaType: "image/png",
        data: "aGVsbG8=",
      },
    ]);
    expect(chunks(events).at(-1)).toMatchObject({
      type: "tool-output-available",
      output: [
        { type: "inputText", text: "Viewed" },
        { type: "inputImage", mediaType: "image/png" },
        { type: "inputImage", imageUrl: "https://example.com/private.png" },
      ],
    });
    expect(events.findIndex((e) => e.type === "toolImage")).toBeLessThan(events.length - 1);
  });
  it("reports Codex's 5-hour and weekly limits as readings, a reached one as rejected", () => {
    const mapper = makeCodexMapper({ newMessageId: () => MessageId.make("m"), freshSession: true });
    expect(mapper.map(limitsUpdate(null, 85))).toEqual([
      {
        type: "rateLimit",
        status: "allowed",
        window: "five_hour",
        utilization: 0.85,
        resetsAt: 1_790_000_000_000,
      },
      { type: "rateLimit", status: "allowed", window: "seven_day", utilization: 0.3 },
    ]);
    expect(mapper.map(limitsUpdate("rate_limit_reached", 100))[0]).toMatchObject({
      status: "rejected",
      window: "five_hour",
      utilization: 1,
    });
  });

  it("reads only the account's snapshot, not another limit bucket's", () => {
    const mapper = makeCodexMapper({ newMessageId: () => MessageId.make("m"), freshSession: true });
    expect(mapper.map(limitsUpdate(null, 97, "codex_bengalfox"))).toEqual([]);
    // A snapshot that doesn't say which limit it is, as an older Codex sends, is the account's.
    expect(mapper.map(limitsUpdate(null, 40, null))).toHaveLength(2);
  });

  it("leaves out a window Codex doesn't name or sends empty", () => {
    const mapper = makeCodexMapper({ newMessageId: () => MessageId.make("m"), freshSession: true });
    expect(
      mapper.map({
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            limitId: "codex",
            limitName: null,
            normalModelSlug: null,
            primary: { usedPercent: 50, windowDurationMins: 60, resetsAt: null },
            secondary: null,
            credits: null,
            individualLimit: null,
            spendControlReached: null,
            planType: null,
            rateLimitReachedType: null,
          },
        },
      }),
    ).toEqual([]);
  });

  it("streams a turn's reasoning and text into one message, then usage, turn end and idle", () => {
    const events = replay("cx01-text");
    const all = chunks(events);
    expect(all[0]).toEqual({
      type: "start",
      messageId: "m1",
      messageMetadata: { agent: "codex", agentMessageIds: [turnIdOf("cx01-text")] },
    });
    expect(all.at(-1)).toEqual({ type: "finish" });
    expect(text(events, "reasoning-delta")).toBe("The user wants a greeting.");
    expect(text(events, "text-delta")).toBe("Hi there, how can I help?");
    expect(events.find((e) => e.type === "usage")).toEqual({
      type: "usage",
      telemetryVersion: "codex-request-delta-v1",
      tokens: {
        inputTokens: 42,
        outputTokens: 7,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 3,
      },
      contextWindow: 258400,
      // `tokenUsage.last.inputTokens`, cached input included.
      contextTokens: 42,
    });
    expect(controls(events)).toEqual([
      "status:running",
      "usage",
      "usage",
      "turnEnd",
      "status:idle",
    ]);
    expect(events.find((e) => e.type === "turnEnd")).toEqual({
      type: "turnEnd",
      reason: "completed",
    });
  });

  it("closes unfinished tools on interruption without changing completed tools", () => {
    const mapper = makeCodexMapper({ newMessageId: () => MessageId.make("cancelled-message") });
    const item = {
      type: "commandExecution",
      id: "pending",
      command: "echo blocked",
      cwd: "/synthetic",
      commandActions: [],
      status: "inProgress",
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };
    const notify = (method: string, params: unknown) =>
      mapper.map({ method, params } as ServerNotification);
    const events = [
      ...notify("turn/started", {
        threadId: "thread",
        turn: { id: "turn", status: "inProgress", items: [], error: null },
      }),
      ...notify("item/started", { threadId: "thread", turnId: "turn", item }),
      ...notify("item/completed", {
        threadId: "thread",
        turnId: "turn",
        item: {
          ...item,
          id: "completed",
          status: "completed",
          aggregatedOutput: "done",
          exitCode: 0,
        },
      }),
      ...notify("turn/completed", {
        threadId: "thread",
        turn: { id: "turn", status: "interrupted", items: [], error: null },
      }),
    ];
    expect(chunks(events).filter((c) => c.type === "tool-output-error")).toEqual([
      {
        type: "tool-output-error",
        toolCallId: "pending",
        errorText: "Cancelled",
        providerExecuted: true,
        dynamic: true,
      },
    ]);
    expect(chunks(events).findIndex((c) => c.type === "tool-output-error")).toBeLessThan(
      chunks(events).findIndex((c) => c.type === "finish"),
    );
    expect(mapper.flush()).toEqual([]);
    const recovery = notify("turn/started", {
      threadId: "thread",
      turn: { id: "recovery", status: "inProgress", items: [], error: null },
    });
    expect(chunks(recovery).some((c) => c.type === "tool-output-error")).toBe(false);
  });

  it("renders an approved command as a Bash card with its output", () => {
    const events = replay("cx02-approval");
    const all = chunks(events);
    expect(all).toContainEqual({
      type: "tool-input-available",
      toolCallId: "call_1",
      toolName: "Bash",
      input: { command: "echo hello", cwd: "$CWD" },
      providerExecuted: true,
      dynamic: true,
    });
    expect(all).toContainEqual({
      type: "tool-output-available",
      toolCallId: "call_1",
      output: { stdout: "hello\n", stderr: "", interrupted: false, exitCode: 0 },
      providerExecuted: true,
      dynamic: true,
    });
    expect(controls(events)).toEqual([
      "status:running",
      "status:awaitingApproval",
      "requestResolved",
      "status:running",
      "usage",
      "usage",
      "usage",
      "turnEnd",
      "status:idle",
    ]);
  });

  it("shows a declined new file as a Write card that failed, without reporting files", () => {
    const events = replay("cx03-file-change");
    expect(chunks(events)).toContainEqual({
      type: "tool-input-available",
      toolCallId: "call_2",
      toolName: "Write",
      input: { file_path: "$CWD/hello.txt", content: "hello\n" },
      providerExecuted: true,
      dynamic: true,
    });
    expect(chunks(events)).toContainEqual({
      type: "tool-output-error",
      toolCallId: "call_2",
      errorText: "Declined",
      providerExecuted: true,
      dynamic: true,
    });
    expect(events.some((e) => e.type === "files")).toBe(false);
  });

  it("marks a compaction Codex started itself with the context it compacted", () => {
    let n = 0;
    const mapper = makeCodexMapper({
      newMessageId: () => MessageId.make(`m${++n}`),
      now: () => 1_790_000_000_000,
    });
    const events = serverMessages(codexFixture("cx15-auto-compact"))
      .filter((message) => !("id" in message))
      .flatMap((message) => mapper.map(message as ServerNotification));
    const markers = chunks(events).filter((chunk) => chunk.type === "data-compaction");
    expect(markers).toEqual([
      {
        type: "data-compaction",
        id: expect.stringMatching(/^compaction:/),
        data: { trigger: "auto", preTokens: 42, at: 1_790_000_000_000 },
      },
    ]);
    // In the turn it happened in, ahead of that turn's answer.
    const second = events.filter((e) => e.type === "chunk" && e.messageId === "m2");
    expect(second.findIndex((e) => e.type === "chunk" && e.chunk.type === "data-compaction")).toBe(
      second.findIndex((e) => e.type === "chunk" && e.chunk.type === "text-start") - 1,
    );
    expect(events.filter((e) => e.type === "status" && e.status === "compacting")).toEqual([
      {
        type: "status",
        status: "compacting",
        compaction: { startedAt: 1_790_000_000_000, trigger: "auto", preTokens: 42 },
      },
    ]);
    // Live from the item's start to the marker, which its end brings.
    const live = events.findIndex((e) => e.type === "status" && e.status === "compacting");
    const marker = events.findIndex(
      (e) => e.type === "chunk" && e.chunk.type === "data-compaction",
    );
    expect(live).toBeGreaterThan(-1);
    expect(live).toBeLessThan(marker);
    expect(events[marker + 1]).toEqual({ type: "status", status: "running" });
  });

  it("marks the compaction a /compact asked for as the user's, and only that one", () => {
    let n = 0;
    const mapper = makeCodexMapper({ newMessageId: () => MessageId.make(`m${++n}`) });
    const messages = serverMessages(codexFixture("cx15-auto-compact")).filter(
      (message) => !("id" in message),
    );
    let round = 0;
    const triggers = (requested: boolean) => {
      // Each replay represents new turns on the same session, not duplicate finished turn IDs.
      const prefix = `round-${++round}:`;
      const input = messages.map((message) => {
        const copy = structuredClone(message) as ServerNotification;
        if ("turnId" in copy.params && typeof copy.params.turnId === "string")
          copy.params.turnId = prefix + copy.params.turnId;
        if ("turn" in copy.params) copy.params.turn.id = prefix + copy.params.turn.id;
        return copy;
      });
      // Asked for between turns, as a `/compact` is sent: here the fixture's second turn compacts.
      const firstEnds = input.findIndex((m) => m.method === "turn/completed") + 1;
      input.slice(0, firstEnds).forEach((message) => mapper.map(message));
      mapper.compactionRequested(requested);
      return input
        .slice(firstEnds)
        .flatMap((message) => mapper.map(message as ServerNotification))
        .flatMap((e) =>
          e.type === "chunk" && e.chunk.type === "data-compaction"
            ? [e.chunk.data.trigger]
            : e.type === "status" && e.compaction !== undefined
              ? [`live ${e.compaction.trigger}`]
              : [],
        );
    };
    expect(triggers(true)).toEqual(["live manual", "manual"]);
    expect(triggers(false)).toEqual(["live auto", "auto"]);

    // One asked for whose turn ended without it (interrupted) leaves the next to Codex.
    const fresh = makeCodexMapper({ newMessageId: () => MessageId.make(`f${++n}`) });
    fresh.compactionRequested(true);
    const later = messages
      .flatMap((message) => fresh.map(message as ServerNotification))
      .flatMap((e) =>
        e.type === "chunk" && e.chunk.type === "data-compaction" ? [e.chunk.data.trigger] : [],
      );
    expect(later).toEqual(["auto"]);
  });

  it("keeps compaction authoritative across active status, retries and duplicate starts", () => {
    let clock = 1_000;
    const mapper = makeCodexMapper({ newMessageId: () => MessageId.make("m"), now: () => clock });
    const notify = (method: string, params: unknown) =>
      mapper.map({ method, params } as ServerNotification);
    const item = { type: "contextCompaction", id: "compact" };
    const params = { threadId: "thread", turnId: "turn", item };
    mapper.compactionRequested(true);
    const started = notify("item/started", params);
    const activity = { startedAt: 1_000, trigger: "manual" };
    expect(started).toContainEqual({ type: "status", status: "compacting", compaction: activity });
    clock = 100_000;
    expect(notify("item/started", params)).toEqual([]);
    expect(
      notify("thread/status/changed", {
        threadId: "thread",
        status: { type: "active", activeFlags: [] },
      }),
    ).toEqual([]);
    const retry = notify("error", {
      threadId: "thread",
      turnId: "turn",
      willRetry: true,
      error: { message: "Reconnecting" },
    });
    expect(retry).toContainEqual({
      type: "status",
      status: "retrying",
      detail: "Reconnecting",
      compaction: activity,
    });
    expect(
      notify("thread/status/changed", {
        threadId: "thread",
        status: { type: "active", activeFlags: [] },
      }),
    ).toEqual([{ type: "status", status: "compacting", compaction: activity }]);
    const completed = notify("item/completed", params);
    expect(completed.at(-1)).toEqual({ type: "status", status: "running" });
    expect(chunks(completed)).toContainEqual({
      type: "data-compaction",
      id: "compaction:compact",
      data: { trigger: "manual", at: 100_000 },
    });
  });

  it("doesn't treat an active thread notification as compaction completion", () => {
    const mapper = makeCodexMapper({ newMessageId: () => MessageId.make("m") });
    mapper.map({
      method: "item/started",
      params: {
        threadId: "thread",
        turnId: "turn",
        startedAtMs: 1_000,
        item: { type: "contextCompaction", id: "compact" },
      },
    });
    expect(
      mapper.map({
        method: "thread/status/changed",
        params: {
          threadId: "thread",
          status: { type: "active", activeFlags: [] },
        },
      }),
    ).toEqual([]);
  });

  it("observes item duration independently of the remainder of the turn", () => {
    let clock = 1_000;
    const phases: Array<CodexCompactionPhase> = [];
    const mapper = makeCodexMapper({
      newMessageId: () => MessageId.make("m"),
      now: () => clock,
      onCompaction: (phase) => phases.push(phase),
    });
    const notify = (method: string, params: unknown) =>
      mapper.map({ method, params } as ServerNotification);
    const params = {
      threadId: "thread",
      turnId: "turn",
      item: { type: "contextCompaction", id: "compact" },
    };
    notify("item/started", params);
    clock = 117_000;
    notify("item/completed", params);
    clock = 130_000;
    notify("turn/completed", {
      threadId: "thread",
      turn: { id: "turn", status: "completed", items: [], error: null },
    });
    expect(phases).toEqual([
      {
        phase: "started",
        turnId: "turn",
        itemId: "compact",
        at: 1_000,
        startedAt: 1_000,
        trigger: "auto",
        elapsedMs: 0,
      },
      {
        phase: "completed",
        turnId: "turn",
        itemId: "compact",
        at: 117_000,
        startedAt: 1_000,
        trigger: "auto",
        elapsedMs: 116_000,
      },
    ]);
  });

  it("records newer CLI lifecycle timestamps separately from receipt time", () => {
    let clock = 1_000;
    const phases: Array<CodexCompactionPhase> = [];
    const mapper = makeCodexMapper({
      newMessageId: () => MessageId.make("m"),
      now: () => clock,
      onCompaction: (phase) => phases.push(phase),
    });
    const params = {
      threadId: "thread",
      turnId: "turn",
      item: { type: "contextCompaction" as const, id: "compact" },
    };
    mapper.map({ method: "item/started", params: { ...params, startedAtMs: 990 } });
    clock = 117_000;
    mapper.map({ method: "item/completed", params: { ...params, completedAtMs: 116_991 } });
    expect(phases).toMatchObject([
      { phase: "started", providerAt: 990, receivedAfterMs: 10 },
      { phase: "completed", providerAt: 116_991, receivedAfterMs: 9, elapsedMs: 116_000 },
    ]);
  });

  it.each(["failed", "interrupted", "exit"])(
    "forgets an unfinished compaction after %s",
    (status) => {
      const phases: Array<CodexCompactionPhase> = [];
      const mapper = makeCodexMapper({
        newMessageId: () => MessageId.make("m"),
        onCompaction: (phase) => phases.push(phase),
      });
      const notify = (method: string, params: unknown) =>
        mapper.map({ method, params } as ServerNotification);
      mapper.compactionRequested(true);
      notify("item/started", {
        threadId: "thread",
        turnId: "turn",
        item: { type: "contextCompaction", id: "compact" },
      });
      const ended =
        status === "exit"
          ? mapper.flush()
          : notify("turn/completed", {
              threadId: "thread",
              turn: { id: "turn", status, items: [], error: null },
            });
      expect(chunks(ended).some((c) => c.type === "data-compaction")).toBe(false);
      expect(phases.map((p) => p.phase)).toEqual([
        "started",
        status === "interrupted" ? "interrupted" : "failed",
      ]);
      expect(
        notify("turn/started", {
          threadId: "thread",
          turn: { id: "next", status: "inProgress", items: [], error: null },
        }).at(-1),
      ).toEqual({ type: "status", status: "running" });
      expect(
        notify("item/started", {
          threadId: "thread",
          turnId: "next",
          item: { type: "contextCompaction", id: "compact" },
        }).at(-1),
      ).toMatchObject({ type: "status", status: "compacting", compaction: { trigger: "auto" } });
    },
  );

  it("keeps a steered turn as one message and ends an interrupted one as interrupted", () => {
    const steered = replay("cx04-steer");
    expect(steered.filter((e) => e.type === "turnEnd")).toEqual([
      { type: "turnEnd", reason: "completed" },
    ]);
    expect(text(steered, "text-delta")).toContain("Short version: the end.");

    const interrupted = replay("cx05-interrupt");
    expect(interrupted.find((e) => e.type === "turnEnd")).toEqual({
      type: "turnEnd",
      reason: "interrupted",
    });
    expect(chunks(interrupted).at(-1)).toEqual({ type: "finish" });
  });

  it("ends a turn the model refused, such as for an effort it doesn't take, with the error", () => {
    const mapper = makeCodexMapper({ newMessageId: () => MessageId.make("m1") });
    const turn = {
      id: "turn_1",
      items: [],
      itemsView: "notLoaded",
      startedAt: 1,
      completedAt: null,
      durationMs: null,
    } as const;
    const message = "Unsupported value: 'xhigh' is not supported with this model.";
    const error = {
      message,
      codexErrorInfo: "badRequest",
      additionalDetails: null,
      misalignment: null,
    } as const;
    const events = [
      {
        method: "turn/started",
        params: { threadId: "thr_1", turn: { ...turn, status: "inProgress", error: null } },
      },
      { method: "error", params: { error, willRetry: false, threadId: "thr_1", turnId: "turn_1" } },
      {
        method: "turn/completed",
        params: { threadId: "thr_1", turn: { ...turn, status: "failed", error } },
      },
    ].flatMap((notification) => mapper.map(notification as ServerNotification));
    expect(events).toContainEqual({ type: "notice", level: "error", message });
    expect(events.find((e) => e.type === "turnEnd")).toEqual({
      type: "turnEnd",
      reason: "error",
      error: message,
      failure: { kind: "unknown", httpStatus: 400, code: "badRequest", retryable: false },
    });
  });
});

const turnEnd = (events: ReadonlyArray<AgentEvent>) => events.find((e) => e.type === "turnEnd");
const retries = (events: ReadonlyArray<AgentEvent>) =>
  events.flatMap((e) => (e.type === "status" && e.status === "retrying" ? [e.detail] : []));

describe("makeCodexMapper failures", () => {
  it("reads a gateway 429, whose body Codex never passes on, as the gateway refusing the request", () => {
    const events = replay("cx11-gateway-no-deployments", true);
    expect(retries(events)).toEqual([]);
    expect(turnEnd(events)).toEqual({
      type: "turnEnd",
      reason: "error",
      error: "exceeded retry limit, last status: 429 Too Many Requests",
      failure: {
        kind: "gatewayRefused",
        httpStatus: 429,
        code: "responseTooManyFailedAttempts",
        retryable: false,
      },
    });
  });

  it("reads the same 429 on the user's own provider as a rate limit worth retrying", () => {
    expect(turnEnd(replay("cx11-gateway-no-deployments"))).toMatchObject({
      failure: { kind: "rateLimit", httpStatus: 429, retryable: true },
    });
  });

  it("reads a disabled key's 403 as the cost guard, and gives each retry its status", () => {
    const events = replay("cx12-gateway-key-disabled", true);
    expect(retries(events)).toEqual([
      "Reconnecting... 1/2 (HTTP 403)",
      "Reconnecting... 2/2 (HTTP 403)",
    ]);
    expect(turnEnd(events)).toMatchObject({
      failure: {
        kind: "costGuard",
        httpStatus: 403,
        code: "httpConnectionFailed",
        retryable: false,
      },
    });
  });

  it("tells a gateway cooldown, which clears, from its filter, and reads the key's restrictions", () => {
    const noDeployments = "No deployments available for selected model, Try again in 20 seconds.";
    expect(httpFailure(429, `${noDeployments} cooldown_list=[]`)).toMatchObject({
      kind: "gatewayRefused",
      retryable: false,
    });
    expect(httpFailure(429, `${noDeployments} cooldown_list=['a1b2']`)).toMatchObject({
      kind: "rateLimit",
      retryable: true,
    });
    expect(httpFailure(403, "Model 'x' is restricted for this API key")).toMatchObject({
      kind: "modelUnavailable",
    });
    expect(httpFailure(undefined, "connect ECONNREFUSED 127.0.0.1:4000")).toEqual({
      kind: "network",
      retryable: true,
    });
  });

  it("reads Codex's errors without a status: a body passed on whole, and its own kinds", () => {
    const body =
      '{"error":{"message":"litellm.BadRequestError: AzureException - Unsupported value: \'none\'","code":"400"}}';
    expect(
      codexFailure({ message: body, codexErrorInfo: "other", additionalDetails: null }, true),
    ).toEqual({ kind: "unknown", httpStatus: 400, code: "other", retryable: false });
    expect(
      codexFailure(
        {
          message: "We’re currently experiencing high demand, which may cause temporary errors.",
          codexErrorInfo: "internalServerError",
          additionalDetails: null,
        },
        true,
      ),
    ).toEqual({ kind: "unknown", code: "internalServerError", retryable: true });
    expect(
      codexFailure(
        {
          message: "Reconnecting... 1/2",
          codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
          additionalDetails: null,
        },
        true,
      ),
    ).toEqual({ kind: "network", code: "responseStreamDisconnected", retryable: true });
  });

  it("reads a 401 as auth and a 404 as a model the gateway doesn't have", () => {
    expect(turnEnd(replay("cx13-unauthorized", true))).toMatchObject({
      failure: { kind: "auth", httpStatus: 401, retryable: false },
    });
    expect(turnEnd(replay("cx14-model-not-found", true))).toMatchObject({
      failure: { kind: "modelUnavailable", httpStatus: 404, retryable: false },
    });
  });

  it("carries the thread's goal, and says when it was cleared", () => {
    const mapper = makeCodexMapper({ newMessageId: () => MessageId.make("m1") });
    const goal = {
      threadId: "thr_1",
      objective: "Make the retry test deterministic",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    } as const;
    const events = [
      { method: "thread/goal/updated", params: { threadId: "thr_1", turnId: null, goal } },
      { method: "thread/goal/cleared", params: { threadId: "thr_1" } },
    ].flatMap((notification) => mapper.map(notification as ServerNotification));
    expect(events).toEqual([
      { type: "goal", objective: "Make the retry test deterministic" },
      { type: "goal" },
    ]);
  });
});

describe("makeCodexMapper app tools", () => {
  it("renders a call to the thread's gram MCP server under its mcp__ name", () => {
    const all = chunks(replay("cx09-mcp-call"));
    expect(all).toContainEqual({
      type: "tool-input-available",
      toolCallId: "call_3",
      toolName: "mcp__gram__rename_thread",
      input: { title: "Tidy" },
      providerExecuted: true,
      dynamic: true,
    });
    expect(all).toContainEqual({
      type: "tool-output-available",
      toolCallId: "call_3",
      output: {
        content: [{ type: "text", text: "renamed" }],
        structuredContent: null,
        _meta: null,
      },
      providerExecuted: true,
      dynamic: true,
    });
  });
});

describe("hunksOf", () => {
  it("parses a unified diff and turns a new file into one added hunk", () => {
    expect(
      hunksOf({
        path: "a.ts",
        kind: { type: "update", move_path: null },
        diff: "@@ -1,2 +1,2 @@\n a\n-b\n+c\n",
      }),
    ).toEqual([{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" a", "-b", "+c"] }]);
    expect(hunksOf({ path: "b.ts", kind: { type: "add" }, diff: "x\ny\n" })).toEqual([
      { oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ["+x", "+y"] },
    ]);
  });
});

const diagnosticMapper = (scope = "synthetic-user", cwd = "/synthetic/repo") =>
  makeCodexMapper({
    newMessageId: () => MessageId.make("m"),
    diagnosticScope: scope,
    diagnosticCwd: cwd,
  });
const diagnosticConfig = (
  path = "/synthetic/config.toml",
  summary = "Ignoring unknown feature sample",
) => ({ method: "configWarning" as const, params: { path, summary, details: null } });

describe("Codex startup diagnostic identity", () => {
  it("groups only matching warning, home and config identities without retaining paths", () => {
    const notice = diagnosticMapper().map(diagnosticConfig())[0];
    expect(notice).toEqual(diagnosticMapper().map(diagnosticConfig())[0]);
    expect(notice).not.toEqual(diagnosticMapper("other-home").map(diagnosticConfig())[0]);
    expect(notice).not.toEqual(
      diagnosticMapper().map(diagnosticConfig("/synthetic/other.toml"))[0],
    );
    expect(notice).not.toEqual(
      diagnosticMapper().map(diagnosticConfig(undefined, "A new warning"))[0],
    );
    expect(JSON.stringify(notice)).not.toContain("/synthetic/");
    // A reported shared configuration path can group across workers in different worktrees.
    expect(notice).toEqual(
      diagnosticMapper("synthetic-user", "/synthetic/other-worktree").map(diagnosticConfig())[0],
    );
    expect(
      makeCodexMapper({ newMessageId: () => MessageId.make("m") }).map(diagnosticConfig())[0],
    ).toEqual({
      type: "notice",
      level: "warning",
      message: diagnosticConfig().params.summary,
    });
  });
  it("keeps generic and thread-specific warnings ordinary, and tags actual MCP startup failures", () => {
    const message = "MCP client for `sample` failed to start: sign in required";
    expect(
      diagnosticMapper().map({ method: "warning", params: { threadId: null, message } })[0],
    ).toHaveProperty("startupDiagnostic");
    expect(
      diagnosticMapper().map({ method: "warning", params: { threadId: "thread", message } })[0],
    ).not.toHaveProperty("startupDiagnostic");
    expect(
      diagnosticMapper().map({
        method: "warning",
        params: { threadId: null, message: "Turn resource limit" },
      })[0],
    ).not.toHaveProperty("startupDiagnostic");
    const params = {
      threadId: null,
      name: "sample",
      status: "failed" as const,
      error: "Sign in required",
      failureReason: null,
    };
    expect(
      diagnosticMapper().map({ method: "mcpServer/startupStatus/updated", params })[0],
    ).toHaveProperty("startupDiagnostic");
    expect(
      diagnosticMapper().map({
        method: "mcpServer/startupStatus/updated",
        params: { ...params, status: "ready" },
      }),
    ).toEqual([]);
    const scoped = { ...params, threadId: "specific-thread" };
    expect(
      diagnosticMapper().map({ method: "mcpServer/startupStatus/updated", params: scoped })[0],
    ).not.toEqual(
      diagnosticMapper("synthetic-user", "/synthetic/unrelated-project").map({
        method: "mcpServer/startupStatus/updated",
        params: scoped,
      })[0],
    );
    expect(
      diagnosticMapper().map({ method: "mcpServer/startupStatus/updated", params })[0],
    ).toEqual(
      diagnosticMapper("synthetic-user", "/synthetic/new-worktree").map({
        method: "mcpServer/startupStatus/updated",
        params,
      })[0],
    );
  });
});
