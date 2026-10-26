// @vitest-environment happy-dom
import { MessageId, type GramUIMessage, type GramUIMessageChunk } from "@gram/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { createMessageFold } from "@/stores/message-fold";
import { createThreadFeed, syncScheduler } from "@/stores/thread-feed";
import displayed from "./codex-background.fixture.json";
import { type AnyToolPart } from "./parts";
import { ToolCard } from "./tool-cards";
import { runState } from "./tool-group-model";
import { stripRows } from "./subagent-strip-model";

afterEach(cleanup);
const props = {
  subagents: new Map(),
  subagentUsage: new Map(),
  streamingIds: new Set<string>(),
  renderSubagent: () => null,
};
const card = (message: unknown) =>
  createMessageFold("codex-parent", { base: JSON.parse(JSON.stringify(message)) as GramUIMessage })
    .snapshot()
    .parts.find((p) => p.type === "dynamic-tool") as AnyToolPart;

it("reloads partial Codex command output as running and clears preliminary on authoritative exit", () => {
  const part = card(displayed.background);
  expect(runState([part]).active).toEqual(part);
  render(<ToolCard part={part} {...props} />);
  fireEvent.click(screen.getByRole("button"));
  expect(screen.getByTestId("tool-card").textContent).toContain("Running");
  expect(screen.getByTestId("tool-card").textContent).toContain("ready");
  const fold = createMessageFold("codex-parent", { base: displayed.background as GramUIMessage });
  fold.apply({
    type: "tool-output-available",
    toolCallId: "command-1",
    dynamic: true,
    providerExecuted: true,
    output: displayed.completed.parts[1]!.output,
  });
  const final = fold.snapshot().parts.find((p) => p.type === "dynamic-tool") as AnyToolPart;
  expect(final).toEqual(card(displayed.completed));
  expect(runState([final]).active).toBeUndefined();
});

it("folds late snapshots into one finished message and does not offer unsupported per-task Stop", async () => {
  const feed = createThreadFeed({ scheduler: syncScheduler });
  feed.apply({ type: "messages", messages: [displayed.background as GramUIMessage] });
  feed.apply({ type: "caughtUp", rev: 1 });
  const apply = (chunk: Parameters<ReturnType<typeof createMessageFold>["apply"]>[0]) =>
    feed.apply({ type: "chunk", messageId: MessageId.make("codex-parent"), chunk });
  apply({
    type: "tool-output-available",
    toolCallId: "command-1",
    preliminary: true,
    dynamic: true,
    providerExecuted: true,
    output: { stdout: "ready\nmore\n", stderr: "", interrupted: false },
  });
  apply({ type: "finish" });
  await feed.whenSettled();
  expect(feed.store.getState().messages).toHaveLength(1);
  expect(feed.store.getState().streamingMessageIds).toEqual([]);
  apply({
    type: "tool-output-error",
    toolCallId: "command-1",
    errorText: "Cancelled",
    dynamic: true,
    providerExecuted: true,
  });
  apply({ type: "finish" });
  await feed.whenSettled();
  const part = card(feed.store.getState().messages[0]);
  expect(runState([part])).toMatchObject({ active: undefined, cancelled: 1 });
  expect(feed.store.getState().streamingMessageIds).toEqual([]);
  expect(
    stripRows(
      [],
      [{ taskId: "pty-1", kind: "shell", description: "Synthetic command", startedAt: 1 }],
      false,
    )[0]?.taskId,
  ).toBeUndefined();
  feed.dispose();
});

it("renders spawn invocation completion and the last reported child state without a live child lane", () => {
  render(<ToolCard part={card(displayed.collaboration)} {...props} />);
  fireEvent.click(screen.getByRole("button"));
  const content = screen.getByTestId("tool-card").textContent;
  expect(content).toContain("Spawn agent");
  expect(content).toContain("Last reported agent states");
  expect(content).toContain("child-1");
  expect(content).toContain("Running");
  expect(screen.queryByTestId("subagent-transcript")).toBeNull();
});

it("consumes the runtime's coalesced replay on a full and resumed subscription without ghost streaming", () => {
  const feed = createThreadFeed({ scheduler: syncScheduler });
  const replay = () => {
    for (const chunk of displayed.retainedReplay)
      feed.apply({
        type: "chunk",
        messageId: MessageId.make("codex-parent"),
        chunk: chunk as GramUIMessageChunk,
      });
    feed.apply({ type: "caughtUp", rev: 10 });
    expect(feed.store.getState().messages).toEqual([displayed.background]);
    expect(feed.store.getState().streamingMessageIds).toEqual([]);
    expect(runState([card(feed.store.getState().messages[0])]).active).toBeDefined();
  };
  feed.apply({ type: "subscribed" });
  feed.apply({ type: "messages", messages: [] });
  replay();
  feed.resubscribing();
  feed.apply({ type: "subscribed" });
  feed.apply({ type: "resumed", messages: [] });
  replay();
  // Once the process settles, runtime releases the lane and resumes from its stored row.
  feed.resubscribing();
  feed.apply({ type: "subscribed" });
  feed.apply({ type: "resumed", messages: [displayed.completed as GramUIMessage] });
  feed.apply({ type: "caughtUp", rev: 11 });
  expect(feed.store.getState().messages).toEqual([displayed.completed]);
  expect(feed.store.getState().streamingMessageIds).toEqual([]);
  expect(runState([card(feed.store.getState().messages[0])]).active).toBeUndefined();
  feed.dispose();
});

it("reconnects between a late output and finish without losing metadata or the original card", () => {
  const feed = createThreadFeed({ scheduler: syncScheduler });
  feed.apply({ type: "subscribed" });
  feed.apply({ type: "messages", messages: [] });
  const apply = (chunk: GramUIMessageChunk) =>
    feed.apply({ type: "chunk", messageId: MessageId.make("codex-parent"), chunk });
  // Actual runtime replay converts its prior finish into metadata while the next finish is pending.
  const metadata = {
    ...(displayed.background as GramUIMessage).metadata,
    agentMessageIds: ["parent-turn", "extra-reported-id"],
  };
  for (const chunk of displayed.retainedReplay.slice(0, -2)) apply(chunk as GramUIMessageChunk);
  apply({ type: "message-metadata", messageMetadata: metadata });
  apply(displayed.retainedReplay.at(-2)! as GramUIMessageChunk);
  feed.apply({ type: "caughtUp", rev: 10 });
  expect(feed.store.getState().messages).toEqual([{ ...displayed.background, metadata }]);
  expect(feed.store.getState().streamingMessageIds).toEqual(["codex-parent"]);
  apply({ type: "finish", messageMetadata: metadata });
  expect(feed.store.getState().messages).toEqual([{ ...displayed.background, metadata }]);
  expect(feed.store.getState().streamingMessageIds).toEqual([]);
  feed.dispose();
});
