import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { findFreePort, isPortFree } from "./dev-ports.mjs";
import { checkServer, e2eServerMode, startE2eServer } from "./e2e-server.mjs";

const TOKEN = "run-token";
const servers = [];

/**
 * Where the port-race test works: below every OS's ephemeral range, so a search that starts past the
 * foreign server's port can't run off 65535, as it could when the OS picked a port near the top.
 */
const LOW_PORTS = 21_000;

/** An HTTP server with a fixed body or request handler, on `port` (a fresh one by default). */
const serve = (body, status = 200, port = 0, host = "127.0.0.1") =>
  new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (typeof body === "function") return body(req, res);
      res.statusCode = status;
      res.end(body);
    });
    servers.push(server);
    server.once("error", reject);
    server.listen({ port, host }, () => resolve(server.address().port));
  });

const closeAll = () =>
  Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(() => resolve()))));

afterEach(closeAll);

/**
 * Stands in for Vite: binds `port` exclusively (exiting like `--strictPort` when it's taken) and
 * answers `/__e2e` with `token` after `delayMs`.
 */
const fakeVite =
  (token, { delayMs = 0 } = {}) =>
  (port) => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    const server = createServer((req, res) => {
      setTimeout(() => res.end(req.url === "/__e2e" ? token : "app"), delayMs);
    });
    const exit = (code) => {
      child.exitCode = code;
      child.emit("exit", code);
    };
    server.once("error", () => exit(1));
    server.listen({ port, host: "127.0.0.1", exclusive: true });
    child.kill = () => {
      server.close(() => exit(0));
      return true;
    };
    return child;
  };

describe("checkServer", () => {
  it("tells our server from another one and from nothing at all", async () => {
    const ours = await serve(TOKEN);
    const other = await serve("<!doctype html>another app");
    const missing = await serve("not found", 404);
    expect(await checkServer(`http://127.0.0.1:${ours}`, TOKEN)).toBe("ours");
    expect(await checkServer(`http://127.0.0.1:${other}`, TOKEN)).toBe("foreign");
    expect(await checkServer(`http://127.0.0.1:${missing}`, TOKEN)).toBe("foreign");
    await closeAll();
    expect(await checkServer(`http://127.0.0.1:${ours}`, TOKEN)).toBe("down");
  });
});

describe("startE2eServer", () => {
  it("never follows a foreign redirect when a pinned port is taken after the probe", async () => {
    let destinationHits = 0;
    let redirectHits = 0;
    const destination = await serve((_req, res) => {
      destinationHits++;
      res.end(TOKEN);
    });
    const taken = await serve((_req, res) => {
      redirectHits++;
      res.writeHead(302, { Location: `http://127.0.0.1:${destination}/token` });
      res.end();
    });
    let child;
    let failure;
    let started;
    try {
      started = await startE2eServer({
        token: TOKEN,
        pinnedPort: taken,
        pollMs: 10,
        timeoutMs: 5000,
        isFree: async () => true,
        spawnServer: (port) => (child = fakeVite(TOKEN)(port)),
      });
    } catch (error) {
      failure = error;
    } finally {
      await started?.stop();
    }
    expect(redirectHits).toBeGreaterThan(0);
    expect(destinationHits).toBe(0);
    expect(failure?.message).toContain(`port ${taken} is served by another process`);
    expect(child.exitCode).toBe(1);
    // The failed attempt only owns its child; both unrelated listeners survive.
    expect(await isPortFree(taken)).toBe(false);
    expect(await isPortFree(destination)).toBe(false);
  });

  it("moves past a port another server took after the probe said it was free", async () => {
    const taken = await serve("another checkout's vite", 200, await findFreePort(LOW_PORTS));
    const server = await startE2eServer({
      token: TOKEN,
      startPort: taken,
      pollMs: 10,
      timeoutMs: 5000,
      spawnServer: fakeVite(TOKEN),
      // The race: the probe ran before the foreign server bound.
      isFree: async (port) => port === taken || isPortFree(port),
    });
    try {
      expect(server.port).not.toBe(taken);
      expect(await checkServer(server.origin, TOKEN)).toBe("ours");
    } finally {
      await server.stop();
    }
    expect(await checkServer(server.origin, TOKEN)).toBe("down");
  });

  it("serves the run on 127.0.0.1, out of reach of a server on the other loopback family", async () => {
    // Another checkout's server holds ::1 on the port; a `localhost` bind would land beside it and
    // leave the browser's `localhost` to pick either one.
    const port = await findFreePort(LOW_PORTS);
    let ipv6 = true;
    await serve("another checkout's vite", 200, port, "::1").catch(() => (ipv6 = false));
    const server = await startE2eServer({
      token: TOKEN,
      pinnedPort: port,
      pollMs: 10,
      timeoutMs: 5000,
      isFree: async () => true,
      spawnServer: fakeVite(TOKEN),
    });
    try {
      expect(server.origin).toBe(`http://127.0.0.1:${port}`);
      expect(await checkServer(server.origin, TOKEN)).toBe("ours");
      if (ipv6) expect(await checkServer(`http://[::1]:${port}`, TOKEN)).toBe("foreign");
    } finally {
      await server.stop();
    }
  });

  it("refuses a pinned port another process serves, saying so", async () => {
    const taken = await serve("another checkout's vite");
    await expect(
      startE2eServer({
        token: TOKEN,
        pinnedPort: taken,
        pollMs: 10,
        timeoutMs: 5000,
        spawnServer: fakeVite(TOKEN),
      }),
    ).rejects.toThrow(`port ${taken} is served by another process`);
  });

  // Each failed attempt waits out `timeoutMs`, a token check and a stop, all shortened here to about
  // a second in all; the timeout leaves room for a loaded runner.
  it("gives up on a server that never answers with the token", async () => {
    await expect(
      startE2eServer({
        token: TOKEN,
        attempts: 2,
        pollMs: 10,
        timeoutMs: 200,
        checkTimeoutMs: 200,
        stopGraceMs: 200,
        spawnServer: fakeVite("someone-else"),
      }),
    ).rejects.toThrow(/Couldn't start the e2e server: .*didn't answer.*; .*didn't answer/);
  }, 15_000);

  it("rejects an invalid pinned port", async () => {
    await expect(startE2eServer({ token: TOKEN, pinnedPort: 70_000 })).rejects.toThrow(
      'invalid e2e port "70000"',
    );
  });
});

describe("e2eServerMode", () => {
  it("previews on CI and serves the sources locally, unless the env picks one", () => {
    expect(e2eServerMode({ CI: "true" })).toBe("preview");
    expect(e2eServerMode({})).toBe("dev");
    expect(e2eServerMode({ CI: "true", GRAM_E2E_SERVER: "dev" })).toBe("dev");
    expect(e2eServerMode({ GRAM_E2E_SERVER: "preview" })).toBe("preview");
    expect(e2eServerMode({ GRAM_E2E_SERVER: "other" })).toBe("dev");
  });
});
