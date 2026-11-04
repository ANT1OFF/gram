import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The thread's ⋯ menu, then its More…: ⌘K on the thread's own commands. A pane in a grid has the
 * menu in its header; the thread alone in the window has it in the title bar's one "…".
 */
export async function openHeaderMore(page: Page): Promise<Locator> {
  const palette = page.getByTestId("command-palette");
  await expect(palette).toBeHidden();
  await (await openThreadMenu(page)).getByRole("menuitem", { name: "More…" }).click();
  await expect(palette.getByTestId("palette-scope")).toBeVisible();
  return palette;
}

/**
 * Opens the thread's menu, resolving with what holds its items: a grid pane's header menu, or the
 * thread's group in the title bar's "…" for the thread alone in the window.
 */
export async function openThreadMenu(page: Page): Promise<Locator> {
  const paneMenu = page.getByTestId("pane").getByRole("button", { name: "Thread menu" });
  if ((await paneMenu.count()) > 0) {
    await paneMenu.first().click();
    const menu = page.getByTestId("thread-menu");
    await expect(menu).toBeVisible();
    return menu;
  }
  await page.getByTestId("shell-titlebar").getByTestId("titlebar-overflow").click();
  const group = page.getByTestId("titlebar-menu-thread");
  await expect(group).toBeVisible();
  return group;
}

/**
 * A row's More…: the last item of its context menu, which opens ⌘K on that thread's or workspace's
 * own commands. Resolves with the palette, its scope showing.
 */
export async function openMore(page: Page, row: Locator): Promise<Locator> {
  const palette = page.getByTestId("command-palette");
  // A palette still closing gives focus back as it goes, which would close the menu opened now.
  await expect(palette).toBeHidden();
  // A live row can move to another group, and remount, while its menu opens (the mock's t-flaky
  // does, about a second after another thread is opened, on main too); the menu goes with it, so
  // the right-click is made again on the row where it now is.
  let attempt = 0;
  await expect(async () => {
    // A menu left open by the last attempt closes before the next right-click.
    if (attempt++ > 0) await page.keyboard.press("Escape");
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "More…" }).click({ timeout: 2_000 });
  }).toPass();
  await expect(palette.getByTestId("palette-scope")).toBeVisible();
  return palette;
}
