import { expect, test } from "@playwright/test";

// Opening Settings from the dock adds one history entry, so one Back leaves it, even after the
// dock's Settings is pressed again in Settings. `/settings` redirects to the tab open last time,
// the open one by then: pushed, it left two of the same entry, and the first Back seemed to do
// nothing (found by the Bombadil trial's `backLeavesThePage`).

test("one Back leaves Settings opened from the dock", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // The dock at the window's foot in place of the sidebar, as picked in Settings → Appearance.
  await page.addInitScript(() =>
    localStorage.setItem(
      "gram.navigation",
      JSON.stringify({ state: { picked: { position: "bottom" } }, version: 1 }),
    ),
  );
  await page.goto("/t/t-flaky");
  await page.getByLabel("Message", { exact: true }).waitFor();
  const entries = () => page.evaluate(() => history.length);
  const before = await entries();

  const settings = page.getByTestId("nav-dock-settings");
  await settings.click();
  await expect(page).toHaveURL(/\/settings\/general$/);
  await expect(page.getByTestId("general-settings")).toBeVisible();
  expect(await entries()).toBe(before + 1);

  // Pressed again in Settings, it stays on the tab and adds nothing.
  await settings.click();
  await expect(page).toHaveURL(/\/settings\/general$/);
  await expect(page.getByTestId("general-settings")).toBeVisible();
  expect(await entries()).toBe(before + 1);

  await page.goBack();
  await expect(page).toHaveURL(/\/t\/t-flaky$/);
});
