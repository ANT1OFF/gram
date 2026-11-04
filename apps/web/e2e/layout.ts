import type { Page } from "@playwright/test";

/** A layout preset by its name in the picker, e.g. `"2×2"` or `"3 columns"`. */
export type LayoutName =
  | "1 pane"
  | "2 columns"
  | "3 columns"
  | "2×2"
  | "2 columns × 3 rows"
  | "3 columns × 2 rows";

/** The title bar's "…", which holds the layout presets. */
export const layoutButton = (page: Page) =>
  page.getByTestId("shell-titlebar").getByRole("button", { name: "More window controls" });

/** The layout presets in the title bar's open "…". */
export const layoutPresets = (page: Page) =>
  page.getByTestId("folded-layout").getByRole("menuitemradio");

/** Picks `name` from the title bar's "…": opens it, then takes the preset, which closes it. */
export async function setLayout(page: Page, name: LayoutName): Promise<void> {
  await layoutButton(page).click();
  await page.getByTestId("folded-layout").getByRole("menuitemradio", { name, exact: true }).click();
}
