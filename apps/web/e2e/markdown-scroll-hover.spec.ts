import { expect, test } from "@playwright/test";

import { openPanelTab } from "./panel-tab";

declare global {
  interface Window {
    shownActions: number[];
    scrolledTo: number;
  }
}

// A code block's and a table's buttons show on hover. Scrolling a long Markdown file with the
// pointer resting on it slides block after block under the pointer: their buttons must not fade in
// and out as they pass (the preview's scroll flicker). Moving the pointer still shows them.

const ACTIONS =
  '[data-streamdown="code-block-actions"], [data-streamdown="table-wrapper"]:not([role="presentation"]) > div:first-child:not(:last-child)';

test("scrolling a Markdown preview under a resting pointer doesn't flash its blocks' buttons", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  const panel = page.getByTestId("right-panel");
  await openPanelTab(panel, "Files");
  const tree = panel.getByTestId("files-tree-pane").getByRole("tree", { name: "Files" });
  await tree.getByRole("treeitem", { name: "docs", exact: true }).click();
  await tree.getByRole("treeitem", { name: "guide.md", exact: true }).click();
  const markdown = panel.getByTestId("markdown-preview");
  await expect(markdown.locator('[data-streamdown="code-block"]')).toHaveCount(16);

  // Every frame, how many of the preview's block buttons are showing at all; and where the last
  // scroll event the preview's scroller fired left it.
  await page.evaluate((actions) => {
    const preview = document.querySelector('[data-testid="markdown-preview"]')!;
    const seen: number[] = [];
    window.shownActions = seen;
    window.scrolledTo = 0;
    document.addEventListener(
      "scroll",
      (event) => {
        if (event.target instanceof Element && event.target.contains(preview))
          window.scrolledTo = event.target.scrollTop;
      },
      { capture: true, passive: true },
    );
    const tick = () => {
      seen.push(
        [...preview.querySelectorAll(actions)].filter(
          (element) => Number(getComputedStyle(element).opacity) > 0,
        ).length,
      );
      requestAnimationFrame(tick);
    };
    tick();
  }, ACTIONS);

  const box = (await markdown.boundingBox())!;
  const scroller = await page.evaluate(() => {
    const rect = document
      .querySelector('[data-testid="markdown-preview"]')!
      .parentElement!.getBoundingClientRect();
    return { top: rect.top, height: rect.height };
  });
  await page.mouse.move(box.x + box.width / 2, scroller.top + scroller.height / 3);
  const steps = 30;
  for (let step = 0; step < steps; step += 1) {
    await page.mouse.wheel(0, 120);
  }
  // A wheel only starts its scroll: the browser lands it on a later frame, and on a slow machine
  // after this spec has gone on to measure the blocks and move the pointer. Its scroll events would
  // then come after that move and, rightly, hide the buttons again. Wait for the last one to land.
  await expect.poll(() => page.evaluate(() => window.scrolledTo)).toBe(steps * 120);
  const shown = await page.evaluate(() => window.shownActions);
  expect(shown.length).toBeGreaterThan(10);
  expect(Math.max(...shown)).toBe(0);

  // The pointer moving onto a block is pointing at it: its buttons show.
  const point = await page.evaluate(() => {
    const view = document
      .querySelector('[data-testid="markdown-preview"]')!
      .parentElement!.getBoundingClientRect();
    const blocks = document.querySelectorAll(
      '[data-testid="markdown-preview"] [data-streamdown="code-block"]',
    );
    for (const [index, element] of blocks.entries()) {
      const rect = element.getBoundingClientRect();
      const top = Math.max(rect.top, view.top);
      if (Math.min(rect.bottom, view.bottom) - top > 30)
        return { index, x: rect.left + rect.width / 2, y: top + 15 };
    }
    return undefined;
  });
  expect(point).toBeDefined();
  await page.mouse.move(point!.x, point!.y);
  await page.mouse.move(point!.x + 2, point!.y + 2);
  await expect(
    markdown
      .locator('[data-streamdown="code-block"]')
      .nth(point!.index)
      .locator('[data-streamdown="code-block-actions"]'),
  ).toHaveCSS("opacity", "1");
});
