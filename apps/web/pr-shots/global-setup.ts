import { randomUUID } from "node:crypto";

import { chromium } from "@playwright/test";

import { spawnVite, startE2eServer } from "../scripts/e2e-server.mjs";

/** Generous, because a fresh base checkout's Vite bundles every dependency before the first page. */
const WARM_UP_TIMEOUT_MS = 180_000;

/**
 * Starts Vite on the mock API for the `apps/web` in `GRAM_PR_SHOTS_WEB_DIR` (this one unless
 * set), proves it with a token as the e2e setup does, and loads the shell once so the first shot
 * doesn't pay for the cold bundle. Workers read the port from the env.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const dir = process.env["GRAM_PR_SHOTS_WEB_DIR"] || undefined;
  const token = randomUUID();
  const server = await startE2eServer({
    token,
    startPort: 5194,
    spawnServer: (port, key) => spawnVite(port, key, process.env, dir),
  });
  process.env["GRAM_PR_SHOTS_PORT"] = String(server.port);
  try {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(server.origin, { timeout: WARM_UP_TIMEOUT_MS });
      await page.getByTestId("app-shell").waitFor({ timeout: WARM_UP_TIMEOUT_MS });
    } finally {
      await browser.close();
    }
  } catch (error) {
    await server.stop();
    throw error;
  }
  return () => server.stop();
}
