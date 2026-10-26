import { expect, test } from "@playwright/test";

test("turns babysit on from the PR panel and shows the first review notice", async ({ page }) => {
  // Wide enough that the one bar keeps the PR badge among its chips; narrower, it folds away.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  // The thread header's PR badge, which opens the PR panel.
  const badge = page.getByTestId("pane-pr-badge");
  await expect(badge).toContainText("#412");
  await badge.click();

  const panel = page.getByTestId("right-panel");
  await expect(panel.getByRole("tab", { name: "PR", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const toggle = panel.getByRole("switch", { name: "Babysit this PR" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(panel.getByTestId("babysit-status")).toContainText("Watching");
  // The badge carries babysitting in a glyph of its own.
  await expect(badge.getByTestId("babysit-glyph")).toHaveAttribute("data-phase", "watching");
  await expect(badge.getByRole("img", { name: /^Babysitting/ })).toBeVisible();

  const notice = page.getByRole("article", { name: "Review update on #412" });
  await expect(notice).toBeVisible();
  await expect(notice.getByTestId("notice-verdict")).toHaveText("Changes requested");
  await expect(notice.getByRole("region", { name: "Blockers" })).toContainText("src/retry.ts:42");
  await expect(notice.getByRole("region", { name: "Suggestions" })).toContainText(
    "src/retry.test.ts:18",
  );
  await expect(panel.getByTestId("babysit-status")).toHaveText("Watching · round 1 of 6");

  await notice.getByRole("button", { name: "Text sent to the agent" }).click();
  await expect(notice.getByTestId("notice-text")).toContainText("Review update on #412");
});
