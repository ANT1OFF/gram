import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { MessageId } from "@gram/contracts";

import { makeCodexMapper } from "../../../packages/agents/src/codex/mapper.ts";
import { makeMapper } from "../../../packages/agents/src/claude/mapper.ts";
import { createMessageFold } from "../src/stores/message-fold.ts";

import { seedTheme } from "./seed-theme";

// Node-side adapter replay uses current TypeScript source without adding an agent dependency
// or project reference to the shipped web UI. Browser chunks still enter its real feed/fold.
// No CLI, provider, account or private transcript is used. These are invented protocol events.
const reasoning = { type: "reasoning", id: "r", summary: [], content: [] };
const item = (value, completed = false) =>
  completed
    ? {
        method: "item/completed",
        params: { threadId: "thread", turnId: "turn", item: value, completedAtMs: 2 },
      }
    : {
        method: "item/started",
        params: { threadId: "thread", turnId: "turn", item: value, startedAtMs: 1 },
      };
const turn = (status) => ({
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
const send = async (page, events) => {
  await page.evaluate((batch) => {
    for (const event of batch) {
      if (event.type === "chunk")
        window.gramMock.simulateChunks("t-deps", event.messageId, [event.chunk]);
      else if (event.type === "status")
        window.gramMock.simulateStatus(
          "t-deps",
          event.status === "awaitingApproval"
            ? "needsApproval"
            : event.status === "awaitingInput"
              ? "needsInput"
              : event.status === "compacting" || event.status === "retrying"
                ? "running"
                : event.status,
          event.detail,
          event.compaction,
        );
      else if (event.type === "turnEnd")
        window.gramMock.simulateStatus("t-deps", event.reason === "error" ? "error" : "idle");
    }
  }, events);
};

const browserErrors = new WeakMap();
test.beforeEach(async ({ page }) => {
  const errors = [];
  browserErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await seedTheme(page, { palette: "tokyo-night", mode: "dark", motion: "off" });
  await page.addInitScript(() => {
    sessionStorage.setItem("gram.mock.agents", "claude,codex");
    sessionStorage.setItem(
      "gram.mock.launchChecks",
      JSON.stringify({
        tools: [],
        claudeSignIn: "notSignedIn",
        codexSignIn: "notSignedIn",
        ghSignedIn: false,
        agentsInUse: [],
      }),
    );
    sessionStorage.setItem("gram.mock.agentRuntimes", JSON.stringify({ agents: [] }));
  });
  await page.goto("/t/t-deps");
  await page.getByLabel("Message", { exact: true }).waitFor();
  // The runtime accepts the synthetic turn; no real provider/account readiness is assumed.
  await page.evaluate(() => window.gramMock.simulateStatus("t-deps", "running"));
  await page.evaluate(() =>
    window.gramMock.setModel("t-deps", { agent: "codex", model: "gpt-5.4" }),
  );
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page)).toEqual([]);
});

test("Codex silent item start displays Thinking, empty completion removes it, and tools/approval stay distinct", async ({
  page,
}, info) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const m = makeCodexMapper({ newMessageId: () => MessageId.make("thinking-codex") });
  await page.evaluate(() =>
    window.gramMock.setModel("t-deps", { agent: "codex", model: "gpt-5.4" }),
  );
  const note = page.getByTestId("reasoning-note");
  await send(
    page,
    m.map({ method: "turn/started", params: { threadId: "thread", turn: turn("inProgress") } }),
  );
  await expect(note).toHaveCount(0); // A running turn by itself does not assert reasoning.
  await send(page, m.map(item(reasoning)));
  await expect(note).toBeVisible();
  await expect(note).toHaveText("Thinking…");
  await page.screenshot({
    path: info.outputPath("codex-silent-start.png"),
    animations: "disabled",
  });
  await send(page, m.map(item(reasoning, true)));
  await expect(note).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("codex-empty-completion.png"),
    animations: "disabled",
  });
  const tool = { type: "fileChange", id: "edit", status: "inProgress", changes: [] };
  await send(page, m.map(item(tool)));
  await send(page, m.awaitingApproval());
  await page.evaluate(() =>
    window.gramMock.simulateRequest("t-deps", {
      kind: "approval",
      id: "approval-thinking",
      toolCallId: "edit",
      toolName: "Edit",
      displayName: "Invented offline edit approval",
      input: {},
      suggestions: [],
    }),
  );
  await expect(note).toHaveCount(0);
  await expect(page.getByTestId("approval-card")).toContainText("Invented offline edit approval");
  await page.screenshot({
    path: info.outputPath("codex-tool-approval.png"),
    animations: "disabled",
  });
  await page.getByTestId("approval-allow").click();
  await send(
    page,
    m.map({
      method: "thread/status/changed",
      params: { threadId: "thread", status: { type: "active", activeFlags: [] } },
    }),
  );
  await send(page, m.map(item({ ...tool, status: "completed" }, true)));
  await send(page, m.map(item({ ...reasoning, id: "r2" })));
  await expect(note).toBeVisible();
  await send(page, m.map(item({ ...reasoning, id: "r2" }, true)));
  await send(
    page,
    m.map(
      item({
        type: "agentMessage",
        id: "answer",
        text: "Invented offline answer.",
        phase: null,
        memoryCitation: null,
        delivery: null,
        questions: null,
      }),
    ),
  );
  await expect(note).toHaveCount(0);
  await expect(page.getByText("Invented offline answer.")).toBeVisible();
  await send(
    page,
    m.map({ method: "turn/completed", params: { threadId: "thread", turn: turn("completed") } }),
  );
  await expect(note).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Codex summary deltas do not leave stale Thinking after an empty completion", async ({
  page,
}, info) => {
  const m = makeCodexMapper({ newMessageId: () => MessageId.make("thinking-summary") });
  await send(page, m.map(item(reasoning)));
  await send(
    page,
    m.map({
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "thread",
        turnId: "turn",
        itemId: "r",
        summaryIndex: 0,
        delta: "Invented summary text must remain hidden.",
      },
    }),
  );
  await expect(page.getByTestId("reasoning-note")).toBeVisible();
  await expect(page.getByText("Invented summary text must remain hidden.")).toHaveCount(0);
  await send(page, m.map(item(reasoning, true)));
  await expect(page.getByTestId("reasoning-note")).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("codex-summary-empty-completion.png"),
    animations: "disabled",
  });
});

test("Codex summary/raw deltas keep their parts ordered, hide text, and remain closed after late events", async ({
  page,
}, info) => {
  const m = makeCodexMapper({ newMessageId: () => MessageId.make("thinking-raw") });
  const fold = createMessageFold("thinking-raw");
  const deliver = async (events) => {
    for (const event of events) if (event.type === "chunk") fold.apply(event.chunk);
    await send(page, events);
  };
  await deliver(m.map(item(reasoning)));
  for (const [summaryIndex, delta] of [
    [0, "Invented first summary."],
    [1, "Invented second summary."],
  ])
    await deliver(
      m.map({
        method: "item/reasoning/summaryTextDelta",
        params: { threadId: "thread", turnId: "turn", itemId: "r", summaryIndex, delta },
      }),
    );
  const raw = {
    method: "item/reasoning/textDelta",
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId: "r",
      contentIndex: 0,
      delta: "Invented raw text remains hidden.",
    },
  };
  await deliver(m.map(raw));
  expect(fold.snapshot().parts.filter((part) => part.type === "reasoning")).toEqual([
    {
      type: "reasoning",
      id: "r",
      text: "Invented first summary.Invented second summary.",
      state: "streaming",
    },
    {
      type: "reasoning",
      id: "r:raw",
      text: "Invented raw text remains hidden.",
      state: "streaming",
    },
  ]);
  await expect(page.getByTestId("reasoning-note")).toHaveCount(1);
  await expect(page.getByText(/Invented (first|second|raw)/)).toHaveCount(0);
  await deliver(m.map(item(reasoning, true)));
  await deliver(m.map(raw));
  expect(fold.snapshot().parts.filter((part) => part.type === "reasoning")).toEqual([
    {
      type: "reasoning",
      id: "r",
      text: "Invented first summary.Invented second summary.",
      state: "done",
    },
    { type: "reasoning", id: "r:raw", text: "Invented raw text remains hidden.", state: "done" },
  ]);
  await expect(page.getByTestId("reasoning-note")).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("codex-summary-raw-ended.png"),
    animations: "disabled",
  });
});

test("one raw-only reasoning item displays one visual indicator", async ({ page }, info) => {
  // Preserve the independent review's item/delta payload and one-row oracle.
  const m = makeCodexMapper({
    threadId: "owner",
    newMessageId: () => MessageId.make("independent-raw"),
  });
  const fold = createMessageFold("independent-raw");
  const start = {
    method: "item/started",
    params: {
      threadId: "owner",
      turnId: "a",
      startedAtMs: 1,
      item: { type: "reasoning", id: "r", summary: [], content: [] },
    },
  };
  const raw = {
    method: "item/reasoning/textDelta",
    params: {
      threadId: "owner",
      turnId: "a",
      itemId: "r",
      contentIndex: 0,
      delta: "Invented offline raw text should stay hidden.",
    },
  };
  const events = [...m.map(start), ...m.map(raw)];
  for (const event of events) if (event.type === "chunk") fold.apply(event.chunk);
  await send(page, events);
  const notes = page.getByTestId("reasoning-note");
  await expect(notes.first()).toBeVisible();
  await expect(page.getByText("Invented offline raw text should stay hidden.")).toHaveCount(0);
  await expect(notes).toHaveCount(1);
  expect(fold.snapshot().parts.filter((part) => part.type === "reasoning")).toEqual([
    { type: "reasoning", id: "r", text: "", state: "streaming" },
    {
      type: "reasoning",
      id: "r:raw",
      text: "Invented offline raw text should stay hidden.",
      state: "streaming",
    },
  ]);
  await page.screenshot({ path: info.outputPath("raw-only-live.png"), animations: "disabled" });
  const end = m.map({
    method: "item/completed",
    params: {
      threadId: "owner",
      turnId: "a",
      completedAtMs: 2,
      item: { type: "reasoning", id: "r", summary: [], content: [raw.params.delta] },
    },
  });
  for (const event of end) if (event.type === "chunk") fold.apply(event.chunk);
  await send(page, end);
  await expect(notes).toHaveCount(0);
  expect(fold.snapshot().parts.filter((part) => part.type === "reasoning")).toEqual([
    { type: "reasoning", id: "r", text: "", state: "done" },
    {
      type: "reasoning",
      id: "r:raw",
      text: "Invented offline raw text should stay hidden.",
      state: "done",
    },
  ]);
  await page.screenshot({ path: info.outputPath("raw-only-ended.png"), animations: "disabled" });
});

test("Codex startup, tool, approval, compaction and error without a reasoning item never display Thinking", async ({
  page,
}, info) => {
  const m = makeCodexMapper({ newMessageId: () => MessageId.make("thinking-negative") });
  await page.evaluate(() => window.gramMock.simulateStatus("t-deps", "starting"));
  await expect(page.getByTestId("reasoning-note")).toHaveCount(0);
  await send(
    page,
    m.map({ method: "turn/started", params: { threadId: "thread", turn: turn("inProgress") } }),
  );
  await send(page, m.map(item(reasoning, true))); // History-only completion cannot start an indicator.
  await send(page, m.map(item(reasoning))); // Reordered start stays terminal.
  await send(
    page,
    m.map(item({ type: "fileChange", id: "tool", status: "inProgress", changes: [] })),
  );
  await send(page, m.awaitingApproval());
  await expect(page.getByTestId("reasoning-note")).toHaveCount(0);
  await send(page, m.map(item({ type: "contextCompaction", id: "compact" })));
  await expect(page.getByTestId("pane-status")).toHaveText("Compacting");
  await expect(page.getByTestId("reasoning-note")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("codex-compacting.png"), animations: "disabled" });
  await send(
    page,
    m.map({ method: "turn/completed", params: { threadId: "thread", turn: turn("failed") } }),
  );
  await expect(page.getByTestId("reasoning-note")).toHaveCount(0);
});

for (const status of ["completed", "interrupted", "failed", "exit"])
  test(`Codex ${status} closes unfinished reasoning and ignores late notifications`, async ({
    page,
  }, info) => {
    const m = makeCodexMapper({ newMessageId: () => MessageId.make("thinking-codex") });
    await send(page, m.map(item(reasoning)));
    await expect(page.getByTestId("reasoning-note")).toBeVisible();
    await send(
      page,
      status === "exit"
        ? m.flush()
        : m.map({ method: "turn/completed", params: { threadId: "thread", turn: turn(status) } }),
    );
    await send(page, m.map(item(reasoning)));
    await expect(page.getByTestId("reasoning-note")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`codex-${status}.png`), animations: "disabled" });
  });

test("Claude thinking start/stop retains the same visible indicator without revealing text", async ({
  page,
}, info) => {
  await page.evaluate(() => window.gramMock.setModel("t-deps", { agent: "claude", model: "opus" }));
  // Existing repository fixture is invented offline source data, with explicit SDK identity/index.
  const fixture = readFileSync(
    new URL("../../../packages/agents/fixtures/claude/p02-streaming.jsonl", import.meta.url),
    "utf8",
  )
    .trim()
    .split("\n")
    .flatMap((line) => {
      const entry = JSON.parse(line);
      return entry.msg ? [entry.msg] : [];
    });
  const m = makeMapper({ newMessageId: () => MessageId.make("thinking-claude") });
  const start = fixture.filter(
    (msg) =>
      msg.type === "stream_event" &&
      (msg.event.type === "message_start" ||
        (msg.event.type === "content_block_start" && msg.event.content_block.type === "thinking")),
  );
  await send(
    page,
    start.flatMap((msg) => m.map(msg)),
  );
  const note = page.getByTestId("reasoning-note");
  await expect(note).toBeVisible();
  await expect(note).toHaveText("Thinking…");
  await page.screenshot({
    path: info.outputPath("claude-thinking-start.png"),
    animations: "disabled",
  });
  const stop = fixture.find(
    (msg) =>
      msg.type === "stream_event" &&
      msg.event.type === "content_block_stop" &&
      msg.event.index === 0,
  );
  await send(page, m.map(stop));
  await expect(note).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("claude-thinking-end.png"),
    animations: "disabled",
  });
});
