import { expect, test } from "@playwright/test";
import { setLayout } from "./layout";
import { threadRow } from "./thread-row";

test("grid: preset, drag to pane, focus shortcuts, independent sends, maximize, reload restore", async ({
  page,
}) => {
  await page.goto("/t/t-deps");
  await setLayout(page, "2×2");

  const panes = page.getByTestId("pane");
  await expect(panes).toHaveCount(4);
  await expect(page.getByTestId("empty-pane")).toHaveCount(3);
  await expect(panes.nth(0)).toHaveAttribute("data-thread-id", "t-deps");

  await threadRow(page, "t-release").dragTo(panes.nth(1));
  await expect(panes.nth(1)).toHaveAttribute("data-thread-id", "t-release");
  await expect(panes.nth(1)).toHaveAttribute("data-focused", "true");
  await expect(page).toHaveURL(/\/t\/t-release$/);

  await threadRow(page, "t-dark").dragTo(panes.nth(2));
  await expect(panes.nth(2)).toHaveAttribute("data-thread-id", "t-dark");

  // ⌘⇧[ focuses the pane before, and the address follows (⌘1–⌘9 switch workspaces, not panes).
  await expect(panes.nth(2)).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("ControlOrMeta+Shift+BracketLeft");
  await expect(panes.nth(1)).toHaveAttribute("data-focused", "true");
  await expect(page).toHaveURL(/\/t\/t-release$/);
  await page.keyboard.press("ControlOrMeta+Shift+BracketLeft");
  await expect(panes.nth(0)).toHaveAttribute("data-focused", "true");
  await expect(page).toHaveURL(/\/t\/t-deps$/);

  const first = panes.nth(0).getByLabel("Message", { exact: true });
  await first.click();
  await first.fill("hello from pane one");
  await first.press("ControlOrMeta+Enter");
  const second = panes.nth(1).getByLabel("Message", { exact: true });
  await second.click();
  await second.fill("hello from pane two");
  await second.press("ControlOrMeta+Enter");

  await expect(panes.nth(0)).toContainText("hello from pane one");
  await expect(panes.nth(1)).toContainText("hello from pane two");
  await expect(panes.nth(0)).not.toContainText("hello from pane two");
  await expect(panes.nth(1)).not.toContainText("hello from pane one");

  await page.keyboard.press("ControlOrMeta+Shift+Enter");
  await expect(page.getByTestId("thread-grid")).toHaveAttribute("data-maximized", "true");
  await expect(panes.nth(0)).toBeHidden();
  await page.keyboard.press("ControlOrMeta+Shift+Enter");
  await expect(panes.nth(0)).toBeVisible();

  // Let the debounced layout save land before reloading.
  await page.waitForTimeout(800);
  await page.reload();
  await expect(panes).toHaveCount(4);
  await expect(panes.nth(0)).toHaveAttribute("data-thread-id", "t-deps");
  await expect(panes.nth(1)).toHaveAttribute("data-thread-id", "t-release");
  await expect(panes.nth(2)).toHaveAttribute("data-thread-id", "t-dark");
  await expect(panes.nth(1)).toHaveAttribute("data-focused", "true");
});
