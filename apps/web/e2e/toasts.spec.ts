import { expect, test } from "@playwright/test";

import { slowdown } from "./slowdown";

test("a toast docks below the open right panel, so the panel's lowest button stays clickable", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/t/t-flaky");
  const panel = page.getByTestId("right-panel");
  await panel.getByRole("tab", { name: "PR", exact: true }).click();
  const content = panel.getByRole("tabpanel", { name: "PR", exact: true });
  await expect(content).toBeVisible();

  // Toasts close after 6 s, which a slow runner spends on the checks below; frozen time keeps it up.
  await page.clock.pauseAt(Date.now() + 1_000);
  await page.evaluate(() => window.gramMock?.simulateChecks("t-flaky" as never, "passing"));
  // Server events land at the next frame, which the paused clock draws only when stepped.
  await page.clock.runFor(100);
  const toast = panel.getByTestId("toast").filter({ hasText: "CI passed on #412" });
  await expect(toast).toBeVisible();

  // Docked in the panel's own layout: below its content, not over it.
  const contentBox = await content.boundingBox();
  const toastBox = await toast.boundingBox();
  expect(contentBox && toastBox).toBeTruthy();
  expect(toastBox!.y).toBeGreaterThanOrEqual(contentBox!.y + contentBox!.height - 1);

  // Playwright's actionability check fails when another element would receive the click.
  const lowest = content.getByRole("button").last();
  await lowest.scrollIntoViewIfNeeded();
  await lowest.click({ trial: true, timeout: 2_000 * slowdown });

  await toast.getByRole("button").first().focus();
  await page.keyboard.press("Escape");
  // It is out of reach at once, and folds away over time, which is frozen here: let that run.
  await expect(toast).toHaveAttribute("inert", "");
  await page.clock.runFor(1_000);
  await expect(toast).toBeHidden();
});
