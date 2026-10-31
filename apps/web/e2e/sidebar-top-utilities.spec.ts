import { expect, test } from "@playwright/test";

import { openOverviewDensity } from "./overview-density";
import { seedTheme } from "./seed-theme";

// Preserve native middle-click/new-tab coverage using full Chromium. Its headless shell can
// strand background-tab initialization under load: https://github.com/microsoft/playwright/issues/42142
// `playwright install chromium` already installs this pinned binary alongside the shell.
test.use({ channel: "chromium" });

// The overview's header row, left to right: Hide sidebar, Usage and Settings (the top-left nav),
// Compact overview, and New at the far end.
const names = ["Hide sidebar", "Usage", "Settings", "Compact overview", "New"];

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
        expect(action.width).toBeGreaterThanOrEqual(24);
        expect(action.height).toBeGreaterThanOrEqual(24);
        expect(action.top).toBeGreaterThanOrEqual(0);
        expect(action.bottom).toBeLessThanOrEqual(geometry.headerHeight);
      }
      // In order and apart, even at the narrowest width.
      for (let i = 1; i < geometry.actions.length; i++) {
        expect(geometry.actions[i]!.left - geometry.actions[i - 1]!.right).toBeGreaterThanOrEqual(
          4,
        );
      }
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
  const usage = sidebar.getByRole("button", { name: "Usage", exact: true });
  const settings = sidebar.getByRole("button", { name: "Settings", exact: true });
  const hint = page.locator('[data-slot="tooltip-content"][data-open]');
  const before = await page.evaluate(async () => ({
    settings: await window.gramMock!.getSettings(),
    threads: window.gramMock!.world.threads().length,
    workspaces: (await window.gramMock!.listWorkspaces()).length,
  }));
  for (const label of ["Usage", "Settings"]) {
    await sidebar.getByRole("button", { name: label, exact: true }).hover();
    await expect(hint).toContainText(label);
    await page.mouse.move(1000, 1000);
  }
  // Tab walks the header in order, each action with a visible ring; Usage and Settings say what
  // they are at once, the others in their title.
  await sidebar.getByRole("button", { name: "Hide sidebar", exact: true }).focus();
  for (const label of names.slice(1)) {
    await page.keyboard.press("Tab");
    const action = sidebar.getByRole("button", { name: label, exact: true });
    await expect(action).toBeFocused();
    if (label === "Usage" || label === "Settings") await expect(hint).toContainText(label);
    else await expect(action).toHaveAttribute("title", new RegExp(`^${label}`));
    expect(await action.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe(
      "none",
    );
  }
  for (let i = 0; i < 2; i++) await page.keyboard.press("Shift+Tab");
  await expect(settings).toBeFocused();
  await expect(hint).toContainText("Settings");
  await page.keyboard.press("Escape");
  await expect(hint).toBeHidden();
  await page.keyboard.press("Shift+Tab");
  await expect(usage).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/usage$/);
  await expect(usage).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
  const popupPromise = context.waitForEvent("page");
  await usage.click({ button: "middle" });
  const popup = await popupPromise;
  await popup.waitForLoadState();
  await expect(popup).toHaveURL(/\/usage$/);
  await popup.close();
  await settings.click();
  await expect(page).toHaveURL(/\/settings\/general$/);
  await expect(settings).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("general-settings")).toBeVisible();
  const after = await page.evaluate(async () => ({
    settings: await window.gramMock!.getSettings(),
    threads: window.gramMock!.world.threads().length,
    workspaces: (await window.gramMock!.listWorkspaces()).length,
  }));
  expect(after).toEqual(before);
  // Hidden, the overview comes back from the title bar's Show sidebar, its header as it was.
  await sidebar.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  await expect(sidebar).toHaveCount(0);
  await page.getByTestId("overview-show").click();
  await expect(usage).toBeVisible();
  await expect(settings).toBeVisible();
});

test("empty sidebar keeps all five top actions reachable", async ({ page }) => {
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
  await sidebar.getByRole("button", { name: "Usage", exact: true }).click();
  await expect(page).toHaveURL(/\/usage$/);
});
