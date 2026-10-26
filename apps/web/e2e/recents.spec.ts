import { expect, test } from "@playwright/test";

test("refuses to remove a project with threads from recents, then removes it once they're closed", async ({
  page,
}) => {
  await page.goto("/new");
  const recent = page.getByRole("region", { name: "Recent" });
  const removeDocs = recent.getByRole("button", { name: "Remove docs from recents" });

  await removeDocs.click();
  const error = page.getByTestId("thread-action-error");
  await expect(error).toContainText(
    "Couldn't remove docs from recents: Close the threads in docs before removing it from recents.",
  );
  await page.keyboard.press("Escape");
  await expect(error).toBeHidden();
  await expect(removeDocs).toBeVisible();

  await page.evaluate(() => window.gramMock?.closeThread("t-docs" as never));
  await removeDocs.click();
  await expect(removeDocs).toHaveCount(0);
  // api is bookmarked, so it is listed under Bookmarks rather than here as well.
  await expect(recent.getByRole("button", { name: "Remove api from recents" })).toHaveCount(0);
  await expect(recent.getByRole("button", { name: "Remove web from recents" })).toBeVisible();
});
