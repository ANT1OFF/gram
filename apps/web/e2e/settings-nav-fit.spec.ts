import { expect, test } from "@playwright/test";

// Settings' nav names each page on one line, at the reading size, in the windows the tour
// captures: a page name that wraps reads as two entries.
for (const width of [1440, 1728]) {
  test(`every Settings page is named on one line at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/settings/general");
    const nav = page.getByRole("navigation", { name: "Settings sections" });
    await expect(nav).toBeVisible();
    const pages = nav.locator(":scope > ul > li > a");
    expect(await pages.count()).toBeGreaterThan(5);
    const wrapped = await pages.evaluateAll((links) =>
      links.flatMap((link) => {
        const text = [...link.childNodes].find(
          (node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim() !== "",
        );
        if (text === undefined) return [];
        const range = document.createRange();
        range.selectNodeContents(text);
        const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
        return lines.size > 1 ? [text.textContent!.trim()] : [];
      }),
    );
    expect(wrapped).toEqual([]);
  });
}
