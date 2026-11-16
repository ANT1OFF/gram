import { expect, test } from "@playwright/test";

test("⌘\\ splits the thread in two panes, and closing one goes back to one", async ({ page }) => {
  await page.goto("/t/t-deps");
  const views = page.getByTestId("thread-view");
  await expect(views).toHaveCount(1);

  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(views).toHaveCount(2);
  const panes = page.getByTestId("pane");
  await expect(panes.nth(0)).toHaveAttribute("data-focused", "true");
  await expect(panes.nth(1)).toHaveAttribute("data-focused", "false");

  // Independent sends per pane are grid.spec.ts's.
  await panes.nth(1).getByRole("button", { name: "Close pane" }).click();
  await expect(views).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(panes).toHaveCount(1);
});
