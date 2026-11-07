import { expect, test, type Page } from "@playwright/test";

import { openPanelTab } from "./panel-tab";
import { reviewsInPanel } from "./reviews-panel";
import { openOrchestrator, threadRow } from "./thread-row";

// The panel's tabs show their names. Short of room for every one, tabs fold into More, named there:
// the rarer ones first, then Terminal, Files, PR and Diff from the strip's end, never the open tab
// or one with a count, so every tab left in the strip keeps its name. Only a panel too narrow for
// the open tab's name beside More falls back to icons. All of it is measured from the row rather
// than guessed from a breakpoint. Every state keeps each tab's accessible name and tooltip, and its
// count. On a review, Focus review sits beside the tabs in words, which go before any name does.

const open = async (page: Page, width: number, tab = "files") => {
  await page.addInitScript(
    ({ panelWidth, panelTab }) => {
      const key = "gram.mock.settings";
      const saved = JSON.parse(sessionStorage.getItem(key) ?? "{}") as Record<string, unknown>;
      saved.panel = {
        side: "right",
        open: true,
        width: panelWidth,
        tab: panelTab,
      };
      sessionStorage.setItem(key, JSON.stringify(saved));
    },
    { panelWidth: width, panelTab: tab },
  );
  await page.goto("/t/t-deps");
  const panel = page.getByTestId("right-panel");
  await expect(panel.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  return panel;
};

/** The tabs in the strip, by their `data-panel-tab`. */
const inStrip = (page: Page) =>
  page
    .getByTestId("right-panel")
    .locator("[data-panel-tab]")
    .evaluateAll((tabs) => tabs.map((tab) => (tab as HTMLElement).dataset.panelTab));

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

/** Every tab in the strip shows its name: none is a bare icon. */
const everyNameShows = async (page: Page) => {
  await expect
    .poll(async () => {
      const [shown, strip] = await Promise.all([named(page), inStrip(page)]);
      return shown.length > 0 && JSON.stringify(shown) === JSON.stringify(strip);
    })
    .toBe(true);
};

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
  // Nothing folded: every tab is in the strip.
  await expect(panel.getByTestId("panel-more")).toHaveCount(0);
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
  await expect(list).toHaveAttribute("data-label-fit", "all");
  await expect.poll(() => named(page)).toEqual(["diff", "pr", "files", "terminal"]);
  await everyNameShows(page);
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
  await everyNameShows(page);
  await expect(more).toBeVisible();
  await more.click();
  for (const name of ["Preview", "Docs", "Notifications"]) {
    await expect(menu.getByRole("menuitem", { name })).toBeVisible();
  }
  await expect(menu.getByRole("menuitem", { name: "Connectors" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(panel.getByRole("tab", { name: "Connectors", exact: true })).toHaveCount(1);
  expect(await overflows(page)).toBe(false);
});

test("at the default width every tab in the strip keeps its name, Terminal and Files folding first", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // The panel's default width.
  const panel = await open(page, 352);
  await expect(panel.locator("[data-label-fit]")).toHaveAttribute("data-label-fit", "all");
  await everyNameShows(page);
  const strip = await inStrip(page);
  expect(strip).toContain("files");
  expect(strip).toContain("diff");
  expect(await overflows(page)).toBe(false);
  // What folded is in More, named: Terminal went before Diff did.
  expect(strip).not.toContain("terminal");
  await openPanelTab(panel, "Terminal");
  await expect.poll(() => inStrip(page)).toContain("terminal");
  await everyNameShows(page);
  expect(await overflows(page)).toBe(false);
});

test("narrower still, the open tab keeps its name beside More, and it follows the open tab", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const panel = await open(page, 260);
  await expect(panel.locator("[data-label-fit]")).toHaveAttribute("data-label-fit", "all");
  await expect.poll(() => named(page)).toContain("files");
  await everyNameShows(page);
  expect(await overflows(page)).toBe(false);
  await openPanelTab(panel, "Diff");
  await expect.poll(() => named(page)).toContain("diff");
  await everyNameShows(page);
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

  // Narrower, tabs fold into More and those left keep their names, Diff's included, while Focus
  // review keeps its words.
  await page.setViewportSize({ width: 1180, height: 1000 });
  await expect.poll(() => named(page)).toContain("diff");
  await everyNameShows(page);
  await expect(focus).toBeVisible();
  await expect(panel.getByTestId("panel-more")).toBeVisible();
  expect(await overflows(page)).toBe(false);
});

test("the narrowest panel names its open tab beside More, and keeps every name on hover", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 900 });
  const narrow = await open(page, 240);
  await expect(narrow.locator("[data-label-fit]")).toHaveAttribute("data-label-fit", "all");
  await expect.poll(() => named(page)).toEqual(["files"]);
  expect(await overflows(page)).toBe(false);
  // The name is the tab's accessible name and its tooltip in this state too.
  const files = narrow.getByRole("tab", { name: "Files", exact: true });
  await files.hover();
  await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toHaveText("Files");
  // The rest are in More, each by its name.
  await narrow.getByTestId("panel-more").click();
  const menu = page.getByTestId("panel-more-menu");
  for (const name of ["Diff", "PR", "Terminal"]) {
    await expect(menu.getByRole("menuitem", { name, exact: true })).toBeVisible();
  }
  await page.keyboard.press("Escape");
});

test("the Workers tab beside an orchestrator keeps the strip's names at the default width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1728, height: 1000 });
  await page.addInitScript(() => {
    const key = "gram.mock.settings";
    const saved = JSON.parse(sessionStorage.getItem(key) ?? "{}") as Record<string, unknown>;
    saved.panel = { side: "right", open: true, width: 352, tab: "workers" };
    sessionStorage.setItem(key, JSON.stringify(saved));
  });
  await page.goto("/t/t-flaky");
  await threadRow(page, "t-flaky").waitFor();
  const made = await page.evaluate(() => window.gramMock!.simulateOrchestration("board"));
  await openOrchestrator(page, made.orchestratorThreadId);
  const panel = page.getByTestId("right-panel");
  await openPanelTab(panel, "Workers");
  await expect(panel.getByRole("tab", { name: "Workers", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(panel.locator("[data-label-fit]")).toHaveAttribute("data-label-fit", "all");
  await expect.poll(() => named(page)).toContain("workers");
  await everyNameShows(page);
  expect((await inStrip(page)).length).toBeGreaterThan(1);
  expect(await overflows(page)).toBe(false);
});

test("a tab that appears under a resting pointer opens no hint until the pointer moves", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  // Diff, first in the strip and not the open tab: reopening the panel focuses the open tab, and
  // focus opens a hint of its own.
  const panel = await open(page, 352);
  const diff = panel.getByRole("tab", { name: "Diff", exact: true });
  const box = (await diff.boundingBox())!;
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  // The tab's own hint: with the panel closed the spot is in the title bar, whose icons' hints a
  // move there may open on their own.
  const hint = page
    .locator('[data-slot="tooltip-content"][data-open]')
    .filter({ hasText: /^Diff$/ });
  // The pointer rests where the tab will be, the panel closed: no tab there to hover yet.
  await page.keyboard.press("ControlOrMeta+Alt+b");
  await expect(diff).toBeHidden();
  await page.mouse.move(at.x, at.y);
  // Still for a moment: a tab that came within a frame or two of a move would be the move's own.
  await page.waitForTimeout(250);
  // The panel opens under the still pointer: the browser says the pointer is over the tab, but
  // nobody pointed at it, so its hint stays shut rather than cover the row beside it.
  await page.keyboard.press("ControlOrMeta+Alt+b");
  await expect(diff).toBeVisible();
  await page.waitForTimeout(300);
  await expect(hint).toHaveCount(0);
  // Moving over it is pointing at it.
  await page.mouse.move(at.x + 2, at.y + 1);
  await expect(hint).toBeVisible();
});

test("the strip unfolds every tab when the panel widens again", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1000 });
  const panel = await open(page, 240);
  const more = panel.getByTestId("panel-more");
  await expect(more).toBeVisible();
  await panel.getByRole("button", { name: "Expand panel" }).click();
  await expect(more).toHaveCount(0);
  await everyNameShows(page);
  await panel.getByRole("button", { name: "Restore panel width" }).click();
  await expect(more).toBeVisible();
});

test("a tab with a count stays in a narrow strip, its count beside its icon", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await reviewsInPanel(page, { requests: true, panelWidth: 240 });
  await page.goto("/t/t-question");
  const panel = page.getByTestId("right-panel");
  const reviews = panel.getByRole("tab", {
    name: "Reviews, 2 waiting",
    exact: true,
  });
  await expect(reviews).toBeVisible();
  await expect(panel.getByTestId("reviews-tab-count")).toBeVisible();
  await expect(panel.getByTestId("reviews-tab-count")).toHaveText("2");
  expect(await overflows(page)).toBe(false);
});
