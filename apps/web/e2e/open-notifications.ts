import { expect, type Page } from "@playwright/test";

// Notification history, as a user reaches it: the title bar's Inbox, then its Notifications link,
// which opens the history in the side panel.

export async function openNotifications(page: Page): Promise<void> {
  await page.getByTestId("inbox-button").click();
  await expect(page.getByTestId("inbox")).toBeVisible();
  await page.getByTestId("inbox-notifications").click();
  await expect(page.getByTestId("inbox")).toBeHidden();
  await expect(page.getByRole("region", { name: "Notification history" })).toBeVisible();
}
