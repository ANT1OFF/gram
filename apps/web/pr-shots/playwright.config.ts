import { defineConfig, devices } from "@playwright/test";

// `scripts/pr-shots.mjs` runs this, once on the working tree and once on the PR's base, to capture
// before/after images for a PR description. CI never runs it: the e2e config's `testDir` is `e2e/`.

const port = process.env["GRAM_PR_SHOTS_PORT"] ?? "5194";
// A phone-sized `--size` captures as a phone: a touch screen, which Gram's phone layout keys on.
const sizeWidth = Number((process.env["GRAM_PR_SHOTS_SIZE"] || "1728x1095").split("x")[0]);
const phone = sizeWidth > 0 && sizeWidth < 640;

export default defineConfig({
  testDir: ".",
  testMatch: process.env["GRAM_PR_SHOTS_SET"] === "tasks" ? "tasks.spec.ts" : "capture.spec.ts",
  globalSetup: "./global-setup.ts",
  outputDir: "../test-results/pr-shots",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["json", { outputFile: "out/.results.json" }]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://localhost:${port}`,
    // The tour and flows resize to `--size` (default 1728 × 1095, a real window) once a shot has
    // opened; every shot captures at 2×, as a Retina screen shows it.
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    hasTouch: phone,
    locale: "en-US",
    timezoneId: "Europe/Oslo",
    reducedMotion: "reduce",
    actionTimeout: 15_000,
    navigationTimeout: 60_000,
  },
});
