import { expect, test, type Page } from "@playwright/test";

import type { MockOneThreadSimulation } from "../src/api/mock-asks";
import { openOrchestrator, threadRow } from "./thread-row";

// The beside dock's Terminal tab follows the worker's running command as its output arrives in the
// transcript, the way Codex streams it: preliminary output snapshots, then the exit. It only reads:
// the orchestrator's composer keeps the keyboard, and watching never holds the worker.

const MESSAGE = "m-live-terminal";
const CALL = "call-live-terminal";
const COMMAND = "uv run pytest tests/queue";

const open = async (page: Page): Promise<MockOneThreadSimulation> => {
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  const made = await page.evaluate(() => window.gramMock!.simulateOneThread());
  await openOrchestrator(page, made.orchestratorThreadId);
  return made;
};

const pane = (page: Page, threadId: string) =>
  page.locator(`[data-testid="pane"][data-thread-id="${threadId}"]`);
const composerOf = (page: Page, threadId: string) =>
  pane(page, threadId).getByLabel("Message", { exact: true });

/** Whether the user holds the worker, and how many messages it has. */
const workerFacts = (page: Page, made: MockOneThreadSimulation) =>
  page.evaluate(
    async ({ workspaceId, worker }) => {
      const mock = window.gramMock!;
      const ledger = await mock.orchestratorLedger(workspaceId);
      const entry = ledger.features
        .flatMap((feature) => feature.workers)
        .find((each) => each.threadId === worker);
      return {
        held: entry?.userIntervened ?? false,
        users: mock.world.messages(worker as never).filter((m) => m.role === "user").length,
      };
    },
    { workspaceId: made.workspaceId, worker: made.live },
  );

/** Adapter chunks on the worker's feed, as the server forwards a Codex command's. */
const stream = (page: Page, worker: string, chunks: readonly object[]) =>
  page.evaluate(
    ({ threadId, messageId, sent }) =>
      window.gramMock!.simulateChunks(threadId as never, messageId as never, sent as never),
    { threadId: worker, messageId: MESSAGE, sent: chunks },
  );

const FLAGS = { dynamic: true, providerExecuted: true } as const;
const snapshot = (stdout: string, more: object = {}) => ({
  type: "tool-output-available",
  toolCallId: CALL,
  output: { stdout, stderr: "", interrupted: false, ...more },
  ...FLAGS,
});

/** pytest's progress so far, `done` of 52, with its colours. */
const progress = (done: number) =>
  [
    `\u001b[1mcollected 52 items\u001b[0m`,
    `tests/queue/test_consumer.py ${".".repeat(Math.min(done, 30))}`,
    `tests/queue/test_retry.py ${".".repeat(Math.max(0, done - 30))}`,
    ...Array.from({ length: done }, (_, i) => `PASSED test_${i}`),
    `\u001b[32m[${done}/52]\u001b[0m`,
  ].join("\n");

test("the Terminal tab follows the worker's running command live, and only reads", async ({
  page,
}) => {
  const made = await open(page);
  const before = await workerFacts(page, made);
  // The worker's row under its orchestrator in the overview opens it.
  await threadRow(page, made.live).click();
  await page.keyboard.press("ControlOrMeta+Backslash");
  const dock = page.getByTestId("beside-dock");
  await expect(dock).toHaveAttribute("data-thread-id", made.live);
  const composer = composerOf(page, made.orchestratorThreadId);
  await expect(composer).toBeFocused();

  // Choosing the tab leaves the keyboard where it was; the suite it is running shows as running.
  await dock.getByTestId("beside-tab-terminal").click();
  await expect(composer).toBeFocused();
  const terminal = dock.getByTestId("beside-terminal");
  await expect(terminal).toHaveText(`$ ${COMMAND}`);
  await expect(terminal).toHaveAttribute("data-running", "true");
  await expect(dock.getByTestId("beside-terminal-live")).toHaveText("Following live");

  // A command starts and its output streams in: the terminal shows it as it grows, colours dropped.
  await stream(page, made.live, [
    { type: "start", messageId: MESSAGE },
    { type: "tool-input-start", toolCallId: CALL, toolName: "Bash", ...FLAGS },
    {
      type: "tool-input-available",
      toolCallId: CALL,
      toolName: "Bash",
      input: { command: COMMAND },
      ...FLAGS,
    },
    { ...snapshot(progress(12)), preliminary: true },
  ]);
  await expect(terminal).toHaveAttribute("data-tool-call-id", CALL);
  await expect(terminal).toContainText("collected 52 items");
  await expect(terminal).toContainText("[12/52]");
  await expect(terminal).not.toContainText("\u001b");
  const atBottom = () =>
    terminal.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight <= 24);
  await expect.poll(atBottom).toBe(true);

  await stream(page, made.live, [{ ...snapshot(progress(30)), preliminary: true }]);
  await expect(terminal).toContainText("[30/52]");
  await expect(terminal).not.toContainText("[12/52]");
  await expect.poll(atBottom).toBe(true);

  // Scrolled up to read, it stays put as output arrives; Jump to live follows again.
  await terminal.evaluate((node) => {
    node.scrollTop = 0;
  });
  const jump = dock.getByTestId("beside-terminal-jump");
  await expect(jump).toBeVisible();
  await stream(page, made.live, [{ ...snapshot(progress(40)), preliminary: true }]);
  await expect(terminal).toContainText("[40/52]");
  expect(await terminal.evaluate((node) => node.scrollTop)).toBe(0);
  await jump.click();
  await expect(composer).toBeFocused();
  await expect(dock.getByTestId("beside-terminal-live")).toBeVisible();
  await expect.poll(atBottom).toBe(true);

  // What you type still goes to the orchestrator, while the worker's output keeps coming.
  await page.keyboard.type("Tell me when it's green");
  await expect(composer).toHaveValue("Tell me when it's green");

  // It exits: its last output and Done, and nothing running any more.
  await stream(page, made.live, [
    snapshot(`${progress(52)}\n\u001b[32m52 passed in 41.2s\u001b[0m`, { exitCode: 0 }),
    { type: "finish" },
  ]);
  await expect(terminal).toContainText("52 passed in 41.2s");
  await expect(terminal).toHaveAttribute("data-running", "false");
  await expect(dock.getByTestId("beside-terminal-status")).toHaveText("Done");
  await expect(dock.getByTestId("beside-terminal-live")).toHaveCount(0);

  // The pre is no text field, and watching sent the worker nothing and didn't hold it.
  expect(await terminal.evaluate((node) => (node as HTMLElement).isContentEditable)).toBe(false);
  await expect(dock.locator("input, textarea, [contenteditable='true']")).toHaveCount(0);
  expect(await workerFacts(page, made)).toEqual(before);
  expect(before.held).toBe(false);
});

// A Claude shell in the background: its call has its result at once ("Background command
// started"), so its output arrives beside the transcript (`thread.backgroundOutput`, which the
// Claude adapter reads back while the task runs) and the Terminal tab follows that instead.
const BG_MESSAGE = "m-background-shell";
const BG_CALL = "toolu-background-shell";
const BG_TASK = "b-dev-server";
const BG_COMMAND = "pnpm dev";
const CLAUDE = { providerExecuted: true } as const;

test("the Terminal tab follows a background shell's output until its task ends", async ({
  page,
}) => {
  const made = await open(page);
  const before = await workerFacts(page, made);
  // The worker's row under its orchestrator in the overview opens it.
  await threadRow(page, made.live).click();
  await page.keyboard.press("ControlOrMeta+Backslash");
  const dock = page.getByTestId("beside-dock");
  await expect(dock).toHaveAttribute("data-thread-id", made.live);
  const composer = composerOf(page, made.orchestratorThreadId);
  await dock.getByTestId("beside-tab-terminal").click();
  await expect(composer).toBeFocused();
  const terminal = dock.getByTestId("beside-terminal");

  // The worker starts the dev server in the background: the call comes back at once.
  await page.evaluate(
    ({ threadId, messageId, sent }) =>
      window.gramMock!.simulateChunks(threadId as never, messageId as never, sent as never),
    {
      threadId: made.live,
      messageId: BG_MESSAGE,
      sent: [
        { type: "start", messageId: BG_MESSAGE },
        { type: "tool-input-start", toolCallId: BG_CALL, toolName: "Bash", ...CLAUDE },
        {
          type: "tool-input-available",
          toolCallId: BG_CALL,
          toolName: "Bash",
          input: { command: BG_COMMAND, run_in_background: true },
          ...CLAUDE,
        },
        {
          type: "tool-output-available",
          toolCallId: BG_CALL,
          output: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: BG_TASK },
          ...CLAUDE,
        },
        { type: "finish" },
      ],
    },
  );
  const background = (tasks: readonly object[]) =>
    page.evaluate(
      ({ threadId, sent }) => window.gramMock!.simulateBackground(threadId as never, sent as never),
      { threadId: made.live, sent: tasks },
    );
  const output = (text: string) =>
    page.evaluate(
      ({ threadId, sent }) =>
        window.gramMock!.simulateBackgroundOutput(threadId as never, sent as never),
      { threadId: made.live, sent: { taskId: BG_TASK, toolCallId: BG_CALL, output: text } },
    );
  await background([
    {
      taskId: BG_TASK,
      kind: "shell",
      description: "Start the dev server",
      command: BG_COMMAND,
      toolCallId: BG_CALL,
      startedAt: Date.now(),
    },
  ]);
  await expect(terminal).toHaveAttribute("data-tool-call-id", BG_CALL);
  await expect(terminal).toHaveAttribute("data-running", "true");
  await expect(dock.getByTestId("beside-terminal-live")).toHaveText("Following live");

  // Its output streams in beside the transcript, colours dropped.
  await output("\u001b[32mVITE v7 ready\u001b[0m\n");
  await expect(terminal).toContainText("VITE v7 ready");
  await expect(terminal).not.toContainText("\u001b");
  await output("\u001b[32mVITE v7 ready\u001b[0m\nLocal: http://localhost:5173/\n");
  await expect(terminal).toContainText("Local: http://localhost:5173/");
  await expect(composer).toBeFocused();

  // The task ends: Done, and what it last wrote stays.
  await background([]);
  await expect(terminal).toHaveAttribute("data-running", "false");
  await expect(dock.getByTestId("beside-terminal-status")).toHaveText("Done");
  await expect(terminal).toContainText("Local: http://localhost:5173/");

  // Only read: no field in the dock, and the worker was sent nothing and isn't held.
  await expect(dock.locator("input, textarea, [contenteditable='true']")).toHaveCount(0);
  expect(await workerFacts(page, made)).toEqual(before);
});
