import type { Page } from "@playwright/test";

/** A layout preset by its name in the picker, e.g. `"2×2"` or `"3 columns"`. */
export type LayoutName =
  | "1 pane"
  | "2 columns"
  | "3 columns"
  | "2×2"
  | "2 columns × 3 rows"
  | "3 columns × 2 rows";

/** The title bar's one layout button, named for the current preset ("Layout: 2×2"). */
export const layoutButton = (page: Page) => page.getByRole("button", { name: /^Layout: / });

/** Picks `name` from the title bar's layout picker: opens it, then takes the preset, which closes it. */
export async function setLayout(page: Page, name: LayoutName): Promise<void> {
  await layoutButton(page).click();
  await page
    .getByRole("radiogroup", { name: "Layout" })
    .getByRole("radio", { name, exact: true })
    .click();
}
