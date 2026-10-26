import { defineConfig, devices } from "@playwright/test";

// The real-server flows: each spec file starts the bundled server with the echo fake agent over temp
// dirs and a fake `gh` (see harness.ts). One worker, since specs restart their server.
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  globalSetup: "./global-setup.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: process.env["CI"] ? "github" : "list",
  outputDir: "../test-results-real",
  use: {
    trace: "retain-on-failure",
    launchOptions: process.env["GRAM_E2E_CHROMIUM"]
      ? { executablePath: process.env["GRAM_E2E_CHROMIUM"] }
      : {},
  },
  projects: [{ name: "real-server", use: { ...devices["Desktop Chrome"] } }],
});
