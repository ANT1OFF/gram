import { expect, test, type Page } from "@playwright/test";

import { openReviewsTab, reviewsInPanel } from "./reviews-panel";

// The review requests and the user's open PRs: a compact row each in the overview's Pull requests
// section (folded until opened) under the default placement, and the full lists, with their menus,
// cards and groups, in the right panel's Reviews tab.

const pullRequests = (page: Page) => page.getByTestId("overview-section-pullRequests");
const overviewRows = (page: Page, kind: "review" | "yours") =>
  pullRequests(page).locator(`[data-testid="overview-pr"][data-kind="${kind}"]`);
const unfoldPullRequests = async (page: Page) => {
  const title = pullRequests(page).getByRole("heading").getByRole("button");
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
  await expect(requests.and(page.locator('[data-pr="example/api#530"]'))).toHaveAttribute(
    "title",
    /^Review requests · api#530 · jordan\n/,
  );

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
  await expect(
    page
      .getByTestId("toast")
      .filter({ hasText: "Review requested: example/web#77 Tighten the CSP" }),
  ).toBeVisible();
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

test("right-clicking the list changes what it lists", async ({ page }) => {
  await reviewsInPanel(page, { requests: true });
  await page.goto("/t/t-question");
  const panel = await openReviewsTab(page);
  // By test id: an open menu hides the rest of the page from the accessibility tree.
  const section = panel.getByTestId("review-requests");
  const count = panel.getByTestId("reviews-tab-count");
  await expect(count).toHaveText("2");

  await section.click({ button: "right" });
  const menu = page.getByTestId("review-requests-menu");
  const byName = menu.getByRole("menuitemcheckbox", { name: "Only requests for me by name" });
  await expect(byName).toBeChecked();
  await expect(
    menu.getByRole("menuitemcheckbox", { name: "Hide bot pull requests" }),
  ).toBeChecked();

  // A toggle leaves the menu open, and the team's request arrives behind it.
  await byName.click();
  await expect(byName).not.toBeChecked();
  await expect(count).toHaveText("3");
  await expect(
    section.getByTestId("review-request-group").filter({ hasText: "example/platform" }),
  ).toContainText("#412");

  await menu.getByRole("menuitem", { name: "Maximum age" }).hover();
  await page.getByRole("menuitemradio", { name: "30 days" }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // Settings → Notifications is the same state, seen from the other side.
  await page.goto("/settings/notifications");
  await expect(page.getByRole("switch", { name: /Direct requests only/ })).not.toBeChecked();
  await expect(
    page.getByRole("radiogroup", { name: "Maximum age" }).getByRole("radio", { name: "30 days" }),
  ).toBeChecked();
});

test("rows show their state glyph and age, grouped by repository unless turned off", async ({
  page,
}) => {
  await reviewsInPanel(page, { requests: true });
  await page.goto("/t/t-question");
  const panel = await openReviewsTab(page);
  const section = panel.getByTestId("review-requests");
  const first = section.getByTestId("review-request").first();
  const glyph = first.getByTestId("review-request-glyph");
  await expect(glyph).toHaveAttribute("data-state", "failing");
  await expect(first.getByRole("img", { name: "Checks failing" })).toBeVisible();
  await expect(first.getByTestId("review-request-age")).toHaveText(/^\d+[dw]$/);

  // Failing checks mean the author has work to do first: the row is dimmed, and its card says why.
  await expect(first).toHaveAttribute("data-waiting", "true");
  await expect(section.getByTestId("review-request").last()).toHaveAttribute(
    "data-waiting",
    "false",
  );
  await first.hover();
  const card = page.getByTestId("review-request-card");
  await expect(card).toContainText("example/api#530");
  await expect(card).toContainText("Checks failing");
  // The card spells out what the row's one glyph leaves out.
  await expect(card).toContainText("Review bot: reviewed an earlier commit");
  await expect(card).toContainText("Checks are failing, so this one can wait.");
  await page.mouse.move(0, 0);
  await expect(card).toHaveCount(0);
  const groups = section.getByTestId("review-request-group");
  await expect(groups).toHaveCount(2);
  const api = section.getByRole("region", { name: "example/api" });
  await expect(api.getByTestId("review-request")).toContainText("#530 · jordan");
  await expect(api.getByTestId("review-request")).not.toContainText("example/api#530");

  await api.getByRole("button", { name: /^example\/api/ }).click();
  await expect(api.getByTestId("review-request")).toHaveCount(0);
  await expect(section.getByTestId("review-request")).toHaveCount(1);

  await section.click({ button: "right" });
  await page
    .getByTestId("review-requests-menu")
    .getByRole("menuitemcheckbox", { name: "Group by repository" })
    .click();
  await page.keyboard.press("Escape");
  await expect(groups).toHaveCount(0);
  await expect(section.getByTestId("review-request").first()).toContainText("example/api#530");
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

test("waiting for the review bot holds only in repositories listed as having one", async ({
  page,
}) => {
  await reviewsInPanel(page, { requests: true });
  await page.goto("/t/t-question");
  const panel = await openReviewsTab(page);
  const section = panel.getByTestId("review-requests");
  await expect(panel.getByTestId("reviews-tab-count")).toHaveText("2");
  const menu = page.getByTestId("review-requests-menu");
  const openSettings = async () => {
    await section.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Notification settings…" }).click();
  };

  // Turned on, the list starts with the repositories a bot has reviewed in.
  await openSettings();
  await page.getByRole("switch", { name: /Wait for review bot/ }).check();
  const repos = page.getByTestId("review-bot-repos");
  await expect(repos.getByRole("button", { name: "Remove example/api" })).toBeVisible();
  await expect(repos.getByRole("button", { name: "Remove example/infra" })).toBeVisible();
  await page.goBack();

  // A request the bot hasn't reviewed is held, and can be let go from its menu.
  await page.evaluate(() =>
    window.gramMock?.simulateReviewRequest({
      repo: "example/api",
      number: 531,
      title: "Drop the v1 routes",
      url: "https://github.com/example/api/pull/531",
      author: "jordan",
      updatedAt: "2026-09-17T09:00:00Z",
    }),
  );
  const noBot = menu.getByRole("menuitem", { name: "This repo has no review bot" });
  await section.getByTestId("review-request").filter({ hasText: "#88" }).click({ button: "right" });
  await expect(menu.getByRole("menuitem", { name: "Open on GitHub" })).toBeVisible();
  await expect(noBot).toHaveCount(0);
  await page.keyboard.press("Escape");
  await section
    .getByTestId("review-request")
    .filter({ hasText: "#531" })
    .click({ button: "right" });
  await noBot.click();

  await openSettings();
  await expect(repos.getByRole("button", { name: "Remove example/api" })).toHaveCount(0);
  await expect(repos.getByRole("button", { name: "Remove example/infra" })).toBeVisible();
  await expect(repos.getByRole("button", { name: "Add example/api" })).toBeVisible();
});

test("open PRs list the user's own, name the thread that owns each, and open either", async ({
  page,
}) => {
  await reviewsInPanel(page, { own: true });
  await page.goto("/t/t-question");
  const panel = await openReviewsTab(page);
  const section = panel.getByRole("region", { name: "Open PRs" });
  await expect(section.getByTestId("open-prs-count")).toHaveText("3");
  const api = section.getByRole("region", { name: "example/api" });
  const owned = api.getByTestId("open-pr").filter({ hasText: "#412" });
  await expect(owned.getByRole("img", { name: "Checks failing" })).toBeVisible();
  await expect(
    api.getByTestId("open-pr").filter({ hasText: "#538" }).getByRole("img", {
      name: "Conflicts",
    }),
  ).toBeVisible();
  await expect(
    section.getByTestId("open-pr").filter({ hasText: "#419" }).getByTestId("open-pr-glyph"),
  ).toHaveAttribute("data-state", "draft");

  // The card says what the row has no room for: the branch, the owner, what blocks the merge.
  await owned.hover();
  const card = page.getByTestId("open-pr-card");
  await expect(card).toContainText("fix/flaky-retry");
  await expect(card).toContainText("In the thread “Fix flaky retry test”");
  await expect(card).toContainText("Required reviews or checks are missing");
  await page.mouse.move(0, 0);

  // The row opens the PR; its thread link opens the thread instead.
  await api.getByRole("button", { name: /Open example\/api#538 on GitHub/ }).click();
  await expect
    .poll(() => page.evaluate(() => window.gramMock?.opened))
    .toContain("https://github.com/example/api/pull/538");
  await owned.getByRole("button", { name: "Go to thread: Fix flaky retry test" }).click();
  await expect(page).toHaveURL(/\/t\/t-flaky$/);

  // An owned PR's menu leads to its thread; one nothing owns can be checked out.
  const menu = page.getByTestId("open-prs-menu");
  await owned.click({ button: "right" });
  await expect(menu.getByRole("menuitem", { name: "Go to thread" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Check out…" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await api.getByTestId("open-pr").filter({ hasText: "#538" }).click({ button: "right" });
  await expect(menu.getByRole("menuitem", { name: "Go to thread" })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "Check out…" }).click();
  await expect(
    page
      .getByTestId("checkout-pr-dialog")
      .getByRole("textbox", { name: "Pull request number or URL" }),
  ).toHaveValue("example/api#538");
  await page.keyboard.press("Escape");

  // A PR the user opens since is listed, and never raises a notice.
  await page.evaluate(() =>
    window.gramMock?.simulateOpenPr({
      repo: "example/web",
      number: 91,
      title: "Trim the bundle",
      url: "https://github.com/example/web/pull/91",
      isDraft: false,
      updatedAt: "2026-09-18T09:00:00Z",
    }),
  );
  await expect(section.getByTestId("open-prs-count")).toHaveText("4");
  await expect(section.getByRole("region", { name: "example/web" })).toContainText("#91");
  await expect(page.getByTestId("toast").filter({ hasText: "Trim the bundle" })).toHaveCount(0);
});

test("open PRs keep a placement of their own, sharing the Reviews tab", async ({ page }) => {
  await page.goto("/t/t-question");
  const panel = page.getByTestId("right-panel");
  await unfoldPullRequests(page);
  await expect(overviewRows(page, "yours")).toHaveCount(3);

  await page.goto("/settings/notifications");
  const placement = page.getByRole("radiogroup", { name: "Show open PRs in" });
  await placement.getByRole("radio", { name: "Right panel" }).click();
  await page.goto("/t/t-question");
  // Review requests stay in the sidebar; the tab is there for the open PRs alone.
  await expect(panel.getByRole("tab", { name: /Reviews/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const section = panel.getByTestId("open-prs");
  await expect(section.getByTestId("open-pr")).toHaveCount(3);
  await expect(panel.getByTestId("review-request")).toHaveCount(0);
  await expect(panel.getByTestId("reviews-tab-count")).toHaveCount(0);
  await expect(overviewRows(page, "review")).toHaveCount(2);

  // Its heading folds the list.
  await section.getByRole("button", { name: /^Open PRs/ }).click();
  await expect(section.getByTestId("open-pr")).toHaveCount(0);
  await section.getByRole("button", { name: /^Open PRs/ }).click();
  await expect(section.getByTestId("open-pr")).toHaveCount(3);

  await page.goto("/settings/notifications");
  await expect(placement.getByRole("radio", { name: "Right panel" })).toBeChecked();
  await placement.getByRole("radio", { name: "Hidden" }).click();
  await page.goto("/t/t-question");
  await expect(page.getByTestId("open-prs")).toHaveCount(0);
  await expect(panel.getByRole("tab", { name: /Reviews/ })).toHaveCount(0);
  await expect(overviewRows(page, "yours")).toHaveCount(0);

  await page.goto("/settings/notifications");
  await placement.getByRole("radio", { name: "Sidebar" }).click();
  await page.goto("/t/t-question");
  await expect(overviewRows(page, "yours")).toHaveCount(3);
});
