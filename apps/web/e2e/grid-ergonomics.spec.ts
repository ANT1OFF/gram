import { expect, test } from "@playwright/test";

import { dragAndDrop } from "./drag";
import { setLayout } from "./layout";
import { threadRow } from "./thread-row";

test("grid: cycle panes, double-click to maximize, drag to swap, close focus, reload", async ({
  page,
}) => {
  await page.goto("/t/t-deps");
  await setLayout(page, "3 columns");
  const panes = page.getByTestId("pane");
  await expect(panes).toHaveCount(3);
  await dragAndDrop(page, threadRow(page, "t-release"), panes.nth(1));
  // t-dark is marked done: its row is under the folded Done line.
  await page.getByTestId("overview-done").getByRole("button", { name: /^Done/ }).click();
  await dragAndDrop(page, threadRow(page, "t-dark"), panes.nth(2));
  await expect(panes.nth(2)).toHaveAttribute("data-focused", "true");

  // ⌘⇧] wraps from the last pane to the first; ⌘⇧[ wraps back.
  await page.keyboard.press("ControlOrMeta+Shift+BracketRight");
  await expect(panes.nth(0)).toHaveAttribute("data-focused", "true");
  await expect(page).toHaveURL(/\/t\/t-deps$/);
  await page.keyboard.press("ControlOrMeta+Shift+BracketLeft");
  await expect(panes.nth(2)).toHaveAttribute("data-focused", "true");
  await expect(page).toHaveURL(/\/t\/t-dark$/);

  const title = (index: number) => panes.nth(index).getByTestId("pane-header").getByRole("heading");
  await title(1).dblclick();
  await expect(page.getByTestId("thread-grid")).toHaveAttribute("data-maximized", "true");
  await expect(panes.nth(0)).toBeHidden();
  await title(1).dblclick();
  await expect(page.getByTestId("thread-grid")).toHaveAttribute("data-maximized", "false");

  await dragAndDrop(page, panes.nth(0).getByTestId("pane-header"), panes.nth(2));
  await expect(panes.nth(0)).toHaveAttribute("data-thread-id", "t-dark");
  await expect(panes.nth(2)).toHaveAttribute("data-thread-id", "t-deps");

  // Closing the focused middle pane focuses a neighbour: the next pane in reading order.
  await panes.nth(1).getByRole("button", { name: "Close pane" }).click();
  await expect(page.getByTestId("empty-pane")).toHaveCount(1);
  await expect(panes.nth(2)).toHaveAttribute("data-focused", "true");
  await expect(page).toHaveURL(/\/t\/t-deps$/);

  // Let the debounced layout save land before reloading.
  await page.waitForTimeout(800);
  await page.reload();
  await expect(panes).toHaveCount(3);
  await expect(panes.nth(0)).toHaveAttribute("data-thread-id", "t-dark");
  await expect(panes.nth(2)).toHaveAttribute("data-thread-id", "t-deps");
  await expect(page.getByTestId("empty-pane")).toHaveCount(1);
});
