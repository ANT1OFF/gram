// The Playwright run's own Vite server. It proves it's ours with a per-run token before any spec
// runs, so a free port that another checkout's server grabs can never serve the specs a stale app.
// It listens on 127.0.0.1 only and is reached there, never as `localhost`: on a dual-stack machine
// another checkout's server can hold 127.0.0.1:<port> while a `localhost` bind still gets
// ::1:<port>, and then the token check and the browser can each reach a different server.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkoutPort, findFreePort, isPortFree } from "./dev-ports.mjs";

const E2E_TOKEN_PATH = "/__e2e";
/** Where this checkout's search for a free e2e port starts; another worktree starts elsewhere. */
export const DEFAULT_E2E_PORT = checkoutPort(fileURLToPath(new URL("..", import.meta.url)));
export const E2E_HOST = "127.0.0.1";

const webDir = fileURLToPath(new URL("..", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `ours` when `/__e2e` answers with `token`, `foreign` when anything else answers, `down` when
 * nothing listens. Redirects are foreign responses and are never followed.
 */
export async function checkServer(origin, token, fetchImpl = fetch, timeoutMs = 2000) {
  let response;
  try {
    response = await fetchImpl(`${origin}${E2E_TOKEN_PATH}`, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
      redirect: "manual",
    });
  } catch {
    return "down";
  }
  const body = response.ok ? (await response.text()).trim() : "";
  return body === token ? "ours" : "foreign";
}

/** Where `buildForPreview` writes the bundle that `spawnVitePreview` serves. */
const E2E_DIST_DIR = "dist-e2e";

const MOCK_ENV = { VITE_API: "mock", VITE_MOCK_SPEED: "0.25" };

/** The Vite that `dir` installs, so another checkout's app is served by its own Vite and config. */
const viteBin = (dir = webDir) =>
  join(
    dirname(createRequire(join(dir, "package.json")).resolve("vite/package.json")),
    "bin/vite.js",
  );

/**
 * `dev` serves the sources through Vite, `preview` builds once and serves the bundle. CI previews:
 * on the Windows runner the dev server took up to 27 s per module and over two minutes to open a
 * thread. `GRAM_E2E_SERVER` chooses either.
 */
export function e2eServerMode(env = process.env) {
  const mode = env["GRAM_E2E_SERVER"];
  if (mode === "dev" || mode === "preview") return mode;
  return env["CI"] ? "preview" : "dev";
}

/**
 * Vite on `port` only, serving the mock API and answering `/__e2e` with `token`. `dir` is the
 * `apps/web` to serve: this one unless given, as `scripts/pr-shots.mjs` gives a base checkout's.
 */
export function spawnVite(port, token, env = process.env, dir = webDir, { isolatedDir } = {}) {
  return spawn(
    process.execPath,
    [
      viteBin(dir),
      "--port",
      String(port),
      "--strictPort",
      "--host",
      E2E_HOST,
      ...(isolatedDir ? ["--configLoader", "runner"] : []),
    ],
    {
      cwd: dir,
      env: {
        ...env,
        ...MOCK_ENV,
        GRAM_E2E_TOKEN: token,
        ...(isolatedDir ? { GRAM_PREVIEW_TEMP_DIR: isolatedDir } : {}),
      },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
}

/** Builds the mock-API app into `E2E_DIST_DIR`; rejects when the build fails. */
export function buildForPreview(env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [viteBin(), "build", "--outDir", E2E_DIST_DIR, "--emptyOutDir"],
      { cwd: webDir, env: { ...env, ...MOCK_ENV }, stdio: ["ignore", "ignore", "inherit"] },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`the e2e build failed (${signal ?? `exit code ${code}`})`));
    });
  });
}

/** `vite preview` of the `buildForPreview` bundle on `port` only, answering `/__e2e` with `token`. */
export function spawnVitePreview(port, token, env = process.env) {
  return spawn(
    process.execPath,
    [
      viteBin(),
      "preview",
      "--outDir",
      E2E_DIST_DIR,
      "--port",
      String(port),
      "--strictPort",
      "--host",
      E2E_HOST,
    ],
    {
      cwd: webDir,
      env: { ...env, GRAM_E2E_TOKEN: token },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
}

const exited = (child) => child.exitCode !== null || (child.signalCode ?? null) !== null;

function stopChild(child, graceMs = 5000) {
  if (exited(child)) return Promise.resolve();
  return new Promise((resolve) => {
    const force = setTimeout(() => child.kill("SIGKILL"), graceMs);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill();
  });
}

/** Polls until the server answers with our token, the child exits, or time runs out. */
async function waitForOurs(child, origin, token, { timeoutMs, pollMs, fetchImpl, checkTimeoutMs }) {
  let gone = exited(child);
  const onExit = () => {
    gone = true;
  };
  child.once("exit", onExit);
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (gone) return "exited";
      if ((await checkServer(origin, token, fetchImpl, checkTimeoutMs)) === "ours") return "ours";
      await sleep(pollMs);
    }
    return "timeout";
  } finally {
    child.off("exit", onExit);
  }
}

/**
 * Starts the e2e server and resolves once it answers `token`. A `pinnedPort` is used as is, and
 * another server there is an error. Otherwise it takes the first free port from `startPort`, and
 * when Vite can't bind (the port was taken after the probe) or never answers, tries the next one.
 * `checkTimeoutMs` bounds each token check and `stopGraceMs` how long a stopped server gets before
 * SIGKILL; tests shorten both so a run of failed attempts stays fast.
 */
export async function startE2eServer({
  token,
  pinnedPort,
  startPort = DEFAULT_E2E_PORT,
  attempts = 5,
  // Per attempt. From a cold cache Vite can take over a minute before `/__e2e` answers.
  timeoutMs = 180_000,
  pollMs = 100,
  checkTimeoutMs = 2000,
  stopGraceMs = 5000,
  spawnServer = spawnVite,
  fetchImpl = fetch,
  isFree = isPortFree,
}) {
  if (
    pinnedPort !== undefined &&
    !(Number.isInteger(pinnedPort) && pinnedPort > 0 && pinnedPort <= 65_535)
  ) {
    throw new Error(`invalid e2e port "${pinnedPort}"`);
  }
  if (pinnedPort !== undefined && !(await isFree(pinnedPort))) {
    throw new Error(
      `Couldn't start the e2e server: port ${pinnedPort} is served by another process`,
    );
  }
  const problems = [];
  let from = startPort;
  for (let attempt = 0; attempt < (pinnedPort === undefined ? attempts : 1); attempt++) {
    const port = pinnedPort ?? (await findFreePort(from, { isFree }));
    from = port + 1;
    const origin = `http://${E2E_HOST}:${port}`;
    const child = spawnServer(port, token);
    const outcome = await waitForOurs(child, origin, token, {
      timeoutMs,
      pollMs,
      fetchImpl,
      checkTimeoutMs,
    });
    if (outcome === "ours") return { port, origin, stop: () => stopChild(child, stopGraceMs) };
    await stopChild(child, stopGraceMs);
    const foreign = (await checkServer(origin, token, fetchImpl, checkTimeoutMs)) === "foreign";
    problems.push(
      foreign
        ? `port ${port} is served by another process`
        : outcome === "timeout"
          ? `the server on port ${port} didn't answer within ${timeoutMs / 1000}s`
          : `the server on port ${port} exited before it was ready`,
    );
  }
  throw new Error(`Couldn't start the e2e server: ${problems.join("; ")}`);
}
