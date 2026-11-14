import { expect, test } from "@playwright/test";

test("a layout-generated pointer entry at the origin leaves the conversation reachable", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 700, height: 720 });
  await page.goto("/t/t-flaky");
  const composer = page.getByLabel("Message", { exact: true });
  await composer.waitFor();
  await page.clock.install();
  // Linux Chromium reports an entry at its initial (0, 0) position when the strip mounts.
  // It has not moved onto the strip: a layout-generated entry must not open it over the page.
  await page.mouse.move(0, 0);
  await page.clock.runFor(500);
  await page.screenshot({ path: testInfo.outputPath("origin-hover.png") });
  await expect(page.getByTestId("overview-rail-overlay")).toHaveCount(0);
  await page.clock.resume();
  await composer.click();
});

test("leaving the compact strip before its hover delay cancels its pending open", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 700, height: 720 });
  await page.goto("/t/t-flaky");
  const composer = page.getByLabel("Message", { exact: true });
  await composer.waitFor();
  // Start away from the strip, then pass through it without resting on it.
  await page.mouse.move(600, 120);
  await page.clock.install();
  await page.mouse.move(20, 120);
  const box = (await composer.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.clock.runFor(500);
  await page.screenshot({ path: testInfo.outputPath("passing-hover.png") });
  await expect(page.getByTestId("overview-rail-overlay")).toHaveCount(0);
  await page.clock.resume();
  await composer.click();
});
