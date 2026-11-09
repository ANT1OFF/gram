import { chmodSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { removeDir, tempDir } from "../git/test-repo.ts";
import { runCli } from "./cli.ts";
import { hostIdOf } from "./machine-keys.ts";
import { readHostConfig } from "./host-config.ts";

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
