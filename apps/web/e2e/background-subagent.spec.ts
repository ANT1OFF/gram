import { expect, test, type Locator, type Page } from "@playwright/test";

import { clipboardText } from "./clipboard";
import { threadRow } from "./thread-row";

// The mock replays a recorded Claude Code run: the Explore agent launches in the background, the
// turn ends while it works on, and the agent answers once the subagent reports back.
test("an idle thread shows its background subagent running under it, then the agent reports back", async ({
  page,
}) => {
  // The script holds the idle-with-subagent phase at a gate until the checks below release it, so
  // no assertion races a wall-clock phase on a slow or fast runner.
  await page.addInitScript(() => {
    window.gramMockHoldGates = true;
  });
  await page.goto("/t/t-background");
  const header = page.getByTestId("pane-header");
  const card = page.locator('[data-testid="tool-card"][data-tool="Agent"]');
  const cardState = card.getByRole("button").first();

  await expect(cardState).toContainText("Explore");
  await expect(cardState).toContainText("Running");
  await expect(card).toContainText("Running in the background");

  // Idle, with the subagent still working under it: the header's glyph says so, not the turn's
  // spinner, and names it on hover. One task running has no count at the glyph's corner.
  const hint = page.locator('[data-slot="tooltip-content"]');
  const running = "Running: a subagent\n• List all files in the repository (Explore)";
  await header.getByTestId("pane-status").hover();
  await expect(hint).toHaveText(running);
  await expect(header.getByTestId("status-icon")).toHaveAttribute("data-working", "false");
  await expect(header.getByTestId("status-icon")).toHaveAttribute("data-running", "1");
  await expect(header.getByTestId("running-count")).toHaveCount(0);
  // The overview's row shows the thread is there without naming the subagent.
  await expect(threadRow(page, "t-background")).not.toContainText("Explore");
  await expect(card.getByTestId("subagent-transcript")).toContainText("glob patterns");
  await expect(cardState).toContainText("Running");
  // The turn is over, yet the agent is visibly working: Stop has to be there for that too.
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();

  // The strip above the composer lists it with a live clock, and ⌥⌘J jumps to its card.
  const stripRow = page.getByTestId("subagent-strip-row");
  await expect(stripRow).toHaveCount(1);
  await expect(stripRow).toContainText("List all files in the repository");
  await expect(stripRow).toContainText("Explore");
  await expect(stripRow.getByTestId("subagent-elapsed")).toHaveText(/^for \d+s$/);
  await expect(stripRow.getByTestId("subagent-strip-stop")).toBeVisible();
  await page.getByLabel("Message", { exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+Alt+j");
  await expect(cardState).toBeFocused();

  await page.evaluate(() => window.gramMock?.release("subagent-report"));

  // The subagent finishes, and the agent answers in a turn of its own.
  await expect(cardState).toContainText("Done");
  await expect(card).toContainText("Ran in the background");
  await expect(card.getByTestId("subagent-transcript")).toContainText("7 project files");
  await expect(
    card.getByTestId("subagent-transcript").getByTestId("message-assistant"),
  ).toHaveCount(1);
  await expect(page.getByTestId("message-assistant").last()).toContainText("DONE");
  await expect(stripRow).toHaveCount(0);
  await header.getByTestId("pane-status").hover();
  await expect(hint.last()).toBeVisible();
  await expect(hint.last()).not.toContainText("Explore");
  await expect(header.getByTestId("status-icon")).toHaveAttribute("data-working", "false");
  await expect(header.getByTestId("status-icon")).not.toHaveAttribute("data-running");
});

test("counts a background shell and a busy terminal under a thread, and stops the shell", async ({
  page,
}) => {
  await page.goto("/t/t-deps");
  await expect(threadRow(page, "t-deps")).toBeVisible();
  // The thread's status glyph is in its pane's header.
  const glyph = page.getByTestId("pane-header").getByTestId("pane-status");
  const status = glyph.getByTestId("status-icon");
  await expect(status).not.toHaveAttribute("data-running");

  await page.evaluate(() => {
    const mock = window.gramMock!;
    const at = Date.now() - 65_000;
    mock.simulateBackground("t-deps" as never, [
      {
        taskId: "b1",
        kind: "shell",
        description: "Run the API tests",
        command: "pnpm test --filter api",
        startedAt: at,
      },
    ]);
    mock.simulateTerminalProcesses("t-deps" as never, [
      { terminalId: "term-1" as never, pid: 4120, command: "pnpm dev", startedAt: at },
    ]);
  });

  // Both count toward the thread's glyph, and its hint names each.
  await expect(status).toHaveAttribute("data-running", "2");
  await expect(glyph.getByTestId("running-count")).toHaveText("2");
  await glyph.hover();
  await expect(page.locator('[data-slot="tooltip-content"]').last()).toHaveText(
    "Running: a background shell and a terminal process\n• pnpm test --filter api\n• pnpm dev",
  );

  // The strip has the shell with Stop; the terminal's process shows on the Terminal tab instead.
  const stripRow = page.getByTestId("subagent-strip-row");
  await expect(stripRow).toHaveCount(1);
  await expect(stripRow).toHaveAttribute("data-kind", "shell");
  await expect(stripRow).toContainText("pnpm test --filter api");
  await expect(stripRow.getByTestId("subagent-elapsed")).toHaveText(/^for 1m \d\ds$/);
  await expect(page.getByTestId("terminal-busy")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Terminal: pnpm dev running" })).toBeVisible();

  await stripRow.getByRole("button", { name: "Stop pnpm test --filter api" }).click();
  await expect(stripRow).toHaveCount(0);
  await expect(status).toHaveAttribute("data-running", "1");
  await expect(glyph.getByTestId("running-count")).toHaveCount(0);

  // Past three the strip folds to one line, which opens to list each with its own Stop.
  await page.evaluate(() => {
    const at = Date.now();
    window.gramMock!.simulateBackground(
      "t-deps" as never,
      ["lint", "test", "build", "e2e"].map((name, i) => ({
        taskId: `s-${name}`,
        kind: "shell" as const,
        description: `Run ${name}`,
        command: `pnpm ${name}`,
        startedAt: at - i * 1000,
      })),
    );
  });
  const folded = page.getByTestId("subagent-strip-folded");
  await expect(folded).toContainText("4 running");
  await expect(stripRow).toHaveCount(0);
  await folded.click();
  await expect(folded).toHaveAttribute("aria-expanded", "true");
  await expect(stripRow).toHaveCount(4);
  await page.getByRole("button", { name: "Stop pnpm build" }).click();
  // Three left fit unfolded.
  await expect(folded).toHaveCount(0);
  await expect(stripRow).toHaveCount(3);
  await expect(page.getByTestId("subagent-strip")).not.toContainText("pnpm build");

  // In a short pane a long open list scrolls, and the composer stays in view.
  await page.evaluate(() => {
    const at = Date.now();
    window.gramMock!.simulateBackground(
      "t-deps" as never,
      Array.from({ length: 8 }, (_, i) => ({
        taskId: `many-${i}`,
        kind: "shell" as const,
        description: `Shard ${i}`,
        command: `pnpm test --shard ${i + 1}/8`,
        startedAt: at - i * 1000,
      })),
    );
  });
  await page.setViewportSize({ width: 1280, height: 420 });
  if ((await folded.getAttribute("aria-expanded")) !== "true") await folded.click();
  await expect(stripRow).toHaveCount(8);
  await expect(page.getByLabel("Message", { exact: true })).toBeInViewport();
  const last = page.getByRole("button", { name: "Stop pnpm test --shard 8/8" });
  await last.click();
  await expect(stripRow).toHaveCount(7);
  await expect(page.getByLabel("Message", { exact: true })).toBeInViewport();
});

/** Claude Code's shape for a shell it moved to the background: the description is the command. */
const heredoc = (file: string) =>
  `cat > app/${file}.py <<'EOF'\n${"VALUE_FROM_THE_FILE = 1\n".repeat(120)}EOF\nls`;

/** Four shells that are heredocs, a minute apart. */
const seedHeredocs = (page: Page) =>
  page.evaluate(
    (files) => {
      const at = Date.now();
      window.gramMock!.simulateBackground(
        "t-deps" as never,
        files.map(({ file, command }, i) => ({
          taskId: `h-${file}`,
          kind: "shell" as const,
          description: command,
          command,
          startedAt: at - i * 60_000,
        })),
      );
    },
    ["config", "sampling", "stores", "cli"].map((file) => ({ file, command: heredoc(file) })),
  );

const inWindow = async (page: Page, hint: Locator) => {
  const box = (await hint.boundingBox())!;
  const { width, height } = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  expect(box.y + box.height).toBeLessThanOrEqual(height);
};

test.describe("a shell that is a heredoc", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("shows its first line in short tooltips inside the window, and copies the whole", async ({
    page,
  }) => {
    await page.goto("/t/t-deps");
    await expect(threadRow(page, "t-deps")).toBeVisible();
    await seedHeredocs(page);

    const hint = page.locator('[data-slot="tooltip-content"]');
    const folded = page.getByTestId("subagent-strip-folded");
    await folded.hover();
    await expect(hint.last()).toContainText("cat > app/sampling.py <<'EOF' …");
    await expect(hint.last()).not.toContainText("VALUE_FROM_THE_FILE");
    await inWindow(page, hint.last());

    // In the smallest window, eight wordy tasks still show six and the count, none cut off.
    await page.mouse.move(0, 0);
    await page.setViewportSize({ width: 960, height: 600 });
    await page.evaluate((command) => {
      const at = Date.now();
      window.gramMock!.simulateBackground(
        "t-deps" as never,
        Array.from({ length: 8 }, (_, i) => ({
          taskId: `wordy-${i}`,
          kind: "shell" as const,
          description: `Regenerate the fixtures for shard ${i} ${"and check them twice ".repeat(6)}`,
          command,
          startedAt: at - i * 1000,
        })),
      );
    }, heredoc("fixtures"));
    await folded.hover();
    const count = hint.last().getByText("and 2 more");
    await expect(count).toBeVisible();
    await expect(hint.last().locator("li")).toHaveCount(7);
    await inWindow(page, count);
    await inWindow(page, hint.last());
    await page.setViewportSize({ width: 1280, height: 720 });
    await seedHeredocs(page);

    await folded.click();
    const stripRow = page.getByTestId("subagent-strip-row").filter({ hasText: "app/config.py" });
    await expect(stripRow).toContainText("cat > app/config.py <<'EOF' …");
    await stripRow.getByTestId("subagent-strip-copy").click();
    await expect(stripRow.getByRole("button", { name: "Copied" })).toBeVisible();
    await expect.poll(() => clipboardText(page)).toBe(heredoc("config"));

    await page.getByTestId("pane-header").getByTestId("pane-status").hover();
    await expect(hint.last()).toContainText("• cat > app/cli.py <<'EOF' …");
    await expect(hint.last()).not.toContainText("VALUE_FROM_THE_FILE");
    await inWindow(page, hint.last());
  });
});
