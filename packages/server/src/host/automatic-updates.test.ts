import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ServerConfig } from "../config.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import { RemoteHosts } from "./remote-hosts.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(join(dir, "remote-access"), 0o700);
    } catch {
      // Not there, or a link.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A data folder of its own, with `remote-access` in it, owner-only. */
const dataDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "gram-automatic-updates-"));
  dirs.push(dir);
  mkdirSync(join(dir, "remote-access"), { mode: 0o700 });
  return dir;
};

/** What a fresh `RemoteHosts.layer` over `dir` reads the switch as. */
const automatic = (dir: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        return (yield* RemoteHosts).automaticUpdates();
      }).pipe(
        Effect.provide(RemoteHosts.layer),
        Effect.provide(ServerConfig.layer({ ...TEST_CONFIG, dataDir: dir })),
      ),
    ),
  );

const switchFile = (dir: string) => join(dir, "remote-access", "machine-updates.json");

// Failed on e846c852 in the independent re-review: the store asked `existsSync` first, which says
// "absent" for a folder it can't look into or a dangling link, and absent reads as on.
describe("the automatic-updates switch as kept", () => {
  it("is on until set, and off once turned off", async () => {
    const dir = dataDir();
    expect(await automatic(dir)).toBe(true);
    writeFileSync(switchFile(dir), JSON.stringify({ version: 1, automatic: false }), {
      mode: 0o600,
    });
    expect(await automatic(dir)).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)(
    "reads as off when its folder can't be looked into",
    async () => {
      const dir = dataDir();
      writeFileSync(switchFile(dir), JSON.stringify({ version: 1, automatic: false }), {
        mode: 0o600,
      });
      chmodSync(join(dir, "remote-access"), 0);
      expect(await automatic(dir)).toBe(false);
    },
  );

  it("reads as off when it is a link, dangling or not", async () => {
    const dir = dataDir();
    symlinkSync(join(dir, "missing-switch"), switchFile(dir));
    expect(await automatic(dir)).toBe(false);
    const elsewhere = join(dir, "elsewhere.json");
    writeFileSync(elsewhere, JSON.stringify({ version: 1, automatic: true }), { mode: 0o600 });
    rmSync(switchFile(dir));
    symlinkSync(elsewhere, switchFile(dir));
    expect(await automatic(dir)).toBe(false);
  });

  it("reads as off when it isn't a switch, or isn't private", async () => {
    const dir = dataDir();
    writeFileSync(switchFile(dir), "{", { mode: 0o600 });
    expect(await automatic(dir)).toBe(false);
    writeFileSync(switchFile(dir), JSON.stringify({ version: 1, automatic: true }), {
      mode: 0o644,
    });
    chmodSync(switchFile(dir), 0o644);
    expect(await automatic(dir)).toBe(false);
  });

  it("reads as off when its folder is a link", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gram-automatic-updates-"));
    dirs.push(dir);
    symlinkSync(join(dir, "missing-folder"), join(dir, "remote-access"));
    expect(await automatic(dir)).toBe(false);
  });
});
