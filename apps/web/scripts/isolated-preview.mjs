// A disposable browser for the existing dev:mock UI. No server database or agent CLI is started.
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

import { spawnVite, startE2eServer } from "./e2e-server.mjs";

export const HELP = `Usage: bun run dev:preview [--capture] [--port 5180] [--path /new]
  [--account ready|signed-out|unknown] [--output /tmp/new-evidence-directory]
  [--chromium /path/to/chromium]

Opens the existing mock UI in a fresh Chromium context. Close the browser or press
Ctrl-C to stop. --capture takes a headless screenshot and exits. Evidence is kept
in the printed directory; temporary home/cache/browser state is always removed.
An explicit port must be free. Otherwise a free port is selected from 5180.
Uses the installed Playwright browser; never downloads one automatically.`;

/** Allowlist, rather than passing provider keys, proxy variables or dev server settings onward. */
export function previewEnv(root, source = process.env) {
  const home = join(root, "home");
  const temp = join(root, "tmp");
  for (const path of [home, temp]) mkdirSync(path, { recursive: true });
  return {
    // Needed by OS utilities and Chromium on Windows; no agent CLI is invoked.
    ...(source.SystemRoot ? { SystemRoot: source.SystemRoot } : {}),
    ...(source.WINDIR ? { WINDIR: source.WINDIR } : {}),
    ...(source.DISPLAY ? { DISPLAY: source.DISPLAY } : {}),
    ...(source.WAYLAND_DISPLAY ? { WAYLAND_DISPLAY: source.WAYLAND_DISPLAY } : {}),
    PATH:
      process.platform === "win32"
        ? dirname(process.execPath)
        : `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
  };
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: args.filter((arg) => arg !== "--"),
    options: {
      capture: { type: "boolean", default: false },
      port: { type: "string" },
      path: { type: "string", default: "/new" },
      account: { type: "string", default: "ready" },
      output: { type: "string" },
      chromium: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return console.log(HELP);
  if (!["ready", "signed-out", "unknown"].includes(values.account))
    throw new Error("--account must be ready, signed-out or unknown");
  if (!values.path.startsWith("/") || values.path.startsWith("//") || values.path.includes("\\"))
    throw new Error("--path must be a local route such as /new");
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port <= 65535))
    throw new Error("--port must be an integer from 1 to 65535");

  // An explicit evidence directory must be new: never overwrite or clean another run's files.
  const output = values.output
    ? resolve(values.output)
    : mkdtempSync(join(tmpdir(), "gram-preview-evidence-"));
  if (values.output) mkdirSync(output, { recursive: false });
  const root = mkdtempSync(join(tmpdir(), "gram-preview-state-"));
  const env = previewEnv(root);
  const token = randomUUID();
  let child, server, browser, page;
  let ready = false;
  let interrupted = false;
  let finish;
  const closed = new Promise((onClosed) => {
    finish = onClosed;
  });
  const stop = () => {
    interrupted = true;
    finish();
    // Startup may still be waiting for the token; kill only the child we spawned.
    if (!server && child?.exitCode === null && child?.signalCode === null) child.kill();
    if (browser && !ready) void browser.close().catch(() => {});
  };
  // A script runner/terminal can forward the same signal more than once while cleanup awaits.
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
  const eventsFile = join(output, "browser.jsonl");
  let eventBytes = 0;
  const evidence = (event) => {
    const line = `${JSON.stringify(event)}\n`;
    if ((eventBytes += Buffer.byteLength(line)) <= 1_000_000) appendFileSync(eventsFile, line);
  };
  let metadata = { kind: "browser-mock", account: values.account, stateDir: root, cleaned: false };
  const save = () =>
    writeFileSync(join(output, "preview.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  save();
  console.log(`Evidence: ${output}`);
  try {
    server = await startE2eServer({
      token,
      startPort: 5180,
      ...(port === undefined ? {} : { pinnedPort: port }),
      spawnServer: (selectedPort, runToken) => {
        if (interrupted) throw new Error("preview interrupted during startup");
        child = spawnVite(selectedPort, runToken, env, undefined, { isolatedDir: root });
        return child;
      },
    });
    if (interrupted) throw new Error("preview interrupted during startup");
    metadata = { ...metadata, origin: server.origin, vitePid: child.pid };
    save();
    console.log(`Mock UI: ${server.origin}${values.path} (owned Vite PID ${child.pid})`);
    browser = await chromium.launch({
      headless: values.capture,
      env,
      // Playwright's SIGINT handler exits the launcher, bypassing our Vite/state cleanup.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      ...(values.chromium ? { executablePath: resolve(values.chromium) } : {}),
    });
    browser.once("disconnected", finish);
    if (interrupted) throw new Error("preview interrupted during browser startup");
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      serviceWorkers: "block",
    });
    // Prevent accidental off-machine requests from a UI route or an opened link.
    await context.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === server.origin) return route.continue();
      evidence({ kind: "blocked-request", url: route.request().url() });
      return route.abort("blockedbyclient");
    });
    await context.routeWebSocket("**/*", (socket) => {
      const url = new URL(socket.url());
      url.protocol = url.protocol === "wss:" ? "https:" : "http:";
      if (url.origin === server.origin) socket.connectToServer();
      else {
        evidence({ kind: "blocked-websocket", url: socket.url() });
        void socket.close();
      }
    });
    await context.addInitScript((account) => {
      if (!sessionStorage.getItem("gram.preview.seeded")) {
        sessionStorage.setItem("gram.mock.agents", "claude,codex");
        sessionStorage.setItem(
          "gram.mock.settings",
          JSON.stringify({ onboarding: { welcomeSeen: true } }),
        );
        const signIn =
          account === "ready" ? "signedIn" : account === "signed-out" ? "notSignedIn" : "unknown";
        sessionStorage.setItem(
          "gram.mock.launchChecks",
          JSON.stringify({
            claudeSignIn: signIn,
            codexSignIn: signIn,
            ghSignedIn: account === "ready",
          }),
        );
        sessionStorage.setItem("gram.preview.seeded", "1");
      }
    }, values.account);
    page = await context.newPage();
    page.on("console", (msg) => evidence({ kind: "console", level: msg.type(), text: msg.text() }));
    page.on("pageerror", (error) => evidence({ kind: "pageerror", message: error.message }));
    page.on("requestfailed", (request) =>
      evidence({ kind: "requestfailed", url: request.url(), failure: request.failure() }),
    );
    page.once("close", finish);
    await page.goto(`${server.origin}${values.path}`, { timeout: 180_000 });
    await page.getByTestId("app-shell").waitFor({ timeout: 180_000 });
    await page.waitForFunction(() => Boolean(window.gramMock), null, { timeout: 180_000 });
    // A ready route has replaced the Suspense placeholder. Let web fonts finish for the image.
    await page.locator("main").waitFor({ timeout: 180_000 });
    if (new URL(page.url()).pathname === "/new")
      await page.getByRole("form", { name: "New thread" }).waitFor({ timeout: 180_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(output, "initial.png"), fullPage: true });
    metadata = { ...metadata, url: page.url(), screenshot: "initial.png" };
    ready = true;
    save();
    if (!values.capture && !interrupted) {
      console.log(
        "Press Ctrl-C to capture final.png and clean up; closing the window also cleans up.",
      );
      await closed;
    }
    if (!page.isClosed() && browser.isConnected())
      await page.screenshot({ path: join(output, "final.png"), fullPage: true });
    if (interrupted) process.exitCode = 130;
  } catch (error) {
    metadata = { ...metadata, error: error.message };
    if (!interrupted) throw error;
    process.exitCode = 130;
  } finally {
    try {
      await browser?.close();
    } finally {
      await server?.stop();
      rmSync(root, { recursive: true, force: true });
      metadata = { ...metadata, cleaned: true };
      save();
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      process.off("SIGHUP", stop);
      console.log(`Cleaned owned preview resources. Evidence retained: ${output}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(`dev:preview: ${error.message}`);
    process.exitCode ||= 1;
  });
