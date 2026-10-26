import type { Page } from "@playwright/test";

/**
 * The clipboard's text with `\n` line endings. Windows hands back the `\r\n` the platform
 * clipboard stores, so an exact comparison has to read the text through this.
 */
export const clipboardText = async (page: Page): Promise<string> =>
  (await page.evaluate(() => navigator.clipboard.readText())).replaceAll("\r\n", "\n");
