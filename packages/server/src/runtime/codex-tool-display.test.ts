import { readFileSync } from "node:fs";
import { makeCodexMapper } from "@gram/agents/codex";
import { MessageId, type AgentEvent } from "@gram/contracts";
import { expect, it } from "vitest";
import { MessageAccumulator } from "./message-accumulator.ts";

type ServerNotification = Parameters<ReturnType<typeof makeCodexMapper>["map"]>[0];
type ThreadItem = Extract<ServerNotification, { method: "item/completed" }>["params"]["item"];
// The web render tests reload exactly these records; verify them against real mapper output.
const displayed = JSON.parse(
  readFileSync(
    new URL("../../../../apps/web/src/thread/codex-tool-display.fixture.json", import.meta.url),
    "utf8",
  ),
);

const setup = () => {
  const acc = new MessageAccumulator("audit");
  const mapper = makeCodexMapper({ newMessageId: () => MessageId.make("audit") });
  const events: AgentEvent[] = [];
  const notify = (method: "item/started" | "item/completed", item: ThreadItem) => {
    const notification: ServerNotification =
      method === "item/started"
        ? { method, params: { threadId: "thread", turnId: "turn", item, startedAtMs: 1_000 } }
        : { method, params: { threadId: "thread", turnId: "turn", item, completedAtMs: 2_000 } };
    const mapped = mapper.map(notification);
    events.push(...mapped);
    mapped.forEach((event) => {
      if (event.type === "chunk") acc.apply(event.chunk);
    });
    return mapped.flatMap((event) => (event.type === "chunk" ? [event.chunk] : []));
  };
  return { acc, mapper, events, notify };
};

it.each([
  { operation: "add", kind: { type: "add" }, name: "Write" },
  { operation: "delete", kind: { type: "delete" }, name: "Edit" },
  { operation: "update", kind: { type: "update", move_path: null }, name: "Edit" },
] as const)(
  "persists completion-only file $operation metadata on the original call",
  ({ kind, name }) => {
    const { acc, mapper, events, notify } = setup();
    notify("item/started", { type: "fileChange", id: "patch", status: "inProgress", changes: [] });
    const changes = [{ path: "/repo/new.ts", kind, diff: "export const value = 1;" }];
    const end = notify("item/completed", {
      type: "fileChange",
      id: "patch",
      status: "completed",
      changes,
    });
    const input =
      name === "Write"
        ? { file_path: "/repo/new.ts", content: changes[0]!.diff }
        : { file_path: "/repo/new.ts", changes };
    const message = JSON.parse(JSON.stringify(acc.snapshot()));
    if (name === "Write")
      expect(
        message.parts.filter((part: { type: string }) => part.type === "dynamic-tool"),
      ).toEqual(displayed.file.parts);
    expect(message.parts.filter((part: { type: string }) => part.type === "dynamic-tool")).toEqual([
      expect.objectContaining({
        type: "dynamic-tool",
        toolCallId: "patch",
        toolName: name,
        input,
        state: "output-available",
        output: expect.objectContaining({ structuredPatch: expect.any(Array) }),
      }),
    ]);
    expect(
      events.filter((event) => event.type === "chunk" && event.chunk.type === "tool-input-start"),
    ).toHaveLength(1);
    expect(end.findIndex((chunk) => chunk.type === "tool-input-available")).toBeLessThan(
      end.findIndex((chunk) => chunk.type === "tool-output-available"),
    );
    expect(events).toContainEqual({
      type: "files",
      changes: [{ path: "/repo/new.ts", kind: kind.type === "update" ? "modify" : kind.type }],
    });
    // Completion refresh is transcript data only; approval-time patches remain untouched.
    expect(mapper.changes("patch")).toEqual([]);
    expect(
      mapper
        .flush()
        .flatMap((event) =>
          event.type === "chunk" && event.chunk.type === "tool-output-error" ? [event.chunk] : [],
        ),
    ).toEqual([]);
  },
);

const dynamic = (
  extra: Partial<Extract<ThreadItem, { type: "dynamicToolCall" }>> = {},
): ThreadItem => ({
  type: "dynamicToolCall",
  id: "dynamic",
  namespace: null,
  tool: "synthetic_tool",
  status: "failed",
  arguments: { path: "" },
  durationMs: null,
  success: false,
  contentItems: [],
  ...extra,
});

it("retains known file input when completion supplies no path or operation", () => {
  const { acc, notify } = setup();
  const changes = [
    { path: "/repo/known.ts", kind: { type: "add" as const }, diff: "known content" },
  ];
  const item: ThreadItem = { type: "fileChange", id: "patch", status: "inProgress", changes };
  notify("item/started", item);
  expect(notify("item/started", item)).toEqual([]);
  const end = notify("item/completed", { ...item, status: "completed", changes: [] });
  expect(
    end.some((chunk) => chunk.type === "tool-input-available" || chunk.type === "tool-input-start"),
  ).toBe(false);
  expect(acc.snapshot().parts).toContainEqual(
    expect.objectContaining({
      toolName: "Write",
      input: { file_path: "/repo/known.ts", content: "known content" },
      state: "output-available",
      output: { type: "update", structuredPatch: [] },
    }),
  );
});

it("persists actual dynamic failure text blocks, excluding image and audio URLs", () => {
  const { acc, notify } = setup();
  notify(
    "item/completed",
    dynamic({
      contentItems: [
        { type: "inputText", text: "Required path is missing" },
        { type: "inputImage", imageUrl: "data:image/png;base64,synthetic-image" },
        { type: "inputText", text: "Choose a source file." },
        { type: "inputAudio", audioUrl: "data:audio/wav;base64,synthetic-audio" },
      ],
    }),
  );
  const message = JSON.parse(JSON.stringify(acc.snapshot()));
  expect(message.parts.filter((part: { type: string }) => part.type === "dynamic-tool")).toEqual(
    displayed.failure.parts,
  );
  expect(message.parts.filter((part: { type: string }) => part.type === "dynamic-tool")).toEqual([
    expect.objectContaining({
      toolName: "synthetic_tool",
      input: { path: "" },
      state: "output-error",
      errorText: "Required path is missing\nChoose a source file.",
    }),
  ]);
  expect(JSON.stringify(message)).not.toContain("base64");
});

it.each([
  { contentItems: [] },
  { contentItems: [{ type: "inputText", text: " \n" }] },
  { contentItems: [{ type: "inputImage", imageUrl: "synthetic-image" }] },
] as const)(
  "keeps a generic dynamic failure when no meaningful text is supplied: %j",
  ({ contentItems }) => {
    const { acc, notify } = setup();
    notify("item/completed", dynamic({ contentItems: [...contentItems] }));
    expect(acc.snapshot().parts).toContainEqual(
      expect.objectContaining({ errorText: "The tool call failed", state: "output-error" }),
    );
  },
);

it("preserves successful dynamic content and leaves unknown outcomes pending until the turn ends", () => {
  const { acc, mapper, notify } = setup();
  const contentItems = [{ type: "inputText", text: "Actual report" }] as const;
  notify(
    "item/completed",
    dynamic({ status: "completed", success: true, contentItems: [...contentItems] }),
  );
  expect(acc.snapshot().parts).toContainEqual(
    expect.objectContaining({ state: "output-available", output: contentItems }),
  );
  notify("item/started", dynamic({ id: "unknown", status: "inProgress", success: null }));
  expect(notify("item/completed", dynamic({ id: "unknown", success: null }))).toEqual([]);
  const ended = mapper.flush().flatMap((event) => (event.type === "chunk" ? [event.chunk] : []));
  expect(ended.filter((chunk) => chunk.type === "tool-output-error")).toEqual([
    expect.objectContaining({
      toolCallId: "unknown",
      errorText: "The turn ended before the tool finished",
    }),
  ]);
});
