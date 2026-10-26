import { defineConfig, devices } from "@playwright/test";

import { slowdown } from "./e2e/slowdown";
import { DEFAULT_E2E_PORT, E2E_HOST } from "./scripts/e2e-server.mjs";

// `e2e/global-setup.ts` starts the run's own Vite server, checks that its `/__e2e` endpoint answers
// with this run's token, and sets `GRAM_E2E_PORT` before the workers load this config.
// Reached on 127.0.0.1, where it listens, never as `localhost` (see `scripts/e2e-server.mjs`).
const port = process.env["GRAM_E2E_PORT"] ?? String(DEFAULT_E2E_PORT);

/**
 * The specs that render hardest without a GPU. Two of them on one Windows runner starved each other
 * (a 125 s navigation), so CI runs them in their own job one at a time.
 */
const HEAVY = [
  "depth",
  "diff-review",
  "glass-gutters",
  "grid",
  "grid-ergonomics",
  "light-mode",
  "looks",
  "looks-audit-2",
  "multiwindow",
  "panel-expand",
  "perf-shell",
  "settings-flicker",
].map((name) => `**/${name}.spec.ts`);

/** `GRAM_E2E_SET=heavy` runs only `HEAVY`, `light` everything else; unset or empty runs everything. */
const set = process.env["GRAM_E2E_SET"] || undefined;
if (set !== undefined && set !== "heavy" && set !== "light") {
  throw new Error(`GRAM_E2E_SET must be "heavy" or "light", not "${set}"`);
}

export default defineConfig({
  testDir: "e2e",
  ...(set === "heavy" ? { testMatch: HEAVY } : set === "light" ? { testIgnore: HEAVY } : {}),
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  timeout: 30_000 * slowdown,
  expect: { timeout: 5_000 * slowdown },
  retries: process.env["CI"] ? 1 : 0,
  // Keep small per-spec timings on successful runs too, so shard balance stays measurable.
  reporter: process.env["CI"]
    ? [["github"], ["html", { open: "never" }], ["./scripts/e2e-timings.mjs"]]
    : [["list"], ["./scripts/e2e-timings.mjs"]],
  use: {
    baseURL: `http://${E2E_HOST}:${port}`,
    trace: "retain-on-failure",
    launchOptions: process.env["GRAM_E2E_CHROMIUM"]
      ? { executablePath: process.env["GRAM_E2E_CHROMIUM"] }
      : {},
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
