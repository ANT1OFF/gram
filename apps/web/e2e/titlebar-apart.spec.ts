import { expect, test, type Page } from "@playwright/test";

import { barOverlap } from "./bar-overlap";

// No two controls drawn in the title bar overlap, at a phone's, a tablet's and a small laptop's
// width, with the right panel open and as its edge is dragged either way. Narrow, the bar folds the
// usage meter into "…" and keeps a hidden, inert copy at its end to measure (shell/foldable.tsx):
// Bombadil's first run counted that copy as over "Hide right panel"; on screen nothing is.

const MOCK_SETTINGS_KEY = "gram.mock.settings";

const start = async (page: Page, width: number, height: number, path: string) => {
  await page.setViewportSize({ width, height });
  await page.addInitScript(
    ([key]) => {
      if (sessionStorage.getItem(key) === null)
        sessionStorage.setItem(key, JSON.stringify({ panel: { open: true, tab: "files" } }));
    },
    [MOCK_SETTINGS_KEY] as const,
  );
  await page.goto(path);
  await expect(page.getByTestId("shell-titlebar")).toBeVisible();
};

const overlap = (page: Page) => page.getByTestId("shell-titlebar").evaluate(barOverlap);

/** Drags the right panel's edge by `dx`, as far as its bounds let it. */
async function dragPanelEdge(page: Page, dx: number) {
  const box = (await page.getByTestId("right-resize").boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
}

const SIZES = [
  [360, 740],
  [768, 1024],
  [1024, 768],
] as const;

for (const [width, height] of SIZES) {
  for (const path of ["/", "/threads", "/t/t-flaky"]) {
    test(`at ${width} px on ${path}, no two title bar controls overlap`, async ({ page }) => {
      await start(page, width, height, path);
      await expect.poll(() => overlap(page)).toBeNull();
    });
  }
}

test("at 768 px with the right panel open, the usage meter folds into the …", async ({ page }) => {
  await start(page, 768, 1024, "/t/t-flaky");
  const bar = page.getByTestId("shell-titlebar");
  await expect(page.getByLabel("Hide right panel")).toBeVisible();
  // Folded: kept in the bar to measure, but inert and unseen.
  await expect(bar.locator('[inert] [data-testid="usage-meter"]')).toBeAttached();
  await expect(bar.getByTestId("usage-meter")).toBeHidden();
  await expect.poll(() => overlap(page)).toBeNull();
  await page.getByTestId("titlebar-overflow").click();
  await expect(page.getByTestId("phone-menu-usage")).toBeVisible();
});

for (const width of [768, 1024]) {
  test(`at ${width} px, dragging the right panel's edge either way overlaps nothing`, async ({
    page,
  }) => {
    await start(page, width, 900, "/t/t-flaky");
    // The panel as wide as it goes, the chat's bar at its least; then as narrow, the bar at its most.
    for (const dx of [-width, width, -width / 4]) {
      await dragPanelEdge(page, dx);
      if (dx === -width)
        await expect
          .poll(async () => (await page.getByTestId("shell-titlebar").boundingBox())!.width)
          .toBeLessThan(width / 2);
      await expect.poll(() => overlap(page), { message: `dragged by ${dx}` }).toBeNull();
    }
  });
}
