import type { Locator, Page } from "@playwright/test";

/**
 * Drags `source` onto `target` by dispatching the HTML drag events with one shared `DataTransfer`,
 * so the app's dragstart, dragover and drop handlers run as they would for a real drag. Native
 * `dragTo` stalled for up to 69 s per drag on the GPU-less Windows runner.
 */
export async function dragAndDrop(page: Page, source: Locator, target: Locator): Promise<void> {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent("dragstart", { dataTransfer });
  await target.dispatchEvent("dragenter", { dataTransfer });
  await target.dispatchEvent("dragover", { dataTransfer });
  await target.dispatchEvent("drop", { dataTransfer });
  await source.dispatchEvent("dragend", { dataTransfer });
  await dataTransfer.dispose();
}
