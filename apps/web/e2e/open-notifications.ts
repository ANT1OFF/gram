import { expect, type Page } from "@playwright/test";

// Notification history, as a user reaches it: the Inbox, then its Notifications link, which opens
// the history in the side panel.

/**
 * The window's one way into the Inbox on screen: the open sidebar's pill, the compact rail's, or
 * with no sidebar the title bar's Inbox button.
 */
export const inboxEntry = (page: Page) =>
  page
    .locator(
      '[data-testid="overview-needs-you"]:visible, [data-testid="overview-rail-needs-you"]:visible, [data-testid="inbox-button"]:visible',
    )
    .first();

export async function openNotifications(page: Page): Promise<void> {
  await inboxEntry(page).click();
  await expect(page.getByTestId("inbox")).toBeVisible();
  await page.getByTestId("inbox-notifications").click();
  await expect(page.getByTestId("inbox")).toBeHidden();
  await expect(page.getByRole("region", { name: "Notification history" })).toBeVisible();
  // The panel opens its tab strip where the Inbox's link was: a pointer left resting there hovers
  // the Notifications tab, whose tooltip then covers the history's first row. Move it off, as a
  // hand does after the click.
  await page.mouse.move(0, 0);
}
