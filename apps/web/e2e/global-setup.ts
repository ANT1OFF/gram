import { randomUUID } from "node:crypto";

import { chromium, type Page } from "@playwright/test";

import {
  buildForPreview,
  e2eServerMode,
  spawnVite,
  spawnVitePreview,
  startE2eServer,
} from "../scripts/e2e-server.mjs";

/** Generous, because from a cold cache Vite bundles every dependency before the first page loads. */
const WARM_UP_TIMEOUT_MS = 180_000;

/** The routes specs open, each with what marks it ready. */
const WARM_UP_ROUTES: ReadonlyArray<{ path: string; ready: (page: Page) => Promise<void> }> = [
  { path: "/", ready: (page) => page.getByTestId("app-shell").waitFor() },
  { path: "/t/t-flaky", ready: (page) => page.getByLabel("Message", { exact: true }).waitFor() },
  { path: "/new", ready: (page) => page.getByRole("form", { name: "New thread" }).waitFor() },
  { path: "/new-task", ready: (page) => page.getByRole("form", { name: "New task" }).waitFor() },
  { path: "/new-workspace", ready: (page) => page.getByTestId("new-workspace").waitFor() },
  { path: "/settings", ready: (page) => page.getByTestId("general-settings").waitFor() },
  ...[
    "notifications",
    "terminal",
    "agents",
    "workspaces",
    "gateways",
    "ai-helpers",
    "review-bots",
    "appearance",
    "keyboard",
    "voice-input",
    "updates",
    "diagnostics",
    "help",
  ].map((tab) => ({
    path: `/settings/${tab}`,
    ready: (page: Page) => page.locator("[data-settings-results] h2").first().waitFor(),
  })),
  // The mock has no workspace at load, and the memory module is what needs warming, so any id does.
  { path: "/w/w-warm-up/memory", ready: (page) => page.getByTestId("memory-missing").waitFor() },
  {
    path: "/settings/connectors",
    ready: (page) => page.getByTestId("connectors-settings").waitFor(),
  },
];

/**
 * Loads each route once before any spec runs. Vite answers `/__e2e` before its dependency bundle and
 * the app's modules are ready, so from a cold cache the first specs' navigations paid for them and
 * overran the test timeout.
 */
async function warmUp(origin: string): Promise<void> {
  const browser = await chromium.launch(
    process.env["GRAM_E2E_CHROMIUM"] ? { executablePath: process.env["GRAM_E2E_CHROMIUM"] } : {},
  );
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(WARM_UP_TIMEOUT_MS);
    for (const route of WARM_UP_ROUTES) {
      try {
        await page.goto(`${origin}${route.path}`, { timeout: WARM_UP_TIMEOUT_MS });
        await route.ready(page);
      } catch (cause) {
        throw new Error(`Warm-up failed for ${route.path} (at ${new URL(page.url()).pathname})`, {
          cause,
        });
      }
    }
  } finally {
    await browser.close();
  }
}

/**
 * Starts this run's own Vite server before any spec and proves it with a random token, so specs
 * never run against another checkout's server. Workers read the verified port from the env.
 * `GRAM_E2E_PORT` set up front pins the port instead of picking a free one.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const env = process.env;
  const pinned = env["GRAM_E2E_PORT"];
  const token = randomUUID();
  const preview = e2eServerMode() === "preview";
  if (preview) await buildForPreview();
  const server = await startE2eServer({
    token,
    spawnServer: preview ? spawnVitePreview : spawnVite,
    ...(pinned ? { pinnedPort: Number(pinned) } : {}),
  });
  env["GRAM_E2E_PORT"] = String(server.port);
  env["GRAM_E2E_TOKEN"] = token;
  try {
    await warmUp(server.origin);
  } catch (error) {
    await server.stop();
    throw error;
  }
  return () => server.stop();
}
