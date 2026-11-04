import type { Page } from "@playwright/test";

import { titlebarMore } from "./titlebar-menu";

/** A layout preset by its name in the picker, e.g. `"2×2"` or `"3 columns"`. */
export type LayoutName =
  | "1 pane"
  | "2 columns"
  | "3 columns"
  | "2×2"
  | "2 columns × 3 rows"
  | "3 columns × 2 rows";

/** The title bar's "…", whose Layout submenu holds the presets. */
export const layoutButton = titlebarMore;

/** The layout presets in the title bar's open Layout submenu. */
export const layoutPresets = (page: Page) =>
  page.getByTestId("folded-layout").getByRole("menuitemradio");

/** Opens the title bar's "…" and its Layout submenu. */
export async function openLayout(page: Page): Promise<void> {
  await layoutButton(page).click();
  await page.getByTestId("menu-layout").click();
  await page.getByTestId("folded-layout").waitFor();
}

/** Picks `name` from the title bar's Layout: opens it, then takes the preset, which closes it. */
export async function setLayout(page: Page, name: LayoutName): Promise<void> {
  await openLayout(page);
  await page.getByTestId("folded-layout").getByRole("menuitemradio", { name, exact: true }).click();
}
