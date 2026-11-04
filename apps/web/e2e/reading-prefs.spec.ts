import { expect, test, type Page } from "@playwright/test";

// Settings → Appearance → Reading: the transcript's text size and width apply to an open thread
// without a reload, and stay after one.

const assistantText = (page: Page) =>
  page.getByTestId("message-assistant").first().locator('[data-slot="message-content"]').first();
const userText = (page: Page) =>
  page.getByTestId("message-user").first().locator('[data-slot="message-content"]').first();
const fontSize = (page: Page, which: typeof assistantText) =>
  which(page).evaluate((el) => getComputedStyle(el).fontSize);
const columnWidth = (page: Page) =>
  page
    .getByTestId("transcript")
    .locator("> div > div")
    .first()
    .evaluate((el) => el.getBoundingClientRect().width);

test("transcript text size and width apply live and persist", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/t/t-flaky");
  await expect(page.getByTestId("approval-card")).toBeVisible();
  expect(await fontSize(page, assistantText)).toBe("14px");
  expect(await fontSize(page, userText)).toBe("14px");
  expect(await columnWidth(page)).toBe(768);

  // No reload from here until the end: the marker would be gone.
  await page.evaluate(() => Object.assign(window, { readingMarker: true }));
  await page.keyboard.press("ControlOrMeta+,");
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("link", { name: "Appearance" })
    .click();
  const reading = page.getByTestId("reading-settings");
  const larger = reading.getByRole("button", { name: "Larger transcript text" });
  for (let i = 0; i < 3; i++) await larger.click();
  await expect(reading.getByTestId("transcript-text-size")).toHaveText("17 px");
  await reading.getByRole("radio", { name: "Narrow" }).click();
  await expect(reading.getByRole("radio", { name: "Narrow" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  const sample = reading.getByTestId("reading-preview").locator('[data-slot="message-content"]');
  await expect
    .poll(() => sample.first().evaluate((el) => getComputedStyle(el).fontSize))
    .toBe("17px");
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(sessionStorage.getItem("gram.mock.settings")!).reading),
    )
    .toEqual({ textSize: 17, width: "narrow" });

  await page.getByRole("heading", { name: "Settings", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("approval-card")).toBeVisible();
  expect(await page.evaluate(() => "readingMarker" in window)).toBe(true);
  await expect.poll(() => fontSize(page, assistantText)).toBe("17px");
  expect(await fontSize(page, userText)).toBe("17px");
  await expect.poll(() => columnWidth(page)).toBe(640);
  // The rest of the app keeps its size.
  expect(
    await page
      .getByTestId("turn-fold")
      .first()
      .evaluate((el) => getComputedStyle(el).fontSize),
  ).not.toBe("17px");

  await page.reload();
  await expect(page.getByTestId("approval-card")).toBeVisible();
  expect(await fontSize(page, assistantText)).toBe("17px");
  expect(await columnWidth(page)).toBe(640);

  // Full fills the pane past the original column.
  await page.goto("/settings/appearance");
  await page.getByTestId("reading-settings").getByRole("radio", { name: "Full" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(sessionStorage.getItem("gram.mock.settings")!).reading),
    )
    .toEqual({ textSize: 17, width: "full" });
  await page.goto("/t/t-flaky");
  await expect(page.getByTestId("approval-card")).toBeVisible();
  expect(await columnWidth(page)).toBeGreaterThan(768);
});
