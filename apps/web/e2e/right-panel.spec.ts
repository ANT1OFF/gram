import { expect, test, type Page } from "@playwright/test";

import { reviewsInPanel } from "./reviews-panel";

// The panel's tabs show their names while the strip has room for every one. Short of that the rarer
// tabs fold into More, named there, and Diff, PR, Files, Terminal and the open tab keep their
// names; then only the open tab's; then icons alone. All of it is measured from the row rather
// than guessed from a breakpoint. Every state keeps each tab's accessible name and tooltip, and its
// count. On a review, Focus review sits beside the tabs in words that fold to its icon last.

const open = async (page: Page, width: number) => {
  await page.addInitScript((panelWidth) => {
    const key = "gram.mock.settings";
    const saved = JSON.parse(sessionStorage.getItem(key) ?? "{}") as Record<string, unknown>;
    saved.panel = {
      side: "right",
      open: true,
      width: panelWidth,
      tab: "files",
    };
    sessionStorage.setItem(key, JSON.stringify(saved));
  }, width);
  await page.goto("/t/t-deps");
  const panel = page.getByTestId("right-panel");
  await expect(panel.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  return panel;
};

/** The tabs whose names show, by their `data-panel-tab`. */
const named = (page: Page) =>
  page
    .getByTestId("right-panel")
    .locator("[data-panel-tab]")
    .evaluateAll((tabs) =>
      tabs
        .filter((tab) => (tab.querySelector("[data-tab-label]")?.clientWidth ?? 0) > 0)
        .map((tab) => (tab as HTMLElement).dataset.panelTab),
    );

/** The strip's content overruns its box. */
const overflows = (page: Page) =>
  page
    .getByTestId("right-panel")
    .locator("[data-label-fit]")
    .evaluate((list) => list.scrollWidth > list.clientWidth);

test("a wide panel names every tab, and the open one stands on a background and an underline", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1000 });
  const panel = await open(page, 640);
  await panel.getByRole("button", { name: "Expand panel" }).click();
  const list = panel.locator("[data-label-fit]");
  await expect(list).toHaveAttribute("data-label-fit", "all");
  const tabs = await panel.locator("[data-panel-tab]").count();
  await expect.poll(() => named(page).then((n) => n.length)).toBe(tabs);
  await expect(panel.getByRole("tab", { name: "Files", exact: true })).toContainText("Files");
  expect(await overflows(page)).toBe(false);

  const files = panel.getByRole("tab", { name: "Files", exact: true });
  const diff = panel.getByRole("tab", { name: "Diff", exact: true });
  const look = (tab: typeof files) =>
    tab.evaluate((el) => ({
      background: getComputedStyle(el).backgroundColor,
      underline: getComputedStyle(el, "::after").backgroundColor,
    }));
  const active = await look(files);
  const idle = await look(diff);
  expect(active.background).not.toBe(idle.background);
  expect(active.underline).not.toBe(idle.underline);
  expect(idle.underline).toBe("rgba(0, 0, 0, 0)");
});

test("a narrower panel names Diff, PR, Files and Terminal, the rest named in More", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const panel = await open(page, 520);
  const list = panel.locator("[data-label-fit]");
  await expect(list).toHaveAttribute("data-label-fit", "primary");
  await expect.poll(() => named(page)).toEqual(["diff", "pr", "files", "terminal"]);
  expect(await overflows(page)).toBe(false);

  // More holds the rest, each by its name; a pick opens it in the strip, named, and More keeps
  // the others.
  const more = panel.getByRole("button", { name: "More tabs" });
  await expect(more).toContainText("More");
  await more.click();
  const menu = page.getByTestId("panel-more-menu");
  await expect(menu.getByRole("menuitem", { name: "Notifications" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Connectors" }).click();
  const connectors = panel.getByRole("tab", { name: "Connectors", exact: true });
  await expect(connectors).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => named(page)).toContain("connectors");
  await more.click();
  await expect(menu.getByRole("menuitem", { name: "Connectors" })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "Notifications" })).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await overflows(page)).toBe(false);
});

test("narrower still, only the open tab keeps its name, and it follows the open tab", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const panel = await open(page, 340);
  const list = panel.locator("[data-label-fit]");
  await expect(list).toHaveAttribute("data-label-fit", "active");
  await expect.poll(() => named(page)).toEqual(["files"]);
  expect(await overflows(page)).toBe(false);
  await panel.getByRole("tab", { name: "Terminal", exact: true }).click();
  await expect.poll(() => named(page)).toEqual(["terminal"]);
  expect(await overflows(page)).toBe(false);
});

test("a review at its ordinary width names Diff, PR, Files and Terminal, with Focus review in words beside them", async ({
  page,
}) => {
  // 1728 px leaves the review its widest beside an 800 px chat: 680 px.
  await page.setViewportSize({ width: 1728, height: 1000 });
  await page.goto("/t/t-flaky");
  const panel = page.getByTestId("right-panel");
  await expect(panel.getByRole("tab", { name: "Diff", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect.poll(async () => Math.round((await panel.boundingBox())?.width ?? 0)).toBe(680);
  await expect
    .poll(() => named(page))
    .toEqual(expect.arrayContaining(["diff", "pr", "files", "terminal"]));
  const focus = panel.getByRole("button", { name: "Focus review", exact: true });
  await expect(focus).toHaveAttribute("data-words", "true");
  await expect(focus).toContainText("Focus review");
  expect(await overflows(page)).toBe(false);
  // Beside the strip and its More, not across the row from them.
  const before = panel.getByTestId("panel-more");
  await expect(before).toBeVisible();
  const gap = await focus.evaluate(
    (button, more) => button.getBoundingClientRect().left - more!.getBoundingClientRect().right,
    await before.elementHandle(),
  );
  expect(gap).toBeLessThan(24);

  // Too narrow for its words, it keeps its icon and its name.
  await page.setViewportSize({ width: 1180, height: 1000 });
  await expect(focus).toHaveAttribute("data-words", "false");
  await expect(focus).toBeVisible();
  expect(await overflows(page)).toBe(false);
});

test("a narrow panel names no tab, and keeps every name on hover", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  const narrow = await open(page, 240);
  await expect(narrow.locator("[data-label-fit]")).toHaveAttribute("data-label-fit", "none");
  await expect.poll(() => named(page)).toEqual([]);
  // The name is the tab's accessible name and its tooltip in this state too.
  const diff = narrow.getByRole("tab", { name: "Diff", exact: true });
  await expect(diff).toBeVisible();
  await diff.hover();
  await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toHaveText("Diff");
});

test("the strip goes back to every name when the panel widens again", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1000 });
  const panel = await open(page, 240);
  const list = panel.locator("[data-label-fit]");
  await expect(list).not.toHaveAttribute("data-label-fit", "all");
  await panel.getByRole("button", { name: "Expand panel" }).click();
  await expect(list).toHaveAttribute("data-label-fit", "all");
  await panel.getByRole("button", { name: "Restore panel width" }).click();
  await expect(list).not.toHaveAttribute("data-label-fit", "all");
});

test("a count stays beside its icon when no tab is named", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await reviewsInPanel(page, { requests: true, panelWidth: 240 });
  await page.goto("/t/t-question");
  const panel = page.getByTestId("right-panel");
  await expect(panel.locator("[data-label-fit]")).toHaveAttribute("data-label-fit", "none");
  const reviews = panel.getByRole("tab", {
    name: "Reviews, 2 waiting",
    exact: true,
  });
  await expect(reviews).toBeVisible();
  await expect(panel.getByTestId("reviews-tab-count")).toBeVisible();
  await expect(panel.getByTestId("reviews-tab-count")).toHaveText("2");
});
