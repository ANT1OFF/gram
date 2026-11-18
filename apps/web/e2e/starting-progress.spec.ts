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
  // A workspace's orchestrator briefs a worker, as `spawn_worker` does.
  await page.goto("/");
  await page.getByTestId("overview-sidebar").waitFor();
  const workerId = await page.evaluate(async () => {
    const mock = window.gramMock!;
    const home = mock.world.projects()[0]!;
    const state = await mock.saveWorkspace({
      name: home.name,
      projectIds: [home.id],
      homeProjectId: home.id,
    });
    await mock.openOrchestrator({ workspaceId: state.workspace.id });
    const worker = await mock.simulateBrief(state.workspace.id, "queue-retry", "Queue retry");
    void mock.send(worker.id, { text: "Add retry coverage for the queue consumer." });
    return worker.id;
  });
  await page.evaluate((id) => {
    history.pushState({}, "", `/t/${id}`);
    dispatchEvent(new PopStateEvent("popstate"));
  }, workerId);
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
