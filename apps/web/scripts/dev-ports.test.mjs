import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  checkoutPort,
  devBootUrl,
  findFreePort,
  isPortFree,
  resolvePort,
  webOrigins,
} from "./dev-ports.mjs";

const servers = [];
const occupy = () =>
  new Promise((resolve) => {
    const server = createServer();
    servers.push(server);
    server.listen({ port: 0, host: "127.0.0.1" }, () => resolve(server.address().port));
  });

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

describe("isPortFree", () => {
  it("reports a listening port as taken and a released one as free", async () => {
    const port = await occupy();
    expect(await isPortFree(port)).toBe(false);
    await new Promise((r) => servers.pop().close(r));
    expect(await isPortFree(port)).toBe(true);
  });
});

describe("findFreePort", () => {
  it("skips taken ports", async () => {
    const taken = new Set([4317, 4318]);
    const port = await findFreePort(4317, { isFree: async (p) => !taken.has(p) });
    expect(port).toBe(4319);
  });

  it("gives up after the attempt budget", async () => {
    await expect(findFreePort(5173, { attempts: 3, isFree: async () => false })).rejects.toThrow(
      "no free port in 5173–5175",
    );
  });

  it("finds a real free port next to a taken one", async () => {
    const port = await occupy();
    const found = await findFreePort(port);
    expect(found).toBeGreaterThan(port);
    expect(await isPortFree(found)).toBe(true);
  });
});

describe("resolvePort", () => {
  it("honours an explicit env port without probing", async () => {
    expect(await resolvePort("4400", 4317, { isFree: async () => false })).toBe(4400);
  });

  it("rejects an invalid env port", async () => {
    await expect(resolvePort("nope", 4317)).rejects.toThrow('invalid port "nope"');
    await expect(resolvePort("70000", 4317)).rejects.toThrow("invalid port");
  });

  it("falls back to the first free port when unset", async () => {
    expect(await resolvePort(undefined, 5173, { isFree: async (p) => p !== 5173 })).toBe(5174);
    expect(await resolvePort("", 5173, { isFree: async () => true })).toBe(5173);
  });
});

describe("dev URLs", () => {
  it("moves the boot token onto the Vite origin", () => {
    expect(devBootUrl("http://127.0.0.1:4319/?boot=abc123", 5174)).toBe(
      "http://localhost:5174/?boot=abc123",
    );
  });

  it("allows the Vite origin under both loopback names", () => {
    expect(webOrigins(5174)).toBe("http://localhost:5174,http://127.0.0.1:5174");
  });
});

describe("checkoutPort", () => {
  it("gives each checkout its own stable start, spread below the ephemeral range", () => {
    const one = checkoutPort("/work/gram/.worktrees/a");
    expect(checkoutPort("/work/gram/.worktrees/a")).toBe(one);
    const ports = new Set(
      Array.from({ length: 20 }, (_, i) => checkoutPort(`/work/gram/.worktrees/w${i}`)),
    );
    expect(ports.size).toBeGreaterThan(15);
    for (const port of [...ports, one]) {
      expect(port).toBeGreaterThanOrEqual(20_000);
      expect(port).toBeLessThan(28_000);
      expect(port % 8).toBe(0);
    }
  });
});
