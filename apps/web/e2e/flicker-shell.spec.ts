import { expect, test, type Page } from "@playwright/test";

import { installFlickerObserver } from "./flicker-observer";
import { frames } from "./settled";

// What the shell draws as it boots, watched by the flicker observer Bombadil runs
// (e2e/flicker-observer.ts) from the document's start: the welcome screen keeps its place as it
// loads, and the title bar never shows Chat · Board for a frame with no workspace to switch.

const flickers = (page: Page) => page.evaluate(() => window.gramFlicker!);

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(installFlickerObserver, {});
});

test("the welcome screen keeps its place as it loads", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("welcome-repos")).toBeVisible();
  await frames(page, 10);
  expect((await flickers(page)).last).toEqual([]);
});

test("with no workspace, the title bar never shows Chat · Board", async ({ page }) => {
  // Every text the title bar has had, from the document's start.
  await page.addInitScript(() => {
    const seen = new Set<string>();
    (window as unknown as { titlebarTexts: Set<string> }).titlebarTexts = seen;
    new MutationObserver(() => {
      const bar = document.querySelector('[data-testid="shell-titlebar"]');
      if (bar !== null) seen.add(bar.textContent ?? "");
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  const texts = () =>
    page.evaluate(() => [...(window as unknown as { titlebarTexts: Set<string> }).titlebarTexts]);
  for (const path of ["/", "/threads"]) {
    await page.goto(path);
    await expect(page.getByTestId("shell-titlebar")).toContainText("Threads");
    await frames(page, 10);
    expect(await texts(), path).not.toContainEqual(expect.stringContaining("Board"));
    expect((await flickers(page)).last, path).toEqual([]);
  }
});
