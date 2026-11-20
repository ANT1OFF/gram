import { expect, test, type Page } from "@playwright/test";

// The shell's layout options: where the main navigation sits (`layout.navigation.position`) and
// whether it hides when not in use (`autoHide`), and the person's own pick in Appearance.

const mounted = async (page: Page, path = "/") => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(path);
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-embed-shell", "on");
  return errors;
};

const box = async (page: Page, testId: string) => {
  const found = await page.getByTestId(testId).first().boundingBox();
  if (found === null) throw new Error(`${testId} has no box`);
  return found;
};

test("without a layout the navigation is the sidebar, as before", async ({ page }) => {
  const errors = await mounted(page);
  await expect(page.getByTestId("overview-sidebar")).toBeVisible();
  await expect(page.getByTestId("nav-dock")).toHaveCount(0);
  await expect(page.getByTestId("nav-auto-hide")).toHaveCount(0);
  await expect(page.getByTestId("nav-edge")).toHaveCount(0);
  await expect(page.getByTestId("nav-docked")).toHaveCount(0);
  const shell = page.getByTestId("app-shell");
  await expect(shell).not.toHaveAttribute("data-nav", /.*/);
  await expect(shell).not.toHaveAttribute("data-nav-auto-hide", /.*/);
  const sidebar = await box(page, "overview-sidebar");
  expect(sidebar.x).toBe(0);
  expect(sidebar.width).toBeGreaterThan(150);
  // ⌘B still hides and shows the sidebar itself.
  await page.keyboard.press("ControlOrMeta+b");
  await expect(page.getByTestId("overview-sidebar")).toHaveCount(0);
  await expect(page.getByTestId("overview-show")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+b");
  await expect(page.getByTestId("overview-sidebar")).toBeVisible();
  // Appearance shows Gram's own as picked.
  await page.goto("/settings/appearance");
  const settings = page.getByTestId("navigation-settings");
  await expect(settings.getByRole("button", { name: "side" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(settings.getByRole("button", { name: "off" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(errors).toEqual([]);
});

test("a dock at the bottom carries the places as icons with short labels", async ({ page }) => {
  const errors = await mounted(page, "/?nav=dock-bottom");
  const dock = page.getByTestId("nav-dock");
  await expect(dock).toBeVisible();
  await expect(dock).toHaveAttribute("data-edge", "bottom");
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-nav", "dock");
  await expect(page.getByTestId("overview-sidebar")).toHaveCount(0);
  // The title bar leaves Show sidebar and Settings to the dock.
  await expect(page.getByTestId("overview-show")).toHaveCount(0);
  await expect(page.getByTestId("top-left-nav")).toHaveCount(0);
  for (const label of ["Needs you", "Search", "History", "Settings"])
    await expect(dock.getByText(label, { exact: true })).toBeVisible();
  await expect(dock.getByTestId("nav-dock-overview")).toHaveText("Overview");
  // The embedding app's places, each its icon over its label.
  expect(await dock.getByTestId("nav-dock-place").count()).toBeGreaterThan(0);
  const viewport = page.viewportSize()!;
  const bar = await box(page, "nav-dock");
  expect(bar.y + bar.height).toBeGreaterThan(viewport.height - 16);
  expect(Math.abs(bar.x + bar.width / 2 - viewport.width / 2)).toBeLessThan(4);
  // The page ends above the dock, which covers none of it.
  const shell = await box(page, "app-shell");
  expect(shell.y + shell.height).toBeLessThanOrEqual(bar.y);

  // Overview opens the sidebar over the page, and Escape gives the focus back.
  const overview = page.getByTestId("nav-dock-overview");
  await overview.focus();
  await page.keyboard.press("Enter");
  await expect(overview).toHaveAttribute("aria-expanded", "true");
  const sheet = page.getByTestId("nav-dock-sheet");
  await expect(sheet.getByTestId("overview-sidebar")).toBeVisible();
  await sheet.getByTestId("overview-search").focus();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(overview).toBeFocused();
  // ⌘B opens and closes it too.
  await page.keyboard.press("ControlOrMeta+b");
  await expect(sheet).toBeVisible();
  await sheet.getByTestId("overview-close").click();
  await expect(sheet).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a dock at the top sits above the page, and arrow keys move along it", async ({ page }) => {
  const errors = await mounted(page, "/?nav=dock-top");
  const dock = page.getByTestId("nav-dock");
  await expect(dock).toHaveAttribute("data-edge", "top");
  const bar = await box(page, "nav-dock");
  expect(bar.y).toBeLessThan(16);
  const shell = await box(page, "app-shell");
  expect(shell.y).toBeGreaterThanOrEqual(bar.y + bar.height);
  // Focus sidebar lands on the dock's current place.
  await page.keyboard.press("ControlOrMeta+Alt+s");
  await expect(dock.locator('[data-dock-item][aria-current="page"]')).toBeFocused();
  const items = dock.locator("[data-dock-item]");
  await items.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(items.last()).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(items.first()).toBeFocused();
  expect(errors).toEqual([]);
});

test("an auto-hidden sidebar comes back at its edge, and goes again", async ({ page }) => {
  await mounted(page);
  await page.mouse.move(400, 300);
  const errors = await mounted(page, "/?auto-hide");
  const held = page.getByTestId("nav-auto-hide");
  await expect(held).toHaveAttribute("data-edge", "left");
  await expect(held).not.toHaveAttribute("data-shown", /.*/);
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-nav-auto-hide", "");
  // Out of view, but still there for a screen reader and the keyboard.
  const sidebar = page.getByTestId("overview-sidebar");
  await expect(sidebar).toHaveCount(1);
  await expect(page.getByRole("complementary", { name: "Overview" })).toHaveCount(1);
  await expect.poll(async () => (await box(page, "overview-sidebar")).x).toBeLessThan(-100);
  // The page takes the sidebar's column.
  expect((await box(page, "shell-titlebar")).x).toBe(0);

  const viewport = page.viewportSize()!;
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  await page.mouse.move(2, viewport.height / 2, { steps: 4 });
  await expect(held).toHaveAttribute("data-shown", "");
  await expect.poll(async () => (await box(page, "overview-sidebar")).x).toBe(0);
  // Moving onto it keeps it; leaving it for the page lets it go.
  await page.mouse.move(60, viewport.height / 2, { steps: 4 });
  await page.waitForTimeout(600);
  await expect(held).toHaveAttribute("data-shown", "");
  await page.mouse.move(viewport.width / 2, viewport.height / 2, { steps: 4 });
  await expect(held).not.toHaveAttribute("data-shown", /.*/);

  // ⌘B shows it and hides it.
  await page.keyboard.press("ControlOrMeta+b");
  await expect(held).toHaveAttribute("data-shown", "");
  await page.keyboard.press("ControlOrMeta+b");
  await expect(held).not.toHaveAttribute("data-shown", /.*/);
  // The title bar has no Show sidebar: the sidebar is there, out of view.
  await expect(page.getByTestId("overview-show")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("an auto-hidden dock follows the keyboard's focus in and out", async ({ page }) => {
  const errors = await mounted(page, "/?nav=dock-bottom&auto-hide");
  const held = page.getByTestId("nav-auto-hide");
  await expect(held).toHaveAttribute("data-edge", "bottom");
  await expect(held).not.toHaveAttribute("data-shown", /.*/);
  await expect(page.getByTestId("nav-docked")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Navigation" })).toHaveCount(1);
  const viewport = page.viewportSize()!;
  await expect.poll(async () => (await box(page, "nav-dock")).y).toBeGreaterThan(viewport.height);

  // Focus sidebar moves into it, which brings it into view; Escape hides it and leaves the focus
  // on the page.
  await page.keyboard.press("ControlOrMeta+Alt+s");
  await expect(held).toHaveAttribute("data-shown", "");
  await expect(page.locator('[data-dock-item][aria-current="page"]')).toBeFocused();
  await expect
    .poll(async () => {
      const bar = await box(page, "nav-dock");
      return bar.y + bar.height;
    })
    .toBeLessThanOrEqual(viewport.height);
  await page.keyboard.press("Escape");
  await expect(held).not.toHaveAttribute("data-shown", /.*/);
  await expect(page.locator("#content")).toBeFocused();

  // Tab reaches it from the page, and Tab past its end lets it go.
  await page.keyboard.press("ControlOrMeta+Alt+s");
  await expect(held).toHaveAttribute("data-shown", "");
  await page.locator("[data-dock-item]").last().focus();
  await page.keyboard.press("Tab");
  await expect(held).not.toHaveAttribute("data-shown", /.*/);
  await page.keyboard.press("Shift+Tab");
  await expect(held).toHaveAttribute("data-shown", "");

  // The pointer at the bottom edge brings it back too.
  await page.keyboard.press("Escape");
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  await page.mouse.move(viewport.width / 2, viewport.height - 2, { steps: 4 });
  await expect(held).toHaveAttribute("data-shown", "");
  expect(errors).toEqual([]);
});

test("a person's pick in Appearance wins over the embedding app's default", async ({ page }) => {
  const errors = await mounted(page, "/settings/appearance?nav=dock-bottom");
  const settings = page.getByTestId("navigation-settings");
  await expect(settings.getByRole("button", { name: "bottom" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByTestId("nav-dock")).toBeVisible();
  await settings.getByRole("button", { name: "side" }).click();
  await expect(page.getByTestId("nav-dock")).toHaveCount(0);
  await settings.getByRole("button", { name: "on" }).click();
  await page.goto("/?nav=dock-bottom");
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.getByTestId("nav-dock")).toHaveCount(0);
  await expect(page.getByTestId("nav-auto-hide")).toHaveAttribute("data-edge", "left");
  await page.evaluate(() => localStorage.removeItem("gram.navigation"));
  expect(errors).toEqual([]);
});

test("the switcher can be kept to the title bar, out of the navigation", async ({ page }) => {
  const errors = await mounted(page);
  await expect(page.getByTestId("overview-sidebar").getByTestId("embed-switcher")).toHaveCount(1);
  await expect(page.getByTestId("shell-titlebar").getByTestId("embed-switcher")).toHaveCount(0);

  errors.push(...(await mounted(page, "/?switcher-titlebar")));
  await expect(page.getByTestId("overview-sidebar")).toBeVisible();
  await expect(page.getByTestId("overview-sidebar").getByTestId("embed-switcher")).toHaveCount(0);
  const inBar = page.getByTestId("shell-titlebar").getByTestId("embed-switcher");
  await expect(inBar).toHaveAttribute("data-placement", "titlebar");
  await expect(inBar.getByTestId("fixture-switcher")).toBeVisible();

  errors.push(...(await mounted(page, "/?switcher-titlebar&nav=dock-bottom")));
  await expect(page.getByTestId("embed-switcher")).toHaveCount(1);
  await expect(page.getByTestId("shell-titlebar").getByTestId("embed-switcher")).toHaveCount(1);
  expect(errors).toEqual([]);
});
