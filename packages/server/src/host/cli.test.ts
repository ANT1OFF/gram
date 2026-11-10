import { chmodSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { removeDir, tempDir } from "../git/test-repo.ts";
import { provisionHere, runCli, stillJoined } from "./cli.ts";
import { fingerprintOf, hostIdOf, publicKeyFrom } from "./machine-keys.ts";
import { forgetJoined, readHostConfig, readHostKey, writeJoined } from "./host-config.ts";

const ORIGIN = "https://studio.example-tailnet.ts.net";
const LINK = `${ORIGIN}/host/join#code=${"a".repeat(64)}`;
const host = { service: () => Effect.die("not used"), layer: Layer.empty };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.exitCode = 0;
});

describe("join preflight", () => {
  it("refuses a non-private home before consuming the invitation", async () => {
    const dir = tempDir();
    const home = join(dir, "host");
    mkdirSync(home);
    chmodSync(home, 0o755);
    vi.stubEnv("GRAM_HOST_HOME", home);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await Effect.runPromise(runCli(["join", LINK, "--no-service"], host));
      expect(fetch).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      removeDir(dir);
    }
  });

  it("creates a fresh private home before requesting a join and keeps the result", async () => {
    const dir = tempDir();
    const home = join(dir, "host");
    vi.stubEnv("GRAM_HOST_HOME", home);
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect(statSync(home).mode & 0o777).toBe(0o700);
      const body = JSON.parse(init.body as string) as { publicKey: string };
      return new Response(JSON.stringify({ hostId: hostIdOf(body.publicKey) }));
    });
    vi.stubGlobal("fetch", fetch);
    try {
      await Effect.runPromise(runCli(["join", LINK, "--name", "build box", "--no-service"], host));
      expect(fetch).toHaveBeenCalledOnce();
      expect(readHostConfig(home)).toMatchObject({ name: "build box", origin: ORIGIN });
    } finally {
      removeDir(dir);
    }
  });
});

describe("a running host's join", () => {
  it("reads as left once `gram-host leave` forgets it, or the machine joins another Gram", () => {
    const dir = tempDir();
    const home = join(dir, "host");
    try {
      const config = { version: 1 as const, origin: ORIGIN, hostId: "m-0123", name: "box" };
      writeJoined(home, config, "synthetic, not a key\n");
      const joined = stillJoined(home, config);
      expect(joined()).toBe(true);
      writeJoined(home, { ...config, origin: "https://other.example-tailnet.ts.net" }, "x\n");
      expect(joined()).toBe(false);
      writeJoined(home, config, "x\n");
      expect(joined()).toBe(true);
      forgetJoined(home);
      expect(joined()).toBe(false);
    } finally {
      removeDir(dir);
    }
  });
});

describe("gram-host provision", () => {
  const HOSTS = "https://gram.internal:8443";

  it("makes a key and keeps the address without reaching it, and answers the same again", () => {
    const dir = tempDir();
    const home = join(dir, "host");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      const made = provisionHere(home, { origin: HOSTS, name: "sandbox-1" });
      expect(publicKeyFrom(made.publicKey)).toBeDefined();
      expect(made).toEqual({
        hostId: hostIdOf(made.publicKey),
        name: "sandbox-1",
        platform: process.platform,
        publicKey: made.publicKey,
        fingerprint: fingerprintOf(made.publicKey),
        origin: HOSTS,
      });
      expect(readHostConfig(home)).toEqual({
        version: 1,
        origin: HOSTS,
        hostId: made.hostId,
        name: "sandbox-1",
        provisioned: true,
      });
      // The private half stays in the host's own folder, owner-only, and is never printed.
      expect(readHostKey(home)).toContain("PRIVATE KEY");
      expect(JSON.stringify(made)).not.toContain("PRIVATE");
      if (process.platform !== "win32")
        expect(statSync(join(home, "host-key.pem")).mode & 0o077).toBe(0);
      expect(provisionHere(home, { origin: HOSTS })).toEqual(made);
      expect(provisionHere(home, { origin: HOSTS, name: "sandbox-1" })).toEqual(made);
      expect(() => provisionHere(home, { origin: "https://other.internal" })).toThrow(
        "already provisioned",
      );
      expect(() => provisionHere(home, { origin: HOSTS, name: "renamed" })).toThrow(
        "already provisioned",
      );
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      removeDir(dir);
    }
  });

  it("refuses an address that isn't https, a reserved name, and a machine that joined with a link", () => {
    const dir = tempDir();
    try {
      const home = join(dir, "host");
      expect(() => provisionHere(home, { origin: "http://gram.internal:8443" })).toThrow(
        "https://",
      );
      expect(() => provisionHere(home, { origin: HOSTS, name: "this machine" })).toThrow();
      expect(() => provisionHere(home, { origin: HOSTS, name: "a/b" })).toThrow();
      expect(readHostConfig(home)).toBeUndefined();
      const joinedHome = join(dir, "joined");
      const made = provisionHere(join(dir, "scratch"), { origin: HOSTS });
      writeJoined(
        joinedHome,
        { version: 1, origin: ORIGIN, hostId: made.hostId, name: "box" },
        readHostKey(join(dir, "scratch"))!,
      );
      expect(() => provisionHere(joinedHome, { origin: HOSTS })).toThrow("already joined");
      expect(readHostConfig(joinedHome)).not.toHaveProperty("provisioned");
    } finally {
      removeDir(dir);
    }
  });

  it("prints one line of JSON, and says what is missing without it", async () => {
    const dir = tempDir();
    vi.stubEnv("GRAM_HOST_HOME", join(dir, "host"));
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await Effect.runPromise(runCli(["provision"], host));
      expect(process.exitCode).toBe(1);
      expect(String(err.mock.calls[0]?.[0])).toContain("--origin");
      process.exitCode = 0;
      await Effect.runPromise(runCli(["provision", "--origin", HOSTS, "--name", "s1"], host));
      expect(process.exitCode).toBe(0);
      expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toMatchObject({
        name: "s1",
        origin: HOSTS,
      });
    } finally {
      removeDir(dir);
    }
  });
});
