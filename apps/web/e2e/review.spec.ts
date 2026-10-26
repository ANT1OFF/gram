import { expect, test } from "@playwright/test";

test("shows the review glyph, resolves a bot thread and asks the agent to address one", async ({
  page,
}) => {
  // Wide enough that the one bar keeps the PR badge among its chips; narrower, it folds away.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  const badge = page.getByTestId("pane-pr-badge");
  await expect(badge).toContainText("#412");
  // The pane header carries the review glyph alongside the PR's state and number.
  await expect(
    badge.getByRole("img", { name: "Review bot: 2 blockers", exact: true }),
  ).toBeVisible();

  await expect(badge).toHaveAttribute("data-state", "failing");

  // The badge opens the PR panel, whatever tab the panel was on.
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
  await expect(
    badge.getByRole("img", { name: "Review bot: 1 blocker", exact: true }),
  ).toBeVisible();

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
