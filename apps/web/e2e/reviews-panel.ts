import type { Page } from "@playwright/test";

/**
 * Places the review requests, the user's open PRs or both in the right panel's Reviews tab before
 * the page loads, as their "Show in → Right panel" would, with the panel open on that tab (at
 * `panelWidth`, when given). The full lists (search, filters, sort, groups, cards and their menus)
 * live there now: under the default placement the overview's Pull requests section has a compact
 * row for each instead. The placement is the window's own (local storage); the panel's state is
 * synced with the settings, so it is seeded in both. The seed lands once per tab, so whatever the
 * test changes afterwards survives its own navigations.
 */
export async function reviewsInPanel(
  page: Page,
  lists: { requests?: boolean; own?: boolean; panelWidth?: number } = {
    requests: true,
    own: true,
  },
): Promise<void> {
  await page.addInitScript((seed) => {
    if (sessionStorage.getItem("e2e.reviewsInPanel") !== null) return;
    sessionStorage.setItem("e2e.reviewsInPanel", "1");
    const width = seed.panelWidth === undefined ? {} : { width: seed.panelWidth };
    const stored = JSON.parse(localStorage.getItem("gram.layout") ?? "null") ?? {
      state: {},
      version: 1,
    };
    stored.state = {
      ...stored.state,
      panelOpen: true,
      panelTab: "reviews",
      ...(seed.panelWidth === undefined ? {} : { panelWidth: seed.panelWidth }),
      ...(seed.requests ? { reviewRequestsPlacement: "panel" } : {}),
      ...(seed.own ? { openPrsPlacement: "panel" } : {}),
    };
    localStorage.setItem("gram.layout", JSON.stringify(stored));
    const settings = JSON.parse(sessionStorage.getItem("gram.mock.settings") ?? "{}");
    settings.panel = { ...settings.panel, open: true, tab: "reviews", ...width };
    sessionStorage.setItem("gram.mock.settings", JSON.stringify(settings));
  }, lists);
}

/** The right panel's Reviews tab, opened. */
export async function openReviewsTab(page: Page) {
  const panel = page.getByTestId("right-panel");
  await panel.getByRole("tab", { name: /Reviews/ }).click();
  return panel;
}
