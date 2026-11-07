import { expect, type Locator } from "@playwright/test";

/**
 * Opens one of the right panel's tabs: from the strip, or from More, where a short strip folds its
 * tabs. Retried as a whole: while the panel changes width (opening, a review taking or giving back
 * room) a tab can move between the strip and More under the click.
 */
export async function openPanelTab(panel: Locator, name: string | RegExp): Promise<void> {
  const exact = typeof name === "string";
  const tab = panel.getByRole("tab", { name, exact });
  const more = panel.getByTestId("panel-more");
  const menu = panel.page().getByTestId("panel-more-menu");
  await expect(async () => {
    if ((await tab.count()) > 0) {
      // A More menu left open from a try before the tab came back would take the click.
      if (await menu.isVisible()) await panel.page().keyboard.press("Escape");
      await tab.click({ timeout: 2_000 });
    } else {
      if (!(await menu.isVisible())) await more.click({ timeout: 2_000 });
      await menu.getByRole("menuitem", { name, exact }).click({ timeout: 2_000 });
    }
    await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}
