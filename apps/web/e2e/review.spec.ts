import { expect, test } from "@playwright/test";

test("shows the review glyph, resolves a bot thread and asks the agent to address one", async ({
  page,
}) => {
  // Wide enough that the PR strip's review chip keeps its words.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  // The PR strip owns the thread's PR: its state, number and the review bot's verdict.
  const row = page.getByTestId("pr-row");
  const badge = row.getByTestId("pr-row-number");
  await expect(badge).toContainText("#412");
  await expect(row.getByTestId("pr-row-review")).toHaveAccessibleName(/^Review bot: 2 blockers/);
  await expect(row.getByRole("img").first()).toHaveAttribute("data-kind", "failing");
  // The header doesn't say it again.
  await expect(page.getByTestId("pane-pr-badge")).toHaveCount(0);

  // The number opens the PR panel, whatever tab the panel was on.
  const panel = page.getByTestId("right-panel");
  await panel.getByRole("tab", { name: "Diff", exact: true }).click();
  await badge.click();
  await expect(panel.getByRole("tab", { name: "PR", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await panel.getByRole("tab", { name: /^Review/ }).click();
  const review = panel.getByTestId("review-panel");
  await expect(review.getByTestId("review-verdict")).toContainText("Changes requested");

  const restoreTimers = review.getByRole("article", { name: "Blocker: src/retry.test.ts:13" });
  await restoreTimers.getByRole("button", { name: "Resolve" }).click();
  await expect(restoreTimers).toBeHidden();
  await expect(review.getByRole("button", { name: "Resolved (2)" })).toBeVisible();
  await expect(row.getByTestId("pr-row-review")).toHaveAccessibleName(/^Review bot: 1 blocker/);

  const lastError = review.getByRole("article", { name: "Blocker: src/retry.ts:38-42" });
  await lastError.getByRole("button", { name: "Ask agent to address" }).click();
  await expect(lastError.getByText(/^(Queued for|Sent to) the agent$/)).toBeVisible();
  await expect(
    page
      .getByTestId("queue-item")
      .or(page.getByTestId("message-user"))
      .filter({ hasText: "Address review finding on PR #412" })
      .first(),
  ).toBeVisible();
});
