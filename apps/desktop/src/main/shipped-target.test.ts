import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { shippedTarget } from "./shipped-target.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const app = () => {
  const dir = mkdtempSync(join(tmpdir(), "gram-shipped-"));
  dirs.push(dir);
  const server = join(dir, "app.asar", "out", "server");
  mkdirSync(server, { recursive: true });
  const host = join(server, "gram-host.js");
  const probe = join(server, "native-probe.js");
  writeFileSync(host, "");
  writeFileSync(probe, "");
  return { dir, host, probe };
};

describe("what the packaged binary runs besides the app", () => {
  it("runs its own gram-host, by its path as every release started it, or by --gram-host", () => {
    const { dir, host, probe } = app();
    expect(shippedTarget(host, host, probe)).toBe(host);
    expect(shippedTarget("--gram-host", host, probe)).toBe(host);
    // Another spelling of the same file: a link in the path, as an installer's may have.
    symlinkSync(join(dir, "app.asar"), join(dir, "link.asar"));
    expect(
      shippedTarget(join(dir, "link.asar", "out", "server", "gram-host.js"), host, probe),
    ).toBe(host);
    expect(shippedTarget(probe, host, probe)).toBe(probe);
  });

  it("runs no other script, whatever its name or place, and otherwise starts the app", () => {
    const { dir, host, probe } = app();
    const foreign = join(dir, "gram-host.js");
    writeFileSync(foreign, "");
    expect(shippedTarget(foreign, host, probe)).toBeUndefined();
    expect(shippedTarget(join(dir, "nowhere.js"), host, probe)).toBeUndefined();
    expect(shippedTarget("--smoke", host, probe)).toBeUndefined();
    expect(shippedTarget(undefined, host, probe)).toBeUndefined();
  });
});
