import { defineConfig, devices } from "@playwright/test";

// `scripts/pr-shots.mjs` runs this, once on the working tree and once on the PR's base, to capture
// before/after images for a PR description. CI never runs it: the e2e config's `testDir` is `e2e/`.

const port = process.env["GRAM_PR_SHOTS_PORT"] ?? "5194";

export default defineConfig({
  testDir: ".",
  testMatch: "capture.spec.ts",
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
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: "en-US",
    timezoneId: "Europe/Oslo",
    reducedMotion: "reduce",
    actionTimeout: 15_000,
    navigationTimeout: 60_000,
  },
});
