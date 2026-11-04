import { expect, type Locator, type Page } from "@playwright/test";

/** The title bar's one "…": the carried thread's menu, the workspace's controls and the window's. */
export const titlebarMore = (page: Page) =>
  page.getByTestId("shell-titlebar").getByTestId("titlebar-overflow");

/** Opens the title bar's "…" and resolves with its menu. */
export async function openTitlebarMenu(page: Page): Promise<Locator> {
  const menu = page.getByTestId("titlebar-overflow-menu");
  await titlebarMore(page).click();
  await expect(menu).toBeVisible();
  return menu;
}

/** A submenu of the title bar's "…": the thread's, the workspace's or the window's (View). */
export type BarSubmenu = "thread" | "workspace" | "view";

/** Opens the title bar's "…" and its `name` submenu, resolving with the submenu. */
export async function openBarSubmenu(page: Page, name: BarSubmenu): Promise<Locator> {
  const menu = await openTitlebarMenu(page);
  await menu.getByTestId(`menu-${name}`).click();
  const submenu = page.getByTestId(`titlebar-menu-${name}`);
  await expect(submenu).toBeVisible();
  return submenu;
}

/**
 * The thread's Contents: a pane in a grid has its header's button; the thread alone in the window
 * has it under View in the title bar's "…". Resolves with the open list.
 */
export async function openContents(page: Page): Promise<Locator> {
  const toc = page.getByTestId("toc");
  const button = page.getByTestId("pane").getByRole("button", { name: "Contents", exact: true });
  if ((await button.count()) > 0) {
    await button.first().click();
  } else {
    const view = await openBarSubmenu(page, "view");
    await view.getByTestId("menu-contents").click();
  }
  await expect(toc).toBeVisible();
  return toc;
}

/**
 * Where focus goes back to once Contents closes: a grid pane's own Contents button, or the title
 * bar's "…" that holds it for the thread alone in the window.
 */
export async function contentsTrigger(page: Page): Promise<Locator> {
  const button = page.getByTestId("pane").getByRole("button", { name: "Contents", exact: true });
  return (await button.count()) > 0 ? button.first() : titlebarMore(page);
}

/** Closes an open Contents with Escape, and the title bar's menus around it if they stay open. */
export async function closeContents(page: Page): Promise<void> {
  const toc = page.getByTestId("toc");
  await toc.press("Escape");
  await expect(toc).toBeHidden();
  const root = page.getByTestId("titlebar-overflow-menu");
  for (let i = 0; i < 2 && (await root.isVisible()); i++) await page.keyboard.press("Escape");
  await expect(root).toBeHidden();
}
