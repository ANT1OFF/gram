import { expect, type Locator } from "@playwright/test";

/**
 * Opens one of the right panel's tabs: from the strip, or from More, where a short strip folds its
 * rarer tabs.
 */
export async function openPanelTab(panel: Locator, name: string | RegExp): Promise<void> {
  const tab = panel.getByRole("tab", { name, exact: typeof name === "string" });
  const more = panel.getByTestId("panel-more");
  await expect(tab.or(more).first()).toBeVisible();
  if ((await tab.count()) > 0) {
    await tab.click();
    return;
  }
  await more.click();
  await panel
    .page()
    .getByTestId("panel-more-menu")
    .getByRole("menuitem", { name, exact: typeof name === "string" })
    .click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}
