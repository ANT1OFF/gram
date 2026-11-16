import type { Locator, Page, PageScreenshotOptions } from "@playwright/test";

/**
 * Review pictures. Nothing compares them, so a run writes them only when `GRAM_E2E_SHOTS` is set
 * (to anything); unset, as in CI, `shot` does nothing and costs nothing.
 */
export const keepShots = process.env["GRAM_E2E_SHOTS"] !== undefined;

/** `target.screenshot(options)` when review pictures are asked for. */
export const shot = async (target: Page | Locator, options: PageScreenshotOptions) => {
  if (keepShots) await target.screenshot(options);
};
