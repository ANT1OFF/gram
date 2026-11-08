import type { Page } from "@playwright/test";

/** The Settings nav: the groups. */
export const settingsNav = (page: Page) =>
  page.getByRole("navigation", { name: "Settings sections" });

/** The group each page that opens from one sits in, by the page's label. */
const GROUP_OF: Readonly<Record<string, string>> = {
  "AI helpers": "Agents & models",
  Connectors: "Agents & models",
  Gateways: "Agents & models",
  Routines: "Workspaces & merging",
  "Review bots": "Workspaces & merging",
  Storage: "Workspaces & merging",
  "Phones and browsers": "Machines",
  Terminal: "Appearance",
  Diagnostics: "About",
  "What's New": "About",
};

/**
 * Opens a Settings page the way a person would: its group in the nav, then, for a page within a
 * group such as Gateways, its row at the end of the group's page.
 */
export async function openSettingsPage(page: Page, label: string) {
  const group = GROUP_OF[label];
  await settingsNav(page)
    .getByRole("link", { name: group ?? label, exact: true })
    .click();
  if (group === undefined) return;
  await page
    .getByTestId("settings-subpages")
    .getByRole("link", { name: new RegExp(`^${label}`) })
    .click();
}
