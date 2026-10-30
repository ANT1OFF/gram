import { expect, test } from "@playwright/test";

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
