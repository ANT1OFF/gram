import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { test, type Locator, type Page } from "@playwright/test";

import { pathShot, seedMockSettings, SHOTS, type Shot, type ShotMode } from "./shots";

// One test per shot and mode, writing `out/<name>-<mode>.<label>.png`. `scripts/pr-shots.mjs`
// picks the shots, the label and the checkout through the env; run it rather than this.

const env = process.env;
const label = env["GRAM_PR_SHOTS_LABEL"] === "before" ? "before" : "after";
const list = (name: string) => (env[name] ?? "").split(",").filter((item) => item !== "");
const outDir = fileURLToPath(new URL("out/", import.meta.url));
mkdirSync(outDir, { recursive: true });

/** Fixed, so relative times and date labels read the same in both runs. */
const CLOCK = new Date("2026-06-15T10:00:00+02:00");

function selected(): readonly Shot[] {
  const names = list("GRAM_PR_SHOTS_ONLY");
  const paths = list("GRAM_PR_SHOTS_PATHS").map(pathShot);
  const unknown = names.filter((name) => !SHOTS.some((shot) => shot.name === name));
  if (unknown.length > 0) {
    throw new Error(
      `no shot named ${unknown.join(", ")}; the shots are ${SHOTS.map((s) => s.name).join(", ")}`,
    );
  }
  const named =
    names.length === 0 && paths.length === 0
      ? SHOTS
      : SHOTS.filter((shot) => names.includes(shot.name));
  const all = [...named, ...paths];
  const clash = all.find((shot, i) => all.findIndex((other) => other.name === shot.name) !== i);
  if (clash) throw new Error(`two shots are named ${clash.name}`);
  return all;
}

/** How long a screen gets to stop changing before it is captured as it stands. */
const SETTLE_MS = 10_000;

/** Between the frames `settled` compares: the transcript's scroll to the end lands this late. */
const SETTLE_GAP_MS = 500;

/**
 * Captures until two frames `SETTLE_GAP_MS` apart match, as `toHaveScreenshot` does, so a row or a
 * scroll that lands a moment late can't be in one run's image and missing from the other's.
 */
async function settled(page: Page, target: Page | Locator): Promise<Buffer> {
  const deadline = Date.now() + SETTLE_MS;
  let last: Buffer | undefined;
  for (;;) {
    const frame = await target.screenshot({ animations: "disabled" });
    if (last?.equals(frame)) return frame;
    if (Date.now() > deadline) {
      test.info().annotations.push({ type: "warning", description: "still changing; captured" });
      return frame;
    }
    last = frame;
    await page.waitForTimeout(SETTLE_GAP_MS);
  }
}

const modes = list("GRAM_PR_SHOTS_MODES") as ShotMode[];

for (const shot of selected()) {
  for (const mode of shot.modes ?? (["dark", "light"] as const)) {
    if (modes.length > 0 && !modes.includes(mode)) continue;
    test(`${shot.name}-${mode}`, async ({ page }) => {
      test.info().annotations.push({ type: "title", description: shot.title });
      await page.emulateMedia({ colorScheme: mode, reducedMotion: "reduce" });
      await page.clock.setFixedTime(CLOCK);
      // Motion off and the shot's mode, in the theme's first-paint cache and the settings that
      // replace it once they load: `animations: "disabled"` stops CSS, not the motion library's
      // pulses and glides, and the default mode is Dark whatever the system's scheme.
      await page.addInitScript((shotMode) => {
        const cache = JSON.parse(localStorage.getItem("gram.theme") ?? '{"version":1}') as {
          state?: object;
        };
        cache.state = { ...cache.state, motion: "off", mode: shotMode };
        localStorage.setItem("gram.theme", JSON.stringify(cache));
      }, mode);
      await seedMockSettings(page, { appearance: { motion: "off", mode } });
      // A seeded Math.random, so whatever the mock or the UI draws at random draws the same.
      await page.addInitScript(() => {
        let seed = 0x5eed;
        Math.random = () => {
          seed = (seed + 0x6d2b79f5) | 0;
          let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
        };
      });
      await shot.open(page);
      await page.evaluate(() => document.fonts.ready);
      const target = shot.element?.(page) ?? page;
      writeFileSync(`${outDir}${shot.name}-${mode}.${label}.png`, await settled(page, target));
    });
  }
}
