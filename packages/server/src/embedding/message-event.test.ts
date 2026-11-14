import { describe, expect, it } from "vitest";
import { type GramUIMessage, SINK_MESSAGE_EVENT_MAX_BYTES, type ThreadId } from "@gram/contracts";
import type { StoredMessage } from "../persistence/thread-store.ts";
import { fitMessage, messageEvent, TEXT_CUT_MARK } from "./message-event.ts";

const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

const tool = (id: string, output: unknown, input: unknown = { command: "ls" }) => ({
  type: "tool-Bash",
  toolCallId: id,
  state: "output-available",
  input,
  output,
});

const message = (parts: ReadonlyArray<unknown>, metadata: Record<string, unknown> = {}) =>
  ({
    id: "m1",
    role: "assistant",
    parts,
    metadata: { createdAt: 1000, ...metadata },
  }) as unknown as GramUIMessage;

const stored = (one: GramUIMessage, more: Partial<StoredMessage> = {}): StoredMessage => ({
  seq: 3,
  rev: 41,
  role: one.role,
  turnId: "turn-1",
  message: one,
  ...more,
});

const where = { threadId: "thread-1" as ThreadId, workspaceId: "ws-1" };

describe("a stored message as the sink sends it", () => {
  it("is sent as stored when it fits, with its row's revision, role, turn and place", () => {
    const one = message([{ type: "text", text: "done" }, tool("a", "three files")]);
    expect(messageEvent(where, stored(one), 5000)).toEqual({
      type: "message",
      threadId: "thread-1",
      workspaceId: "ws-1",
      data: {
        id: "m1",
        rev: 41,
        role: "assistant",
        turnId: "turn-1",
        at: 1000,
        seq: 3,
        message: one,
        truncated: false,
      },
    });
  });

  it("names the person who sent it, and takes the event's time where it has none of its own", () => {
    const one = {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "hello" }],
      metadata: { author: "user", sentBy: "person-9" },
    } as unknown as GramUIMessage;
    const event = messageEvent(where, { seq: 1, rev: 2, role: "user", message: one }, 5000);
    expect(event.actor).toEqual({ kind: "person", id: "person-9" });
    expect(event.data["at"]).toBe(5000);
    expect("turnId" in event.data).toBe(false);
  });

  it("cuts the largest tool results first, marks each, and keeps the text", () => {
    const text = "the answer ".repeat(2000);
    const one = message([
      { type: "text", text },
      tool("small", "s".repeat(20_000)),
      tool("large", "l".repeat(400_000)),
      tool("middle", "m".repeat(150_000)),
    ]);
    const event = messageEvent(where, stored(one), 0);
    expect(bytesOf(event)).toBeLessThanOrEqual(SINK_MESSAGE_EVENT_MAX_BYTES);
    expect(event.data["truncated"]).toBe(true);
    const parts = (event.data["message"] as GramUIMessage).parts as ReadonlyArray<
      Record<string, unknown>
    >;
    expect(parts[0]).toEqual({ type: "text", text });
    // The largest alone brings it under, so the others are sent as they are.
    expect(parts[1]!["output"]).toBe("s".repeat(20_000));
    expect(parts[2]!["output"]).toEqual({ truncated: true, bytes: 400_002 });
    expect(parts[3]!["output"]).toBe("m".repeat(150_000));
    expect(parts[2]).toMatchObject({ toolCallId: "large", input: { command: "ls" } });
  });

  it("cuts as many tool results as it takes, then what tools were given, then other parts", () => {
    const one = message([
      { type: "text", text: "kept" },
      tool("a", "a".repeat(200_000), { content: "i".repeat(300_000) }),
      tool("b", "b".repeat(200_000)),
      { type: "file", mediaType: "image/png", url: `data:image/png;base64,${"A".repeat(250_000)}` },
    ]);
    const { message: fitted, truncated } = fitMessage(one, 100_000);
    expect(truncated).toBe(true);
    expect(bytesOf(fitted)).toBeLessThanOrEqual(100_000);
    const parts = fitted.parts as ReadonlyArray<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: "text", text: "kept" });
    expect(parts[1]!["output"]).toEqual({ truncated: true, bytes: 200_002 });
    expect(parts[1]!["input"]).toMatchObject({ truncated: true });
    expect(parts[2]!["output"]).toEqual({ truncated: true, bytes: 200_002 });
    expect(parts[3]).toMatchObject({
      type: "data-truncated",
      data: { truncated: true, part: "file" },
    });
  });

  it("cuts the text only when the text alone is too much, and says so in it", () => {
    const one = message([
      { type: "text", text: "é".repeat(300_000) },
      { type: "text", text: "short" },
      tool("a", "a".repeat(1000)),
    ]);
    const event = messageEvent(where, stored(one), 0);
    expect(bytesOf(event)).toBeLessThanOrEqual(SINK_MESSAGE_EVENT_MAX_BYTES);
    // Nearly all of the budget is still the text.
    expect(bytesOf(event)).toBeGreaterThan(SINK_MESSAGE_EVENT_MAX_BYTES - 2048);
    const parts = (event.data["message"] as GramUIMessage).parts as ReadonlyArray<
      Record<string, unknown>
    >;
    expect((parts[0]!["text"] as string).endsWith(TEXT_CUT_MARK)).toBe(true);
    expect((parts[0]!["text"] as string).startsWith("ééé")).toBe(true);
    expect(parts[1]).toEqual({ type: "text", text: "short" });
    expect(event.data["truncated"]).toBe(true);
  });

  it("is never over, even where nothing it can cut is what is large", () => {
    const one = message([{ type: "text", text: "hi" }], { toolTimes: { x: "t".repeat(400_000) } });
    const event = messageEvent(where, stored(one), 0);
    expect(bytesOf(event)).toBeLessThanOrEqual(SINK_MESSAGE_EVENT_MAX_BYTES);
    expect(event.data["truncated"]).toBe(true);
    expect((event.data["message"] as GramUIMessage).parts).toEqual([
      { type: "data-truncated", data: { truncated: true, bytes: bytesOf(one) } },
    ]);
  });
});
