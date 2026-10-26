// Port picking for the dev loops (apps/web and apps/desktop `scripts/dev.mjs`), so a second checkout
// or a leftover dev server never makes `bun run dev` fail with EADDRINUSE.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { createServer } from "node:net";

export const DEFAULT_SERVER_PORT = 4317;
export const DEFAULT_WEB_PORT = 5173;

const tryListen = (port, host) =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", (error) => {
      // No IPv6 on this machine: nothing can be listening there either.
      resolve(error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT");
    });
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve(true)));
  });

/** Nothing listens on `port` under either loopback address (`localhost` can resolve to ::1). */
export async function isPortFree(port) {
  return (await tryListen(port, "127.0.0.1")) && (await tryListen(port, "::1"));
}

/** The first free port from `start`, trying `attempts` ports. */
export async function findFreePort(start, { attempts = 50, isFree = isPortFree } = {}) {
  for (let port = start; port < start + attempts && port <= 65_535; port++) {
    if (await isFree(port)) return port;
  }
  throw new Error(`no free port in ${start}–${start + attempts - 1}`);
}

/** An explicit env value wins (and must be a valid port); otherwise the first free port. */
export async function resolvePort(envValue, defaultPort, options) {
  if (envValue !== undefined && envValue !== "") {
    const port = Number(envValue);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`invalid port "${envValue}"`);
    }
    return port;
  }
  return findFreePort(defaultPort, options);
}

/** `GRAM_ALLOWED_ORIGINS` for a Vite origin, under both loopback host names. */
export const webOrigins = (webPort) => `http://localhost:${webPort},http://127.0.0.1:${webPort}`;

/** The server's boot URL moved onto the Vite origin, so the auth cookie lands there. */
export function devBootUrl(serverBootUrl, webPort) {
  const token = new URL(serverBootUrl).searchParams.get("boot") ?? "";
  return `http://localhost:${webPort}/?boot=${token}`;
}

/**
 * A port of `dir`'s own in [`base`, `base + slots * stride`): a stable hash of its real path, so
 * worktrees of one repository start their searches far apart instead of all racing for the same
 * first free port. `stride` leaves each checkout room to move past a few taken ports.
 */
export function checkoutPort(dir, { base = 20_000, slots = 1000, stride = 8 } = {}) {
  let path = dir;
  try {
    path = realpathSync(dir);
  } catch {
    // A missing directory still gets a stable port from its spelling.
  }
  const hash = createHash("sha256").update(path).digest().readUInt32BE(0);
  return base + (hash % slots) * stride;
}
