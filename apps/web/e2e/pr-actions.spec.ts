import { expect, test } from "@playwright/test";
import { openPanelTab } from "./panel-tab";

test("the PR row's menu copies, opens and refreshes the PR", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  // The PR strip owns the PR, so the header's badge and chips wait until it's hidden there.
  const row = page.getByTestId("pr-row");
  await expect(row.getByTestId("pr-row-number")).toContainText("#412");
  await expect(page.getByTestId("pane-pr-badge")).toHaveCount(0);
  await expect(page.getByTestId("pane-merge-state")).toHaveCount(0);

  await row.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Copy PR link" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Open #412 on GitHub" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Refresh from GitHub" }).click();
  await expect(page.getByRole("menuitem", { name: "Copy PR link" })).toHaveCount(0);

  // Hidden from the strip, the PR is the header's again.
  await row.getByRole("button", { name: /^Hide #412 / }).click();
  await expect(row).toHaveCount(0);
  await expect(page.getByTestId("pane-pr-badge")).toContainText("#412");
  await expect(page.getByTestId("pane-merge-state")).toHaveText("Blocked");
  await expect(page.getByTestId("pane-review-decision")).toHaveText("Changes requested");
});

test("the PR overview leads with what blocks the merge and one next step", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  await openPanelTab(page.getByTestId("right-panel"), "PR");
  const panel = page.getByTestId("pr-panel");

  const blocked = panel.getByTestId("pr-merge-blocked");
  // Counted in the heading, named once in the list under it.
  await expect(blocked).toHaveText("Merge blocked · 3 reasons");
  // The header line above doesn't repeat what the summary says.
  await expect(panel.getByTestId("pr-merge-state")).toHaveCount(0);
  await expect(panel.getByTestId("review-decision")).toHaveCount(0);
  const reasons = panel.getByRole("list", { name: "What blocks the merge" }).getByRole("listitem");
  await expect(reasons.first()).toHaveText("test (windows) failing");
  await expect(reasons.nth(1)).toHaveText("Changes requested by reviewer");
  const actions = panel.getByTestId("pr-actions").getByRole("button");
  // The row is the next step alone: the reasons above already say the merge is blocked, and
  // Merge… waits in "…", described by them.
  await expect(actions).toHaveText(["Inspect test (windows) job"]);
  await expect(panel.getByTestId("pr-merge")).toHaveCount(0);
  await panel.getByRole("button", { name: "More PR actions" }).click();
  await expect(page.getByTestId("pr-merge-menu")).toHaveAttribute(
    "aria-describedby",
    (await blocked.getAttribute("id"))!,
  );
  await page.keyboard.press("Escape");

  // The summary and its step sit above the reviewers, the labels and what the agent watches,
  // which wait folded while something blocks the merge.
  const manage = panel.getByTestId("pr-manage-toggle");
  await expect(manage).toHaveAttribute("aria-expanded", "false");
  await expect(manage).toContainText("4 reviewers · 2 labels · not watching");
  await expect(panel.getByTestId("pr-watch")).toHaveCount(0);
  await manage.click();
  const top = async (locator: ReturnType<typeof panel.getByTestId>) =>
    (await locator.boundingBox())!.y;
  const summary = await top(panel.getByTestId("pr-blockers"));
  const step = await top(panel.getByTestId("pr-actions"));
  const reviewers = await top(panel.getByTestId("pr-reviewers"));
  const labels = await top(panel.getByRole("button", { name: "Add label…" }));
  const watch = await top(panel.getByTestId("pr-watch"));
  expect(summary).toBeLessThan(step);
  expect(step).toBeLessThan(reviewers);
  expect(reviewers).toBeLessThanOrEqual(labels);
  expect(labels).toBeLessThan(watch);

  await panel.getByTestId("pr-next-action").click();
  const checks = panel.getByRole("region", { name: "Checks" });
  await expect(checks.getByRole("button", { name: "Hide test (windows) job" })).toBeFocused();
  await expect(checks.getByTestId("ci-job-detail")).toContainText("Run 9102 · Attempt 1 · Job 3");
  await expect(checks.getByTestId("ci-job-detail")).toBeInViewport();
});

test("rerun failed checks, then squash-merge the PR from the panel", async ({ page }) => {
  await page.goto("/t/t-flaky");
  await openPanelTab(page.getByTestId("right-panel"), "PR");
  const panel = page.getByTestId("pr-panel");

  const checks = panel.getByRole("region", { name: "Checks" });
  await expect(checks.getByTestId("check-run").filter({ hasText: "test (windows)" })).toContainText(
    "Failing",
  );
  await checks.getByRole("button", { name: "Rerun failed" }).click();
  await expect(checks.getByText("Rerunning the failed jobs of 1 run.")).toBeVisible();
  await expect(checks.getByTestId("check-run").filter({ hasText: "test (windows)" })).toContainText(
    "Queued",
  );
  await expect(checks.getByRole("button", { name: "Rerun failed" })).toHaveCount(0);

  // Still blocked on the requested changes: the row is their next step, and Merge… is in "…".
  await panel.getByRole("button", { name: "More PR actions" }).click();
  await page.getByTestId("pr-merge-menu").click();
  const dialog = page.getByTestId("pr-merge-dialog");
  await expect(dialog).toContainText("Merge #412 into main?");
  await expect(dialog.getByRole("radio", { name: "Squash and merge" })).toBeChecked();
  await dialog.getByRole("button", { name: "Squash and merge" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(panel.getByText("Merged #412.")).toBeVisible();
  await expect(panel.locator("header").getByText("Merged", { exact: true })).toBeVisible();
  await expect(panel.getByTestId("pr-actions")).toHaveCount(0);
});
