import { expect, test } from "@playwright/test";

test("the pane's PR badge menu copies, opens and refreshes the PR", async ({ page }) => {
  // Wide enough that the one bar keeps the PR badge among its chips; narrower, it folds away.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  const badge = page.getByTestId("pane-pr-badge");
  await expect(page.getByTestId("pane-merge-state")).toHaveText("Blocked");
  await expect(page.getByTestId("pane-review-decision")).toHaveText("Changes requested");

  await badge.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Copy PR link" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Open #412 on GitHub" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Refresh from GitHub" }).click();
  await expect(page.getByRole("menuitem", { name: "Copy PR link" })).toHaveCount(0);
});

test("rerun failed checks, then squash-merge the PR from the panel", async ({ page }) => {
  await page.goto("/t/t-flaky");
  await page.getByRole("tab", { name: "PR", exact: true }).click();
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

  await panel.getByRole("button", { name: "Merge…" }).click();
  const dialog = page.getByTestId("pr-merge-dialog");
  await expect(dialog).toContainText("Merge #412 into main?");
  await expect(dialog.getByRole("radio", { name: "Squash and merge" })).toBeChecked();
  await dialog.getByRole("button", { name: "Squash and merge" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(panel.getByText("Merged #412.")).toBeVisible();
  await expect(panel.locator("header").getByText("Merged", { exact: true })).toBeVisible();
  await expect(panel.getByTestId("pr-actions")).toHaveCount(0);
});
