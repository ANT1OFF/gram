import { expect, test, type Page } from "@playwright/test";

import { installFlickerObserver } from "./flicker-observer";
import { frames } from "./settled";

// The right panel, watched by the flicker observer Bombadil runs (e2e/flicker-observer.ts): the
// diff stays on screen while a newer one is fetched after the tree moves.

const flickers = (page: Page) => page.evaluate(() => window.gramFlicker!);

const MOCK_SETTINGS_KEY = "gram.mock.settings";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(installFlickerObserver, {});
});

test("an edit to the tree keeps the diff on screen until the newer one comes", async ({ page }) => {
  await page.addInitScript(
    ([key]) => {
      if (sessionStorage.getItem(key) === null)
        sessionStorage.setItem(key, JSON.stringify({ panel: { open: true, tab: "diff" } }));
      // On each change, whether the diff panel says it is loading: the mock answers within a
      // frame, so a frame's look could miss what a slower answer leaves on screen.
      const seen: boolean[] = [];
      (window as unknown as { diffLoading: boolean[] }).diffLoading = seen;
      new MutationObserver(() => {
        const panel = document.querySelector('[data-testid="diff-panel"]');
        seen.push((panel?.textContent ?? "").includes("Loading diff"));
      }).observe(document, { subtree: true, childList: true, characterData: true });
    },
    [MOCK_SETTINGS_KEY] as const,
  );
  await page.goto("/t/t-flaky");
  const panel = page.getByTestId("diff-panel");
  await expect(panel.getByTestId("diff-summary")).toBeVisible();
  await frames(page, 5);
  await page.evaluate(() => {
    (window as unknown as { diffLoading: boolean[] }).diffLoading.length = 0;
  });
  // The agent edits a file: the tree's stamp moves, and the diff is fetched again.
  for (const token of ["edit-1", "edit-2"]) {
    await page.evaluate((changesToken) => {
      const world = window.gramMock!.world;
      const git = world.summary("t-flaky" as never).git!;
      world.publishGit("t-flaky" as never, { ...git, changesToken });
    }, token);
    await frames(page, 10);
  }
  await expect(panel.getByTestId("diff-summary")).toBeVisible();
  const loading = await page.evaluate(
    () => (window as unknown as { diffLoading: boolean[] }).diffLoading,
  );
  expect(loading.filter(Boolean)).toEqual([]);
  expect((await flickers(page)).last).toEqual([]);
});
