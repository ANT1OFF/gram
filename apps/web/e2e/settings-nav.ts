import type { Page } from "@playwright/test";

/** The Settings nav: the six groups. */
export const settingsNav = (page: Page) =>
  page.getByRole("navigation", { name: "Settings sections" });

/** Opens a page that sits under Settings → Advanced, such as Keyboard, through its row there. */
export async function openAdvancedPage(page: Page, label: string) {
  await settingsNav(page).getByRole("link", { name: "Advanced", exact: true }).click();
  await page.getByTestId("settings-subpages").getByRole("link", { name: label }).click();
}
