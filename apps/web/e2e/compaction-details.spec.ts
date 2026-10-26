import { expect, test, type Page } from "@playwright/test";
import type { GramUIMessage } from "@gram/contracts";

const summary =
  "1. **Intent**\nPreserve the retry fix.\n<script>unsafe()</script>\n" +
  "retained_context_".repeat(200);
const message: GramUIMessage = {
  id: "compaction-detail-history",
  role: "assistant",
  parts: [
    {
      type: "data-compaction",
      id: "compaction:result",
      data: {
        trigger: "manual",
        at: Date.UTC(2026, 9, 10, 12, 32),
        preTokens: 182_000,
        postTokens: 24_000,
        summary,
      },
    },
    {
      type: "data-compaction",
      id: "compaction:unavailable",
      data: {
        trigger: "auto",
        preTokens: 42,
      },
    },
  ],
};

/** Rehydrate the same saved message after a browser reload; mock feeds intentionally reset. */
const restoreHistory = async (page: Page) => {
  await page.getByLabel("Message", { exact: true }).waitFor();
  await page.evaluate(() => {
    const saved = JSON.parse(sessionStorage.getItem("gram.test.compaction-history")!);
    window.gramMock!.simulateMessage("t-deps" as never, saved);
  });
};

for (const width of [1440, 390]) {
  test(`compaction details support keyboard, unavailable results and restored history at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/t/t-deps");
    await page.evaluate(
      (saved) => sessionStorage.setItem("gram.test.compaction-history", saved),
      JSON.stringify(message),
    );
    await restoreHistory(page);
    const markers = page.getByTestId("compaction");
    const toggle = markers.first().getByRole("button");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toHaveText(/^Context compacted · .*\d{2}:\d{2} · 182K → 24K tokens$/);
    await expect(toggle).not.toHaveText(/AM|PM/);
    await expect(page.getByTestId("compaction-summary")).toHaveCount(0);
    await toggle.hover();
    await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toContainText(
      "Show compaction details",
    );
    await page.mouse.move(0, 0);
    await toggle.focus();
    await toggle.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(toggle).toBeFocused();
    await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toContainText(
      "Show compaction details",
    );
    await toggle.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const result = page.getByTestId("compaction-summary");
    await expect(result).toHaveText(summary);
    await expect(result.locator("script")).toHaveCount(0);
    await expect(markers.first()).toContainText("Manual compaction · Completed");
    const bounds = await result.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(await result.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await toggle.press("Tab");
    await expect(result).toBeFocused();
    await result.press("PageDown");
    await expect(async () => {
      expect(await result.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    }).toPass({ timeout: 5_000 });
    await page.screenshot({ path: testInfo.outputPath(`compaction-expanded-${width}.png`) });
    await page.keyboard.press("Shift+Tab");
    await toggle.press("Space");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(result).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`compaction-collapsed-${width}.png`) });
    const missing = markers.nth(1).getByRole("button");
    await missing.click();
    await expect(markers.nth(1)).toContainText("Automatic compaction · Completed");
    await expect(markers.nth(1)).toContainText("Summary not provided");
    await expect(markers.nth(1)).toContainText(
      "was not supplied by the agent or saved in this history",
    );
    await expect(markers.nth(1).getByTestId("compaction-summary")).toHaveCount(0);
    await page.reload();
    await restoreHistory(page);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(result).toHaveText(summary);
    await missing.click();
    await expect(markers.nth(1)).toContainText("Summary not provided");
    const unavailable = markers.nth(1).getByTestId("compaction-details");
    await unavailable.scrollIntoViewIfNeeded();
    await unavailable.hover();
    await page.mouse.wheel(0, 500);
    await page.mouse.move(0, 0);
    await expect(async () => {
      const details = (await unavailable.boundingBox())!;
      const transcript = (await page.getByTestId("transcript").boundingBox())!;
      expect(details.y + details.height).toBeLessThanOrEqual(transcript.y + transcript.height - 24);
    }).toPass({ timeout: 5_000 });
    await page.screenshot({ path: testInfo.outputPath(`compaction-restored-${width}.png`) });
  });
}
