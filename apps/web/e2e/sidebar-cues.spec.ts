import { expect, test } from "@playwright/test";
import { threadRow } from "./thread-row";

test("a row says its status, the opened thread its label and fork, and a bookmark lands in /new", async ({
  page,
}) => {
  // Open no thread: a playing script changes statuses under the clicks.
  await page.goto("/");

  // The overview's row says the status in words as well as its dot, and at work its last activity,
  // which has left the row for its hover and name.
  const docs = threadRow(page, "t-docs");
  await expect(docs).toHaveAccessibleName(/, Running, Last activity \d{2}:\d{2}$/);

  // Opened, the pane header names the label, untinted, and where it was forked from.
  await docs.click();
  await expect(page).toHaveURL(/\/t\/t-docs$/);
  await expect(page.getByTestId("pane-label")).toContainText("urgent");
  await expect(page.getByTestId("pane-header")).not.toHaveAttribute("style", /label-tint/);
  await expect(page.getByTestId("pane-header").getByTestId("forked-from")).toHaveText(
    "Forked from Fix flaky retry test",
  );

  // A project bookmarked in /new's folder menu is listed there under Bookmarks, and no longer
  // under Recent.
  await page.keyboard.press("ControlOrMeta+KeyT");
  await page.getByRole("button", { name: "Folder", exact: true }).click();
  const menu = page.getByTestId("where-folder-menu");
  const recent = menu.getByRole("region", { name: "Recent" });
  const bookmarks = menu.getByRole("region", { name: "Bookmarks" });
  await recent.getByRole("button", { name: "Bookmark docs" }).click();
  await expect(
    bookmarks.getByRole("button", { name: "Remove bookmark from docs" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(bookmarks.getByRole("button", { name: /^docs/ })).toBeVisible();
  await expect(recent.getByRole("button", { name: /^docs/ })).toHaveCount(0);
});
