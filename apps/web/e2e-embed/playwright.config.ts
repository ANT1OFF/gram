import { defineConfig, devices } from "@playwright/test";

// The embeddable package's acceptance run. `global-setup.ts` builds the package and a separate app
// that consumes it, serves that app, and sets `GRAM_EMBED_E2E_ORIGIN` before the workers load this.
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  globalSetup: "./global-setup.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env["CI"] ? 1 : 0,
  outputDir: "../test-results-embed",
  reporter: process.env["CI"]
    ? [["github"], ["html", { open: "never", outputFolder: "../playwright-report-embed" }]]
    : [["list"]],
  use: {
    baseURL: process.env["GRAM_EMBED_E2E_ORIGIN"] ?? "http://127.0.0.1:0",
    trace: "retain-on-failure",
    launchOptions: process.env["GRAM_E2E_CHROMIUM"]
      ? { executablePath: process.env["GRAM_E2E_CHROMIUM"] }
      : {},
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
