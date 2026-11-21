import { expect, test, type Page } from "@playwright/test";

import { installFlickerObserver } from "./flicker-observer";
import { frames } from "./settled";

// Settings, watched by the flicker observer Bombadil runs (e2e/flicker-observer.ts): a page keeps
// its place as it loads, a search's Enter swaps its results for the page in one frame, and opening
// Settings while it is open leaves the open page drawn.

const flickers = (page: Page) => page.evaluate(() => window.gramFlicker!);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installFlickerObserver, {});
});

// Settings opened at /settings/about, its drawn states recorded from here on.
const drawn = (page: Page) =>
  page.evaluate(() => (window as unknown as { settingsDrawn: string[] }).settingsDrawn);

const opened = async (page: Page) => {
  await page.goto("/settings/about");
  await expect(page.getByTestId("settings-section-picker")).toContainText("About");
  await expect(page.getByTestId("settings-subpages")).toBeVisible();
  await frames(page, 10);
  await page.evaluate(() => {
    (window as unknown as { settingsDrawn: string[] }).settingsDrawn.length = 0;
  });
};
const expectStill = async (page: Page) => {
  await expect(page).toHaveURL(/\/settings\/about$/);
  await frames(page, 10);
  await expect(page.getByTestId("settings-section-picker")).toContainText("About");
  expect((await drawn(page)).filter((each) => each !== "About▼, list")).toEqual([]);
  expect((await flickers(page)).last).toEqual([]);
};

for (const width of [768, 1440]) {
  test(`at ${width} px, About keeps its place as it loads`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/settings/about");
    await expect(page.getByText("Version", { exact: true })).toBeVisible();
    await expect(page.getByTestId("settings-subpages")).toBeVisible();
    await frames(page, 10);
    expect((await flickers(page)).last).toEqual([]);
  });
}

test("a search's Enter opens Keyboard with its rows kept on screen", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Whether Keyboard's rows are on screen, each frame. Before its route's code was in, the
  // results' rows went at once and the page's came a few frames later.
  await page.addInitScript(() => {
    const seen: boolean[] = [];
    (window as unknown as { rowsShown: boolean[] }).rowsShown = seen;
    const look = () => {
      seen.push(document.querySelector('[data-testid="keyboard-settings"] li') !== null);
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
  await page.goto("/settings/general");
  await page.getByLabel("Search settings").fill("keyboard");
  await expect(page.getByTestId("keyboard-settings").locator("li").first()).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { rowsShown: boolean[] }).rowsShown.length = 0;
  });
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/settings\/keyboard/);
  await frames(page, 10);
  const shown = await page.evaluate(
    () => (window as unknown as { rowsShown: boolean[] }).rowsShown,
  );
  expect(shown.filter((each) => !each)).toEqual([]);
  expect((await flickers(page)).last).toEqual([]);
});

test.describe("at a phone's width, Settings opened again while open", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  // What Settings draws on each change: its picker's words and whether its list is there. The
  // observer leaves out what changes in the frame of a key or click, as answering it; the redraw
  // starts in that frame.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { settingsDrawn: string[] }).settingsDrawn = seen;
      new MutationObserver(() => {
        const picker = document.querySelector('[data-testid="settings-section-picker"]');
        const list = document.querySelector('[data-testid="settings-subpages"]') !== null;
        seen.push(`${picker?.textContent ?? "no picker"}, ${list ? "list" : "no list"}`);
      }).observe(document, { subtree: true, childList: true, characterData: true });
    });
  });
  test("from the title bar's …, stays on its page with nothing redrawn", async ({ page }) => {
    await opened(page);
    await page.getByTestId("titlebar-overflow").click();
    await page.getByTestId("phone-menu-settings").click();
    await expectStill(page);
  });

  test("from ⌘, stays on its page with nothing redrawn", async ({ page }) => {
    await opened(page);
    await page.keyboard.press("ControlOrMeta+Comma");
    await expectStill(page);
  });
});
