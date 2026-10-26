import { expect, test, type Page } from "@playwright/test";

import { seedTheme, type SeededTheme } from "./seed-theme";
import { slowdown } from "./slowdown";

// Opening Settings used to fade the whole page from the boot palette (Tokyo Night dark) into the real
// theme: <html> started with hardcoded attributes, so every `transition-all` button and the body's
// colour transition animated on first paint. Under Glass, <main> was transparent on every route, so
// with native vibrancy (a transparent window) full-page routes had no opaque surface at all and showed
// whatever was behind them. These open and scroll Settings and assert nothing churns, animates or
// shows through. Screenshots for review go to e2e/__screenshots__/flicker/ (gitignored).

// Cold route loads run long on a loaded machine; the starved Windows runner took 38 s to open a
// thread and 11–35 s per click. The sampling itself is bounded.
test.describe.configure({ timeout: 90_000 * slowdown });

/**
 * The stored theme, seeded before the first navigation as the app boots from saved settings, with
 * Motion System (full motion here) so any colour transition would show. Driving Settings for it took minutes on Windows.
 */
const useLook = (
  page: Page,
  look: NonNullable<SeededTheme["look"]>,
  mode: SeededTheme["mode"],
  palette = "tokyo-night",
) => seedTheme(page, { look, palette, mode, motion: "system" });

/** From document start: theme attribute flips on <html>, colour transitions, layout shifts. */
const INSTRUMENT = () => {
  const probe = { flips: [] as string[], colorTransitions: 0, shiftScore: 0 };
  (window as unknown as { __flicker: typeof probe }).__flicker = probe;
  const seen: Record<string, string | null> = {};
  for (const name of ["data-look", "data-palette", "data-mode"]) {
    seen[name] = document.documentElement.getAttribute(name);
  }
  let synced = false;
  new MutationObserver(() => {
    for (const name of Object.keys(seen)) {
      const now = document.documentElement.getAttribute(name);
      // The one sync from the boot attributes to the stored theme is expected; later changes are churn.
      if (now !== seen[name] && synced) probe.flips.push(`${name}: ${seen[name]} → ${now}`);
      seen[name] = now;
    }
  }).observe(document.documentElement, { attributes: true });
  addEventListener("load", () => setTimeout(() => (synced = true), 300));
  const sample = setInterval(() => {
    for (const animation of document.getAnimations()) {
      const property = (animation as CSSTransition).transitionProperty;
      if (property && /color|background/.test(property)) probe.colorTransitions++;
    }
  }, 50);
  setTimeout(() => clearInterval(sample), 4000);
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as (PerformanceEntry & {
      value: number;
      hadRecentInput: boolean;
    })[]) {
      if (!entry.hadRecentInput) probe.shiftScore += entry.value;
    }
  }).observe({ type: "layout-shift", buffered: true });
};

/** What the desktop bridge sets while window vibrancy / Mica sits behind a transparent window. */
const forceNativeVibrancy = (page: Page) =>
  page.evaluate(() => {
    document.documentElement.dataset["vibrancy"] = "native";
  });

/** Alpha of a computed colour: `rgb(… / a)`, `rgba(r, g, b, a)` or `color(srgb … / a)`. */
const alphaOf = (color: string) => {
  if (color === "transparent") return 0;
  const slash = /\/\s*([\d.]+)\s*\)$/.exec(color);
  if (slash) return Number(slash[1]);
  const rgba = /^rgba\(([^)]+)\)$/.exec(color);
  const parts = rgba?.[1]?.split(",") ?? [];
  return parts.length === 4 ? Number(parts[3]) : 1;
};

const mainAlpha = async (page: Page) =>
  alphaOf(await page.locator("main").evaluate((el) => getComputedStyle(el).backgroundColor));

/** Body background alpha once its colour transition settles; the first frame still reads the old colour. */
const settledBodyAlpha = async (page: Page) =>
  alphaOf(
    await page.locator("body").evaluate(async (el) => {
      await Promise.all(el.getAnimations().map((animation) => animation.finished.catch(() => {})));
      return getComputedStyle(el).backgroundColor;
    }),
  );

for (const [look, mode] of [
  ["glass", "light"],
  ["glass", "dark"],
] as const) {
  test(`opening and scrolling Settings doesn't flicker (${look}, ${mode})`, async ({ page }) => {
    await useLook(page, look, mode);
    await page.addInitScript(INSTRUMENT);
    await page.goto("/settings/keyboard");
    await expect(page.getByRole("navigation", { name: "Settings sections" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-look", look);
    await expect(page.locator("html")).toHaveAttribute("data-mode", mode);
    await page.waitForTimeout(1500);

    // One in-page pass with a deadline: under load it scrolls less of the page instead of timing out.
    const scrolled = await page
      .locator("main :has(> [data-settings-results])")
      .evaluate(async (el) => {
        const deadline = performance.now() + 2500;
        const height = el.scrollHeight - el.clientHeight;
        for (let top = 0; top <= height && performance.now() < deadline; top += 150) {
          el.scrollTo({ top });
          // A timer, not requestAnimationFrame: frames can stall on a loaded headless page, and then
          // the deadline would never be checked.
          await new Promise((resolve) => setTimeout(resolve, 32));
        }
        return { height, top: el.scrollTop };
      });
    expect(scrolled.height === 0 || scrolled.top > 0, "Settings didn't scroll").toBe(true);
    await page.waitForTimeout(300);

    const probe = await page.evaluate(
      () =>
        (
          window as unknown as {
            __flicker: { flips: string[]; colorTransitions: number; shiftScore: number };
          }
        ).__flicker,
    );
    expect(probe.flips, "theme attributes changed after the first sync").toEqual([]);
    expect(probe.colorTransitions, "colours animated while opening").toBe(0);
    expect(probe.shiftScore, "layout shifted").toBeLessThan(0.01);
    expect(await mainAlpha(page), "Settings has no opaque surface").toBe(1);
  });
}

test("full-page routes stay opaque over native vibrancy (Glass light, Catppuccin)", async ({
  page,
}) => {
  await useLook(page, "glass", "light", "catppuccin-mocha");

  // A thread first: the grid floats panes over the translucent backdrop.
  await page.goto("/t/t-flaky");
  await expect(page.getByTestId("thread-grid")).toBeVisible();
  await forceNativeVibrancy(page);
  await expect(page.locator("html")).toHaveAttribute("data-vibrancy", "native");
  expect(
    await settledBodyAlpha(page),
    "the native vibrancy path should leave the body translucent",
  ).toBeLessThan(1);
  // The gaps between floating panes paint an opaque backdrop too; a transparent window never clears.
  expect(await mainAlpha(page), "the gaps between panes show the window").toBe(1);
  await page.screenshot({ path: "e2e/__screenshots__/flicker/glass-native-grid.png" });

  // Then Settings, in-app, the way ⌘, opens it.
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.getByRole("navigation", { name: "Settings sections" })).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.locator("html")).toHaveAttribute("data-vibrancy", "native");
  expect(await mainAlpha(page), "Settings content is see-through").toBe(1);
  await expect(page.getByTestId("thread-grid")).toHaveCount(0);
  await expect(page.getByTestId("transcript")).toHaveCount(0);
  await page.screenshot({ path: "e2e/__screenshots__/flicker/glass-native-settings.png" });

  for (const path of ["/settings/gateways", "/new", "/"]) {
    await page.goto(path);
    await forceNativeVibrancy(page);
    await page.waitForTimeout(500);
    expect(await mainAlpha(page), `${path} is see-through`).toBe(1);
    if (path === "/new") {
      await page.screenshot({ path: "e2e/__screenshots__/flicker/glass-native-new.png" });
    }
  }
});
