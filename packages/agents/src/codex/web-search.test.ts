import { MessageId, type AgentEvent } from "@gram/contracts";
import { describe, expect, it } from "vitest";
import { makeCodexMapper, toolOf } from "./mapper.ts";
import type { ThreadItem } from "./protocol/v2/ThreadItem.ts";
import type { ServerNotification } from "./protocol/ServerNotification.ts";

type WebItem = Extract<ThreadItem, { type: "webSearch" }>;
const item = (extra: Partial<WebItem> = {}): WebItem => ({
  type: "webSearch",
  id: "web",
  query: "",
  action: null,
  results: null,
  ...extra,
});
const chunks = (events: ReadonlyArray<AgentEvent>) =>
  events.flatMap((e) => (e.type === "chunk" ? [e.chunk] : []));
const mapper = () => makeCodexMapper({ newMessageId: () => MessageId.make("m") });
const started = (value: WebItem): ServerNotification => ({
  method: "item/started",
  params: { threadId: "thread", turnId: "turn", item: value, startedAtMs: 1_000 },
});
const completed = (value: WebItem): ServerNotification => ({
  method: "item/completed",
  params: { threadId: "thread", turnId: "turn", item: value, completedAtMs: 2_000 },
});

const cases = [
  {
    action: { type: "search", query: "Codex compaction", queries: null },
    title: "Search web",
    input: { action: "search", query: "Codex compaction" },
  },
  {
    action: { type: "search", query: null, queries: ["Codex compaction", "Codex app-server"] },
    title: "Search web",
    input: { action: "search", queries: ["Codex compaction", "Codex app-server"] },
  },
  {
    action: { type: "openPage", url: "https://example.com/docs" },
    title: "Open page",
    input: { action: "openPage", url: "https://example.com/docs" },
  },
  {
    action: { type: "findInPage", url: "https://example.com/docs", pattern: "compact" },
    title: "Find in page",
    input: { action: "findInPage", url: "https://example.com/docs", pattern: "compact" },
  },
] as const;

describe("Codex native web metadata", () => {
  it.each(cases)(
    "preserves $title action metadata with an empty item query",
    ({ action, title, input }) => {
      const value = item({ action: action as WebItem["action"] });
      expect(toolOf(value)).toEqual({ name: "WebSearch", title, input });
      const m = mapper();
      m.map(started(value));
      const end = chunks(m.map(completed(value)));
      expect(end).toContainEqual({
        type: "tool-output-available",
        toolCallId: "web",
        output: { action },
        providerExecuted: true,
        dynamic: true,
      });
      expect(end.some((c) => c.type === "tool-input-start")).toBe(false);
    },
  );

  it("updates the same tool card when action details arrive only at completion", () => {
    const m = mapper();
    const start = chunks(m.map(started(item())));
    const end = chunks(
      m.map(completed(item({ action: { type: "openPage", url: "https://example.com/docs" } }))),
    );
    expect(start.filter((c) => c.type === "tool-input-start")).toHaveLength(1);
    expect(end.filter((c) => c.type === "tool-input-start")).toHaveLength(0);
    expect(end).toContainEqual({
      type: "tool-input-available",
      toolCallId: "web",
      toolName: "WebSearch",
      title: "Open page",
      input: { action: "openPage", url: "https://example.com/docs" },
      providerExecuted: true,
      dynamic: true,
    });
    expect(end.findIndex((c) => c.type === "tool-input-available")).toBeLessThan(
      end.findIndex((c) => c.type === "tool-output-available"),
    );
  });

  it("preserves both provider query fields and opaque actual results", () => {
    const action: WebItem["action"] = {
      type: "search",
      query: "first",
      queries: ["first", "second"],
    };
    const results = [{ url: "https://example.com", title: "Supplied result", newField: 42 }];
    const value = item({ query: "item query", action: action as WebItem["action"], results });
    expect(toolOf(value)?.input).toEqual({
      action: "search",
      query: "first",
      queries: ["first", "second"],
    });
    const out = chunks(mapper().map(completed(value)));
    expect(out).toContainEqual({
      type: "tool-output-available",
      toolCallId: "web",
      output: { action, results },
      providerExecuted: true,
      dynamic: true,
    });
  });

  it("keeps query-only events and never invents missing URL or page contents", () => {
    const queryOnly = { type: "webSearch", id: "web", query: "query only" } as WebItem;
    expect(toolOf(queryOnly)).toEqual({ name: "WebSearch", input: { query: "query only" } });
    expect(toolOf(item({ action: { type: "openPage", url: null } }))?.input).toEqual({
      action: "openPage",
    });
    expect(chunks(mapper().map(completed(queryOnly)))).toContainEqual({
      type: "tool-output-available",
      toolCallId: "web",
      output: { query: "query only" },
      providerExecuted: true,
      dynamic: true,
    });
  });

  it("leaves a native web call failed when the provider fails before completing it", () => {
    const m = mapper();
    m.map(started(item({ action: { type: "search", query: "question", queries: null } })));
    m.map({
      method: "error",
      params: {
        threadId: "thread",
        turnId: "turn",
        willRetry: false,
        error: {
          message: "Search unavailable",
          codexErrorInfo: null,
          additionalDetails: null,
          misalignment: null,
        },
      },
    });
    const failedTurn = {
      id: "turn",
      rootTurnId: null,
      status: "failed" as const,
      items: [],
      itemsView: "full" as const,
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    };
    const out = chunks(
      m.map({
        method: "turn/completed",
        params: {
          threadId: "thread",
          turn: failedTurn,
        },
      }),
    );
    expect(out.some((c) => c.type === "tool-output-error" && c.toolCallId === "web")).toBe(true);
    expect(out.some((c) => c.type === "tool-output-available")).toBe(false);
  });
});
