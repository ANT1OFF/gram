import { expect, test, type Locator } from "@playwright/test";

import { seedTheme } from "./seed-theme";

/**
 * The percent label's nodes. The ticker formats the "%" itself, so the label is the ticker then the
 * tokens it stands for; a separate "%" text node is what rendered as "100  %". Text matching can't
 * check this, since it reads the ticker's digit reels.
 */
const labelNodes = (meter: Locator) =>
  meter
    .getByRole("meter", { name: "Context used" })
    .evaluate((el) =>
      [...(el.nextElementSibling?.childNodes ?? [])].map((node) =>
        node instanceof Element ? node.tagName.toLowerCase() : node.textContent,
      ),
    );

test("the thread ring opens the usage meter, with a gapless percent", async ({ page }) => {
  await page.goto("/t/t-flaky");
  // The thread's bar opens from the ring beside Send.
  const ring = page.getByTestId("thread-view").getByTestId("usage-ring");
  await expect(ring).toHaveAccessibleName("Usage: 31% of the context window");
  await ring.click();
  const thread = page.locator('[data-slot="usage-meter"]');
  await expect(thread.getByRole("meter", { name: "Context used" })).toHaveAttribute(
    "aria-valuenow",
    "31",
  );
  expect(await labelNodes(thread)).toEqual(["number-flow-react", "span"]);
  await expect(thread.getByTestId("usage-context").locator(":scope > span")).toHaveText(
    " · 62K / 200K tokens",
  );
  await expect(thread.getByTestId("usage-fill")).toHaveCount(1);
});

test("at Motion Off the meter is settled on arrival, with nothing animating", async ({ page }) => {
  await seedTheme(page, { palette: "tokyo-night", mode: "dark", motion: "off" });
  await page.goto("/t/t-flaky");
  await expect(page.locator("html")).toHaveAttribute("data-motion", "off");
  await page.getByTestId("usage-ring").click();
  const fill = page.getByTestId("usage-fill");
  await expect(fill).toHaveAttribute("style", /width: 31%/);
  expect(await fill.evaluate((el) => el.getAnimations().length)).toBe(0);
});
