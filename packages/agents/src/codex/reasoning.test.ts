import { MessageId, type AgentEvent } from "@gram/contracts";
import { describe, expect, it } from "vitest";
import { makeCodexMapper } from "./mapper.ts";
import type { ServerNotification } from "./protocol/ServerNotification.ts";
import type { ThreadItem } from "./protocol/v2/ThreadItem.ts";
import type { Turn } from "./protocol/v2/Turn.ts";

const reasoning: ThreadItem = { type: "reasoning", id: "r", summary: [], content: [] };
const turn = (status: Turn["status"] = "inProgress"): Turn => ({
  id: "turn",
  rootTurnId: null,
  items: [],
  itemsView: "full",
  status,
  error: null,
  startedAt: 1,
  completedAt: null,
  durationMs: null,
});
const itemEvent = (item: ThreadItem, completed = false): ServerNotification =>
  completed
    ? {
        method: "item/completed",
        params: { threadId: "thread", turnId: "turn", item, completedAtMs: 2 },
      }
    : {
        method: "item/started",
        params: { threadId: "thread", turnId: "turn", item, startedAtMs: 1 },
      };
const chunks = (events: readonly AgentEvent[]) =>
  events.flatMap((e) => (e.type === "chunk" ? [e.chunk] : []));
const mapper = () =>
  makeCodexMapper({ newMessageId: () => MessageId.make("m"), threadId: "thread" });

describe("Codex reasoning lifecycle", () => {
  it("opens silent reasoning at item start and closes an empty completed payload", () => {
    const m = mapper();
    expect(chunks(m.map(itemEvent(reasoning)))).toContainEqual({
      type: "reasoning-start",
      id: "r",
    });
    expect(chunks(m.map(itemEvent(reasoning)))).toEqual([]);
    expect(chunks(m.map(itemEvent(reasoning, true)))).toEqual([{ type: "reasoning-end", id: "r" }]);
    expect(chunks(m.map(itemEvent(reasoning)))).toEqual([]);
  });

  it("keeps completion-only reasoning terminal when a start or delta arrives late", () => {
    const m = mapper();
    m.map(itemEvent(reasoning, true));
    expect(chunks(m.map(itemEvent(reasoning)))).toEqual([]);
    expect(
      chunks(
        m.map({
          method: "item/reasoning/summaryTextDelta",
          params: {
            threadId: "thread",
            turnId: "turn",
            itemId: "r",
            summaryIndex: 0,
            delta: "Late summary",
          },
        }),
      ),
    ).toEqual([]);
    expect(
      chunks(
        m.map({
          method: "item/reasoning/textDelta",
          params: {
            threadId: "thread",
            turnId: "turn",
            itemId: "r",
            contentIndex: 0,
            delta: "Late raw",
          },
        }),
      ),
    ).toEqual([]);
  });

  it("handles delta-only streams and emits only the missing final summary suffix", () => {
    const m = mapper();
    const events = m.map({
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "thread",
        turnId: "turn",
        itemId: "r",
        summaryIndex: 0,
        delta: "First",
      },
    });
    events.push(...m.map(itemEvent({ ...reasoning, summary: ["First second"] }, true)));
    expect(chunks(events).filter((c) => c.type.startsWith("reasoning"))).toEqual([
      { type: "reasoning-start", id: "r" },
      { type: "reasoning-delta", id: "r", delta: "First" },
      { type: "reasoning-delta", id: "r", delta: " second" },
      { type: "reasoning-end", id: "r" },
    ]);
  });

  it("preserves summary and raw identities, delta ordering, and closes both with no final summary", () => {
    const m = mapper();
    const events = m.map(itemEvent(reasoning));
    for (const [summaryIndex, delta] of [
      [0, "First."],
      [1, " Second."],
    ] as const)
      events.push(
        ...m.map({
          method: "item/reasoning/summaryTextDelta",
          params: { threadId: "thread", turnId: "turn", itemId: "r", summaryIndex, delta },
        }),
      );
    events.push(
      ...m.map({
        method: "item/reasoning/textDelta",
        params: {
          threadId: "thread",
          turnId: "turn",
          itemId: "r",
          contentIndex: 0,
          delta: "Invented raw fixture.",
        },
      }),
      ...m.map(itemEvent(reasoning, true)),
    );
    expect(chunks(events).filter((c) => c.type.startsWith("reasoning"))).toEqual([
      { type: "reasoning-start", id: "r" },
      { type: "reasoning-delta", id: "r", delta: "First." },
      { type: "reasoning-delta", id: "r", delta: " Second." },
      { type: "reasoning-start", id: "r:raw" },
      { type: "reasoning-delta", id: "r:raw", delta: "Invented raw fixture." },
      { type: "reasoning-end", id: "r" },
      { type: "reasoning-end", id: "r:raw" },
    ]);
  });

  it.each(["completed", "interrupted", "failed", "exit"] as const)(
    "closes unfinished silent reasoning on %s and ignores late starts/deltas",
    (status) => {
      const m = mapper();
      m.map(itemEvent(reasoning));
      const end =
        status === "exit"
          ? m.flush()
          : m.map({ method: "turn/completed", params: { threadId: "thread", turn: turn(status) } });
      expect(chunks(end)).toContainEqual({ type: "reasoning-end", id: "r" });
      expect(chunks(end).at(-1)).toEqual({ type: "finish" });
      expect(m.map(itemEvent(reasoning))).toEqual([]);
      expect(
        m.map({
          method: "item/reasoning/summaryTextDelta",
          params: {
            threadId: "thread",
            turnId: "turn",
            itemId: "r",
            summaryIndex: 0,
            delta: "Late",
          },
        }),
      ).toEqual([]);
    },
  );

  it("never opens reasoning for turn startup, approval, compaction, tool work, or completion-only history", () => {
    const m = mapper();
    const events = m.map({ method: "turn/started", params: { threadId: "thread", turn: turn() } });
    events.push(...m.map(itemEvent(reasoning, true)), ...m.awaitingApproval());
    events.push(...m.map(itemEvent({ type: "contextCompaction", id: "compact" })));
    events.push(
      ...m.map(itemEvent({ type: "fileChange", id: "tool", status: "inProgress", changes: [] })),
    );
    expect(chunks(events).filter((c) => c.type.startsWith("reasoning"))).toEqual([]);
    expect(events.filter((e) => e.type === "status").map((e) => e.status)).toEqual([
      "running",
      "awaitingApproval",
      "compacting",
    ]);
  });

  it("ends reasoning before tools and permits a later reasoning item in the same turn", () => {
    const m = mapper();
    const events = [
      ...m.map(itemEvent(reasoning)),
      ...m.map(itemEvent(reasoning, true)),
      ...m.map(itemEvent({ type: "fileChange", id: "tool", status: "inProgress", changes: [] })),
      ...m.awaitingApproval(),
      ...m.map(
        itemEvent({ type: "fileChange", id: "tool", status: "completed", changes: [] }, true),
      ),
      ...m.map(itemEvent({ ...reasoning, id: "r2" })),
    ];
    const c = chunks(events);
    expect(c.findIndex((e) => e.type === "reasoning-end")).toBeLessThan(
      c.findIndex((e) => e.type === "tool-input-start"),
    );
    expect(c.at(-1)).toEqual({ type: "reasoning-start", id: "r2" });
  });
});
