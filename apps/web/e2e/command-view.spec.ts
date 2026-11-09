import { expect, test, type Page } from "@playwright/test";

import { threadRow } from "./thread-row";

// A command's line above the composer opens it in the right panel's Command tab: the whole command,
// wrapped, how long it has run, and its output as the adapter reads it back, followed at the bottom
// unless you scroll up. Here a Claude shell in the background, whose call has its result at once,
// so its output comes beside the transcript (`thread.backgroundOutput`).

const THREAD = "t-deps";
const MESSAGE = "m-command-view";
const CALL = "toolu-command-view";
const TASK = "b-command-view";
/** Longer than the strip has room for, so only the Command tab shows the whole of it. */
const COMMAND =
  "S=/private/tmp/example-scratch/-work-repo--worktrees-feat-release; pnpm --filter @example/web run build --mode production && pnpm --filter @example/web run test -- --reporter=dot --run-the-whole-suite";
const CLAUDE = { providerExecuted: true } as const;

const startShell = (page: Page) =>
  page.evaluate(
    ({ threadId, messageId, sent }) =>
      window.gramMock!.simulateChunks(threadId as never, messageId as never, sent as never),
    {
      threadId: THREAD,
      messageId: MESSAGE,
      sent: [
        { type: "start", messageId: MESSAGE },
        { type: "tool-input-start", toolCallId: CALL, toolName: "Bash", ...CLAUDE },
        {
          type: "tool-input-available",
          toolCallId: CALL,
          toolName: "Bash",
          input: { command: COMMAND, run_in_background: true },
          ...CLAUDE,
        },
        {
          type: "tool-output-available",
          toolCallId: CALL,
          output: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: TASK },
          ...CLAUDE,
        },
        { type: "finish" },
      ],
    },
  );

const background = (page: Page, tasks: readonly object[]) =>
  page.evaluate(
    ({ threadId, sent }) => window.gramMock!.simulateBackground(threadId as never, sent as never),
    { threadId: THREAD, sent: tasks },
  );

const output = (page: Page, text: string) =>
  page.evaluate(
    ({ threadId, sent }) =>
      window.gramMock!.simulateBackgroundOutput(threadId as never, sent as never),
    { threadId: THREAD, sent: { taskId: TASK, toolCallId: CALL, output: text } },
  );

const lines = (count: number) =>
  Array.from({ length: count }, (_, i) => `\u001b[2m[build]\u001b[0m step ${i + 1}`).join("\n");

test("a command's line opens it in the Command tab, its output following live until it ends", async ({
  page,
}) => {
  await page.goto(`/t/${THREAD}`);
  await expect(threadRow(page, THREAD)).toBeVisible();
  await startShell(page);
  await background(page, [
    {
      taskId: TASK,
      kind: "shell",
      description: "Build and test the web app",
      command: COMMAND,
      toolCallId: CALL,
      startedAt: Date.now() - 65_000,
    },
  ]);

  const row = page.getByTestId("subagent-strip-row");
  await expect(row).toHaveCount(1);
  const opener = row.getByTestId("subagent-strip-open");
  await expect(opener).toHaveAttribute("aria-pressed", "false");
  await opener.click();

  // The Command tab opens on the whole command, running, with no output read back yet.
  const view = page.getByTestId("command-view");
  await expect(view).toBeVisible();
  await expect(page.getByRole("tab", { name: "Command" })).toHaveAttribute("aria-selected", "true");
  await expect(opener).toHaveAttribute("aria-pressed", "true");
  await expect(view.getByTestId("command-view-command")).toHaveText(`$ ${COMMAND}`);
  await expect(view).toHaveAttribute("data-state", "running");
  await expect(view.getByTestId("command-view-state")).toHaveText("Running");
  await expect(view.getByTestId("command-view-elapsed")).toHaveText(/^for 1m \d\ds$/);
  await expect(view.getByTestId("command-view-empty")).toContainText("No output yet");

  // Its output arrives and grows, colours dropped, the view kept at its bottom.
  await output(page, lines(3));
  const pane = view.getByTestId("command-view-output");
  await expect(pane).toHaveText("[build] step 1\n[build] step 2\n[build] step 3");
  await output(page, lines(200));
  await expect(pane).toContainText("[build] step 200");
  await expect(pane).not.toContainText("\u001b");
  const atBottom = () =>
    pane.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight <= 24);
  await expect.poll(atBottom).toBe(true);

  // Scrolled up to read, it stays put as more comes; Jump to live follows again.
  await pane.evaluate((node) => {
    node.scrollTop = 0;
  });
  const jump = view.getByTestId("command-view-jump");
  await expect(jump).toHaveText("Jump to live");
  await output(page, lines(240));
  await expect(pane).toContainText("[build] step 240");
  expect(await pane.evaluate((node) => node.scrollTop)).toBe(0);
  await jump.click();
  await expect(jump).toHaveCount(0);
  await expect.poll(atBottom).toBe(true);

  // Its task ends: the line goes, the tab stays with what it last wrote and its time held still.
  await output(page, `${lines(240)}\nbuilt in 81s`);
  await expect(pane).toContainText("built in 81s");
  await background(page, []);
  await expect(row).toHaveCount(0);
  await expect(view).toHaveAttribute("data-state", "done");
  await expect(view.getByTestId("command-view-state")).toHaveText("Finished");
  await expect(pane).toContainText("built in 81s");
  await expect(view.getByTestId("command-view-elapsed")).toHaveText(/^after 1m \d\ds$/);

  // Close puts the tab away.
  await view.getByTestId("command-view-close").click();
  await expect(view).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Command" })).toHaveCount(0);
});
