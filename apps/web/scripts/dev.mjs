#!/usr/bin/env node
// Dev loop: the headless server plus Vite. Vite proxies `/ws` and the boot navigation to the
// server, so opening the boot URL on the Vite origin exchanges the launch token for the auth cookie
// there. Flags: `--no-open` prints the full boot URL instead of opening a browser.
//
// Ports: `GRAM_PORT` (server) and `GRAM_WEB_PORT` (Vite) when set; otherwise the first
// free ports from 4317 / 5173, so another checkout's dev servers don't collide.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_SERVER_PORT,
  DEFAULT_WEB_PORT,
  devBootUrl,
  resolvePort,
  webOrigins,
} from "./dev-ports.mjs";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..");
// Only an interactive terminal opens a browser: never scripts, agents, CI or GRAM_NO_OPEN=1.
const autoOpen =
  !process.argv.includes("--no-open") &&
  process.stdout.isTTY === true &&
  !process.env.CI &&
  process.env.GRAM_NO_OPEN !== "1";
const isWindows = process.platform === "win32";

const serverPort = await resolvePort(process.env.GRAM_PORT, DEFAULT_SERVER_PORT);
const webPort = await resolvePort(process.env.GRAM_WEB_PORT, DEFAULT_WEB_PORT);

const serverEnv = {
  GRAM_PORT: String(serverPort),
  GRAM_ALLOWED_ORIGINS: process.env.GRAM_ALLOWED_ORIGINS ?? webOrigins(webPort),
  GRAM_FAKE_AGENT: process.env.GRAM_FAKE_AGENT ?? "1",
  // The fake agent completes each turn with an echo reply, so the UI flows run end to end.
  GRAM_FAKE_AGENT_REPLY: process.env.GRAM_FAKE_AGENT_REPLY ?? "echo",
};

const children = new Set();
let stopping = false;

function start(label, args, env, stdio) {
  const child = spawn("bun", args, {
    cwd: webDir,
    env: { ...process.env, ...env },
    stdio,
    shell: isWindows,
  });
  children.add(child);
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (stopping) return;
    console.error(`[dev] ${label} exited (${code ?? signal}); stopping`);
    stop(code ?? 1);
  });
  return child;
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  const force = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
    process.exit(code);
  }, 3000);
  force.unref();
  const poll = setInterval(() => {
    if (children.size === 0) {
      clearInterval(poll);
      process.exit(code);
    }
  }, 50);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

function openBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : isWindows
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
}

let vite;
const server = start("server", ["run", "--filter", "@gram/server", "dev"], serverEnv, [
  "ignore",
  "pipe",
  "inherit",
]);

let buffered = "";
server.stdout.on("data", (data) => {
  buffered += data.toString();
  let newline;
  while ((newline = buffered.indexOf("\n")) !== -1) {
    const line = buffered.slice(0, newline).trimEnd();
    buffered = buffered.slice(newline + 1);
    // `bun run --filter` prefixes child output with "<package> <script>: ", so match the boot
    // line with or without that prefix.
    const bootMatch = /^(?:\S+ \S+: )?boot (\S+)$/.exec(line);
    if (!bootMatch) {
      console.log(line);
      continue;
    }
    const bootLine = bootMatch[1];
    const boot = new URL(bootLine);
    const url = devBootUrl(bootLine, webPort);
    // The launch token grants API access; it's never logged in full.
    const token = boot.searchParams.get("boot") ?? "";
    console.log(`[dev] server up on 127.0.0.1:${boot.port} (token ${token.slice(0, 6)}…)`);
    if (!vite) {
      vite = start(
        "vite",
        ["run", "dev:web", "--port", String(webPort), "--strictPort"],
        { GRAM_DEV_SERVER_PORT: boot.port },
        "inherit",
      );
      console.log(`Gram dev: http://localhost:${webPort}/ (server 127.0.0.1:${boot.port})`);
    } else {
      console.log(
        "[dev] server restarted with a new launch token; reload through the new boot URL",
      );
    }
    if (autoOpen) openBrowser(url);
    else console.log(`[dev] open ${url}`);
  }
});
