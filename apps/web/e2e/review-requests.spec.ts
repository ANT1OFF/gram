import { expect, test, type Page } from "@playwright/test";

import { openReviewsTab, reviewsInPanel } from "./reviews-panel";

// The review requests and the user's open PRs: a compact row each in the overview's At rest
// section (folded until opened) under the default placement, and the full lists, with their menus,
// cards and groups, in the right panel's Reviews tab.

const pullRequests = (page: Page) => page.getByTestId("overview-section-pullRequests");
const overviewRows = (page: Page, kind: "review" | "yours") =>
  pullRequests(page).locator(`[data-testid="overview-pr"][data-kind="${kind}"]`);
const unfoldPullRequests = async (page: Page) => {
  const title = page
    .getByTestId("overview-section-rest")
    .getByRole("heading", { level: 2 })
    .getByRole("button");
  if ((await title.getAttribute("aria-expanded")) === "false") await title.click();
  await expect(title).toHaveAttribute("aria-expanded", "true");
};

test("review requests list in the overview, notify when new and open on GitHub", async ({
  page,
}) => {
  await page.goto("/t/t-question");
  await unfoldPullRequests(page);
  const requests = overviewRows(page, "review");
  await expect(requests).toHaveCount(2);
  await expect(requests.and(page.locator('[data-pr="example/api#530"]'))).toHaveCount(1);

  await page.evaluate(() =>
    window.gramMock?.simulateReviewRequest({
      repo: "example/web",
      number: 77,
      title: "Tighten the CSP",
      url: "https://github.com/example/web/pull/77",
      author: "jordan",
      updatedAt: "2026-09-17T09:00:00Z",
    }),
  );
  await expect(page.getByTestId("toast").filter({ hasText: "example/web#77" })).toBeVisible();
  await expect(requests).toHaveCount(3);

  await requests.filter({ hasText: "Tighten the CSP" }).click();
  await expect
    .poll(() => page.evaluate(() => window.gramMock?.opened))
    .toContain("https://github.com/example/web/pull/77");
});

test("a review request in a known project checks out from its menu in the Reviews tab", async ({
  page,
}) => {
  await reviewsInPanel(page, { requests: true });
  await page.goto("/t/t-question");
  const panel = await openReviewsTab(page);
  const section = panel.getByTestId("review-requests");
  await expect(panel.getByTestId("reviews-tab-count")).toHaveText("2");
  await expect(section.getByRole("region", { name: "example/api" })).toContainText("#530 · jordan");

  // Only the one in a known project offers a checkout, from its right-click menu, prefilled.
  const menu = page.getByTestId("review-requests-menu");
  await section.getByTestId("review-request").filter({ hasText: "#88" }).click({ button: "right" });
  await expect(menu.getByRole("menuitem", { name: "Open on GitHub" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Check out…" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await section
    .getByTestId("review-request")
    .filter({ hasText: "#530" })
    .click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Check out…" }).click();
  const dialog = page.getByTestId("checkout-pr-dialog");
  await expect(dialog.getByRole("textbox", { name: "Pull request number or URL" })).toHaveValue(
    "example/api#530",
  );
});

test("the list moves to a Reviews tab in the right panel, or hides, and comes back", async ({
  page,
}) => {
  await page.goto("/t/t-question");
  const panel = page.getByTestId("right-panel");
  await expect(panel.getByRole("tab", { name: /Reviews/ })).toHaveCount(0);
  await unfoldPullRequests(page);
  await expect(overviewRows(page, "review")).toHaveCount(2);

  // Settings → Notifications places it.
  await page.goto("/settings/notifications");
  const placement = page.getByRole("radiogroup", { name: "Show review requests in" });
  await expect(placement.getByRole("radio", { name: "Sidebar" })).toBeChecked();
  await placement.getByRole("radio", { name: "Right panel" }).click();
  await page.goto("/t/t-question");
  await expect(panel.getByRole("tab", { name: /Reviews/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(panel.getByTestId("reviews-tab-count")).toHaveText("2");
  await expect(panel.getByTestId("review-request")).toHaveCount(2);

  await page.goto("/settings/notifications");
  await expect(placement.getByRole("radio", { name: "Right panel" })).toBeChecked();
  await placement.getByRole("radio", { name: "Hidden" }).click();
  await page.goto("/t/t-question");
  await expect(page.getByTestId("right-panel")).toBeVisible();
  await expect(page.getByTestId("review-requests")).toHaveCount(0);
  await expect(panel.getByRole("tab", { name: /Reviews/ })).toHaveCount(0);
  // Placed nowhere, the overview leaves them out too.
  await unfoldPullRequests(page);
  await expect(overviewRows(page, "review")).toHaveCount(0);

  await page.goto("/settings/notifications");
  await placement.getByRole("radio", { name: "Right panel" }).click();
  await page.goto("/t/t-question");
  await expect(panel.getByTestId("review-request")).toHaveCount(2);

  // The list's own menu takes it back to the sidebar, and the Reviews tab goes with it.
  await panel.getByTestId("review-requests").click({ button: "right" });
  await page.getByTestId("review-requests-menu").getByRole("menuitem", { name: "Show in" }).hover();
  await page.getByRole("menuitemradio", { name: "Sidebar" }).click();
  await expect(panel.getByRole("tab", { name: /Reviews/ })).toHaveCount(0);
  await expect(overviewRows(page, "review")).toHaveCount(2);
});
