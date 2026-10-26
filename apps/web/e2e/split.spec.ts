import { expect, test } from "@playwright/test";

test("split shows two threads that send independently", async ({ page }) => {
  await page.goto("/t/t-deps");
  const views = page.getByTestId("thread-view");
  await expect(views).toHaveCount(1);

  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(views).toHaveCount(2);
  const panes = page.getByTestId("pane");
  await expect(panes.nth(0)).toHaveAttribute("data-focused", "true");
  await expect(panes.nth(1)).toHaveAttribute("data-focused", "false");

  const first = panes.nth(0).getByLabel("Message", { exact: true });
  await first.fill("from the first pane");
  await first.press("ControlOrMeta+Enter");

  const second = panes.nth(1).getByLabel("Message", { exact: true });
  await second.click();
  await expect(panes.nth(1)).toHaveAttribute("data-focused", "true");
  await second.fill("from the second pane");
  await second.press("ControlOrMeta+Enter");

  await expect(panes.nth(0)).toContainText("from the first pane");
  await expect(panes.nth(1)).toContainText("from the second pane");
  await expect(panes.nth(0)).not.toContainText("from the second pane");
  await expect(panes.nth(1)).not.toContainText("from the first pane");

  await panes.nth(1).getByRole("button", { name: "Close pane" }).click();
  await expect(views).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(panes).toHaveCount(1);
});
