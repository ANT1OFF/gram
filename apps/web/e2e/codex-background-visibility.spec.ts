import { expect, test } from "@playwright/test";
import displayed from "../src/thread/codex-background.fixture.json" with { type: "json" };

test("Codex background output and count survive parent idle, exit updates one card, and child snapshots are inspectable", async ({
  page,
}, testInfo) => {
  await page.goto("/t/t-deps");
  await page.getByLabel("Message", { exact: true }).waitFor();
  await page.evaluate((message) => {
    window.gramMock!.simulateMessage("t-deps" as never, message as never);
    window.gramMock!.simulateBackground("t-deps" as never, [
      {
        taskId: '["parent-turn","command-1"]',
        kind: "shell",
        description: "printf ready; sleep 30; printf done",
        command: "printf ready; sleep 30; printf done",
        toolCallId: "command-1",
        startedAt: Date.now() - 10_000,
      },
    ]);
  }, displayed.background);
  // The thread's status glyph, in its pane's header, counts the background command.
  const status = page.getByTestId("pane-header").getByTestId("status-icon");
  await expect(status).toHaveAttribute("data-running", "1");
  await expect(page.getByTestId("subagent-strip-row")).toContainText("printf ready");
  const command = page.locator('[data-tool-call-id="command-1"]');
  await command.getByRole("button").click();
  await expect(command).toContainText("Running");
  await expect(command).toContainText("ready");
  await expect(command.getByRole("button")).toHaveAttribute("aria-expanded", "true");
  await expect
    .poll(() => command.evaluate((node) => node.getBoundingClientRect().height))
    .toBeGreaterThan(180);
  await command.locator("pre").last().scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("codex-background-running.png"),
    animations: "disabled",
  });
  await page.evaluate((messages) => {
    window.gramMock!.simulateMessage("t-deps" as never, messages.completed as never);
    window.gramMock!.simulateBackground("t-deps" as never, []);
    window.gramMock!.simulateMessage("t-deps" as never, messages.collaboration as never);
  }, displayed);
  await expect(command).toHaveCount(1);
  await expect(command).toContainText("Done");
  await expect(command).toContainText("done");
  await expect(status).not.toHaveAttribute("data-running");
  await expect(page.getByTestId("subagent-strip-row")).toHaveCount(0);
  const spawn = page.locator('[data-tool-call-id="spawn-1"]');
  await spawn.getByRole("button").click();
  await expect(spawn).toContainText("Last reported agent states");
  await expect(spawn).toContainText("child-1");
  await expect(spawn.getByRole("button")).toHaveAttribute("aria-expanded", "true");
  await expect(spawn.getByText("Last reported agent states")).toBeVisible();
  await expect
    .poll(() => spawn.evaluate((node) => node.getBoundingClientRect().height))
    .toBeGreaterThan(180);
  await expect(page.getByTestId("subagent-transcript")).toHaveCount(0);
  await spawn.getByText("child-1", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("codex-background-exited-and-child-snapshot.png"),
    animations: "disabled",
  });
  // Browser reload restores the same final provider record without restarting old work.
  await page.reload();
  await page.getByLabel("Message", { exact: true }).waitFor();
  await page.evaluate(
    (message) => window.gramMock!.simulateMessage("t-deps" as never, message as never),
    displayed.completed,
  );
  await expect(command).toHaveCount(1);
  await expect(command).toContainText("Done");
  await expect(page.getByTestId("subagent-strip-row")).toHaveCount(0);
});
