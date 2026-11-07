import { expect, test } from "@playwright/test";

import { showsFocus } from "./titlebar-menu";

import { openOverviewDensity } from "./overview-density";
import { seedTheme } from "./seed-theme";

// Preserve native middle-click/new-tab coverage using full Chromium. Its headless shell can
// strand background-tab initialization under load: https://github.com/microsoft/playwright/issues/42142
// `playwright install chromium` already installs this pinned binary alongside the shell.
test.use({ channel: "chromium" });

// The overview's header row, left to right: its own two toggles, Hide sidebar and Compact sidebar,
// drawn apart, and New task at the far end, its words beside the `+` where the header has room.
// Settings sits at the overview's foot, beside History. Usage has its one way in at the title
// bar's meter.
const names = ["Hide sidebar", "Compact sidebar", "New task"];

for (const mode of ["light", "dark"] as const) {
  for (const width of [180, 280, 380]) {
    test(`top utilities at ${width}px in ${mode}`, async ({ page }) => {
      await seedTheme(page, { palette: "minimal-ocean", mode, motion: "off" });
      await page.clock.setFixedTime(new Date("2026-06-15T08:00:00Z"));
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await openOverviewDensity(page, width);
      const sidebar = page.getByTestId("overview-sidebar");
      const geometry = await sidebar.evaluate((element, labels) => {
        const pane = element.getBoundingClientRect();
        const header = element.firstElementChild!;
        const actions = labels.map((label) => {
          const matches = element.querySelectorAll<HTMLElement>(`[aria-label="${label}"]`);
          const action = matches[0]!;
          const rect = action.getBoundingClientRect();
          return {
            label,
            count: matches.length,
            inHeader: header.contains(action),
            drag: getComputedStyle(action).getPropertyValue("-webkit-app-region"),
            left: rect.left - pane.left,
            right: rect.right - pane.left,
            top: rect.top - pane.top,
            bottom: rect.bottom - pane.top,
            width: rect.width,
            height: rect.height,
          };
        });
        return {
          width: pane.width,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          headerHeight: header.getBoundingClientRect().height,
          drag: getComputedStyle(header).getPropertyValue("-webkit-app-region"),
          actions,
        };
      }, names);
      await test.info().attach("top-utilities-geometry", {
        body: JSON.stringify(geometry, null, 2),
        contentType: "application/json",
      });
      await page.mouse.move(1000, 1000);
      await sidebar.screenshot({ path: test.info().outputPath(`${mode}-${width}.png`) });
      expect(geometry.width).toBe(width);
      // The header drags the window; each action in it takes its own clicks.
      expect(geometry.drag).toBe("drag");
      for (const action of geometry.actions) {
        expect(action.count, action.label).toBe(1);
        expect(action.inHeader, action.label).toBe(true);
        expect(action.drag, action.label).toBe("no-drag");
        expect(action.left).toBeGreaterThanOrEqual(0);
        expect(action.right).toBeLessThanOrEqual(width);
        // A 28 px target, each.
        expect(action.width).toBeGreaterThanOrEqual(28);
        expect(action.height).toBeGreaterThanOrEqual(28);
        expect(action.top).toBeGreaterThanOrEqual(0);
        expect(action.bottom).toBeLessThanOrEqual(geometry.headerHeight);
      }
      // In order and apart, even at the narrowest width.
      for (let i = 1; i < geometry.actions.length; i++) {
        expect(geometry.actions[i]!.left - geometry.actions[i - 1]!.right).toBeGreaterThanOrEqual(
          4,
        );
      }
      // New task says its words once the header has room for them beside its icons.
      const words = sidebar.getByTestId("new-entry-words");
      if (width < 280) await expect(words).toBeHidden();
      else await expect(words).toHaveText("New task");
      expect(errors).toEqual([]);
    });
  }
}

test("top navigation explains real keyboard focus and preserves routes and modifier clicks", async ({
  page,
  context,
}) => {
  await seedTheme(page, { palette: "minimal-ocean", mode: "dark", motion: "off" });
  await openOverviewDensity(page, 180);
  const sidebar = page.getByTestId("overview-sidebar");
  // Usage has one way in, the title bar's meter, and none in the sidebar's header.
  await expect(sidebar.getByRole("button", { name: "Usage", exact: true })).toHaveCount(0);
  const usage = page.getByTestId("usage-meter");
  const settings = sidebar.getByRole("button", { name: "Settings", exact: true });
  const hint = page.locator('[data-slot="tooltip-content"][data-open]');
  const before = await page.evaluate(async () => ({
    settings: await window.gramMock!.getSettings(),
    threads: window.gramMock!.world.threads().length,
    workspaces: (await window.gramMock!.listWorkspaces()).length,
  }));
  await settings.hover();
  await expect(hint).toContainText("Settings");
  await page.mouse.move(1000, 1000);
  // Tab walks the header in order, each action with a visible ring, saying what it is at once.
  await sidebar.getByRole("button", { name: "Hide sidebar", exact: true }).focus();
  for (const label of names.slice(1)) {
    await page.keyboard.press("Tab");
    const action = sidebar.getByRole("button", { name: label, exact: true });
    await expect(action).toBeFocused();
    await expect(hint).toHaveText(new RegExp(`^${label}`));
    expect(await showsFocus(action)).toBe(true);
  }
  // Settings is the foot's, after History: Tab reaches it from there, saying itself at once.
  await expect(settings).toHaveCount(1);
  await sidebar.getByTestId("overview-history").focus();
  await page.keyboard.press("Tab");
  await expect(settings).toBeFocused();
  await expect(hint).toContainText("Settings");
  expect(await showsFocus(settings)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(hint).toBeHidden();
  // The meter opens its popover, whose link goes on to the Usage page.
  await usage.click();
  const usagePage = page.getByTestId("usage-limits-page");
  await expect(usagePage).toBeVisible();
  const popupPromise = context.waitForEvent("page");
  await usagePage.click({ button: "middle" });
  const popup = await popupPromise;
  await popup.waitForLoadState();
  await expect(popup).toHaveURL(/\/settings\/usage$/);
  await popup.close();
  await usagePage.click();
  await expect(page).toHaveURL(/\/settings\/usage$/);
  await expect(page.getByRole("dialog", { name: "Subscription usage" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
  // Back to the overview; Settings then reopens on the page it was last on, Usage.
  await page.getByTestId("settings-back").click();
  await expect(sidebar).toBeVisible();
  await settings.click();
  await expect(page).toHaveURL(/\/settings\/usage$/);
  // Settings is a place of its own: the overview, its header with it, steps aside, and the title
  // bar has Back and the page's name.
  await expect(page.getByTestId("settings-title")).toHaveText("Settings");
  await expect(sidebar).toHaveCount(0);
  await expect(page.getByTestId("usage-settings")).toBeVisible();
  const after = await page.evaluate(async () => ({
    settings: await window.gramMock!.getSettings(),
    threads: window.gramMock!.world.threads().length,
    workspaces: (await window.gramMock!.listWorkspaces()).length,
  }));
  expect(after).toEqual(before);
  // Back leaves Settings for the overview as it was.
  await page.getByTestId("settings-back").click();
  await expect(sidebar).toBeVisible();
  // Hidden, the overview comes back from the title bar's Show sidebar, its header as it was.
  await sidebar.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  await expect(sidebar).toHaveCount(0);
  await page.getByTestId("overview-show").click();
  await expect(settings).toBeVisible();
});

test("empty sidebar keeps the top actions and Settings reachable", async ({ page }) => {
  await seedTheme(page, { palette: "minimal-ocean", mode: "light", motion: "off" });
  await openOverviewDensity(page, 180);
  await page.evaluate(async () => {
    const mock = window.gramMock!;
    for (const summary of mock.world.threads()) await mock.closeThread(summary.thread.id);
  });
  const sidebar = page.getByTestId("overview-sidebar");
  await expect(sidebar.getByTestId("overview-section-solo")).toHaveCount(0);
  for (const name of names)
    await expect(sidebar.getByRole("button", { name, exact: true })).toBeVisible();
  await sidebar.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/settings/);
});

// The header's icons each say what they do the moment they're hovered, and their key where they have
// one: a native title would wait a second before saying anything. New task also says its words where
// the header has room.
test("each top-left icon names itself and its key on hover", async ({ page }) => {
  await page.goto("/");
  const sidebar = page.getByTestId("overview-sidebar");
  await sidebar.waitFor();
  const tooltip = page.locator('[data-slot="tooltip-content"]');
  const expected: readonly [string, RegExp][] = [
    ["Hide sidebar", /^Hide sidebar \((⌘|Ctrl\+)B\)$/],
    ["Compact sidebar", /^Compact sidebar: workspaces as tiles$/],
    // Settings, at the foot beside History, says its key too.
    ["Settings", /^Settings \((⌘|Ctrl\+),\)/],
    // New opens a menu, whose Task, Team and Chat each show their own key.
    ["New task", /^New task, team or chat$/],
  ];
  for (const [name, label] of expected) {
    await sidebar.locator(`[aria-label="${name}"]`).first().hover();
    await expect(tooltip).toHaveText(label);
    await page.mouse.move(600, 600);
    await expect(tooltip).toHaveCount(0);
  }
});
