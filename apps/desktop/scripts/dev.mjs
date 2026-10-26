#!/usr/bin/env node
// Desktop dev loop: the web app's Vite dev server, proxying `/ws` and `/?boot` to the server's dev
// port, then electron-vite dev. Main starts the server itself and opens the boot URL on the Vite
// origin, so the launch token is exchanged for the auth cookie there (the same flow as
// apps/web/scripts/dev.mjs, with Electron in place of the browser).
//
// Ports: `GRAM_PORT` (server) and `GRAM_WEB_PORT` (Vite) when set; otherwise the first
// free ports from 4317 / 5173, picked with the same helper as the web dev loop.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import {
  DEFAULT_SERVER_PORT,
  DEFAULT_WEB_PORT,
  resolvePort,
} from "../../web/scripts/dev-ports.mjs";

const serverPort = String(await resolvePort(process.env.GRAM_PORT, DEFAULT_SERVER_PORT));
const webPort = await resolvePort(process.env.GRAM_WEB_PORT, DEFAULT_WEB_PORT);
const WEB_URL = process.env.GRAM_WEB_URL ?? `http://localhost:${webPort}`;

const env = {
  ...process.env,
  GRAM_WEB_URL: WEB_URL,
  GRAM_PORT: serverPort,
  GRAM_DEV_SERVER_PORT: serverPort,
  // Real Claude by default; `GRAM_FAKE_AGENT=1` opts into the echo fake.
  GRAM_FAKE_AGENT: process.env.GRAM_FAKE_AGENT ?? "0",
  GRAM_FAKE_AGENT_REPLY: process.env.GRAM_FAKE_AGENT_REPLY ?? "echo",
  // Unminified main and preload, with comments (shipped-code.ts).
  GRAM_READABLE_BUNDLES: "1",
};

const children = new Set();
let stopping = false;

function run(label, args) {
  const child = spawn("bun", args, { env, stdio: "inherit", shell: process.platform === "win32" });
  children.add(child);
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (stopping) return;
    console.error(`[dev] ${label} exited (${code ?? signal}); stopping`);
    stop(code ?? 1);
  });
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 3000).unref();
  const poll = setInterval(() => {
    if (children.size > 0) return;
    clearInterval(poll);
    process.exit(code);
  }, 50);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error(`${url} didn't respond within ${timeoutMs / 1000}s`);
}

run("vite", ["run", "--filter", "@gram/web", "dev:web", "--port", String(webPort), "--strictPort"]);
console.log(`Gram dev: ${WEB_URL}/ (server 127.0.0.1:${serverPort}, Electron)`);
try {
  await waitFor(WEB_URL, 30_000);
} catch (error) {
  console.error(`[dev] ${error.message}`);
  stop(1);
}
if (!stopping) run("electron", ["run", "electron-vite", "dev"]);
