import { expect, test } from "@playwright/test";

// A new worker's transcript while its session opens: the brief, then one row of what is under way
// (its branch, its worktree, the CLI starting, its first tool) until the agent's first output.
test("a starting worker shows its progress under the brief until its first output", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.gramMockHoldGates = true;
    window.gramMockHoldWorkerStart = true;
  });
  await page.goto("/new-task?way=direct");
  await page.getByLabel("What needs doing").fill("Add retry coverage for the queue consumer.");
  await page.getByRole("button", { name: /Start (workspace and )?worker/ }).click();
  await expect(page).toHaveURL(/\/t\//);
  await expect(page.getByTestId("message-user").first()).toContainText("Add retry coverage");

  const progress = page.getByTestId("starting-progress");
  await expect(progress).toBeVisible();
  const steps = progress.getByRole("listitem");
  await expect(steps).toHaveCount(4);
  const states = async () =>
    progress
      .locator("[data-step]")
      .evaluateAll((items) =>
        items.map((item) => `${item.getAttribute("data-step")}:${item.getAttribute("data-state")}`),
      );
  expect(await states()).toEqual([
    "branch:done",
    "worktree:done",
    "launch:active",
    "first:pending",
  ]);
  await expect(progress.locator('[data-step="launch"]')).toHaveText(/Starting Claude Code/);
  await expect(progress.locator('[data-step="launch"]')).toHaveAttribute("aria-current", "step");
  // The branch is named; the worktree goes by its folder, its full path on hover.
  await expect(progress.locator('[data-step="branch"]')).toHaveText(/Branch \S+/);
  await expect(progress.locator('[data-step="worktree"]')).toHaveAttribute("title", /\//);

  // The session opens and the agent answers: the row has done its job and goes.
  await page.evaluate(() => window.gramMock!.release("worker-start"));
  await expect(page.getByTestId("message-assistant").first()).toBeVisible({ timeout: 15_000 });
  await expect(progress).toHaveCount(0);
});
