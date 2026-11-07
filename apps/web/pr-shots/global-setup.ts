import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { chromium } from "@playwright/test";

import { previewEnv } from "../scripts/isolated-preview.mjs";
import { spawnVite, startE2eServer } from "../scripts/e2e-server.mjs";

/** Generous, because a fresh base checkout's Vite bundles every dependency before the first page. */
const WARM_UP_TIMEOUT_MS = 180_000;

/**
 * Starts Vite on the mock API for the `apps/web` in `GRAM_PR_SHOTS_WEB_DIR` (this one unless
 * set), proves it with a token as the e2e setup does, and loads the shell and a thread once so the
 * first shot doesn't pay for the cold bundle. Workers read the port from the env.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const dir = process.env["GRAM_PR_SHOTS_WEB_DIR"] || undefined;
  const token = randomUUID();
  const isolatedDir =
    process.env["GRAM_PR_SHOTS_SET"] === "tasks"
      ? mkdtempSync(join(tmpdir(), "gram-rating-"))
      : undefined;
  const serverEnv = isolatedDir ? previewEnv(isolatedDir) : process.env;
  const clean = () => {
    if (isolatedDir) rmSync(isolatedDir, { recursive: true, force: true });
  };
  const server = await startE2eServer({
    token,
    startPort: 5194,
    spawnServer: (port, key) =>
      spawnVite(port, key, serverEnv, dir, isolatedDir ? { isolatedDir } : {}),
  }).catch((error) => {
    clean();
    throw error;
  });
  process.env["GRAM_PR_SHOTS_PORT"] = String(server.port);
  try {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(server.origin, { timeout: WARM_UP_TIMEOUT_MS });
      await page.getByTestId("app-shell").waitFor({ timeout: WARM_UP_TIMEOUT_MS });
      // A thread too: its route is a split chunk Vite only builds on first visit, which under
      // load took longer than a shot's wait, so the first shot to open a thread found none.
      await page.goto(`${server.origin}/t/t-deps`, { timeout: WARM_UP_TIMEOUT_MS });
      await page.getByTestId("thread-view").waitFor({ timeout: WARM_UP_TIMEOUT_MS });
    } finally {
      await browser.close();
    }
  } catch (error) {
    try {
      await server.stop();
    } finally {
      clean();
    }
    throw error;
  }
  return async () => {
    try {
      await server.stop();
    } finally {
      clean();
    }
  };
}
