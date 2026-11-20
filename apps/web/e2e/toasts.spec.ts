import { expect, test } from "@playwright/test";

import { slowdown } from "./slowdown";
import { openPanelTab } from "./panel-tab";

test("a toast sits in the chat's corner, out of the open right panel, whose lowest button stays clickable", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/t/t-flaky");
  const panel = page.getByTestId("right-panel");
  await openPanelTab(panel, "PR");
  const content = panel.getByRole("tabpanel", { name: "PR", exact: true });
  const height = (await content.boundingBox())?.height;
  await expect(content).toBeVisible();

  // Toasts close after 6 s, which a slow runner spends on the checks below; frozen time keeps it up.
  await page.clock.pauseAt(Date.now() + 1_000);
  await page.evaluate(() => window.gramMock?.simulateChecks("t-flaky" as never, "passing"));
  // Server events land at the next frame, which the paused clock draws only when stepped.
  await page.clock.runFor(100);
  const toast = page
    .locator("#content")
    .getByTestId("toast")
    .filter({ hasText: "CI passed on #412" });
  await expect(toast).toBeVisible();
  // In the chat column, never in the panel: its worker or tab keeps its full height.
  await expect(panel.getByTestId("toast")).toHaveCount(0);

  // The panel's content keeps the height it had before the toast.
  expect((await content.boundingBox())?.height).toBe(height);

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
