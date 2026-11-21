import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Stand-ins for the natives: speech exports one name, and the pty runs its command for real. */
const natives = (root: string, ran: string) => {
  const speech = join(root, "node_modules", "sherpa-onnx-node");
  const pty = join(root, "node_modules", "node-pty");
  mkdirSync(speech, { recursive: true });
  mkdirSync(pty, { recursive: true });
  writeFileSync(
    join(speech, "index.js"),
    `require("node:fs").writeFileSync(${JSON.stringify(ran)}, "speech"); module.exports = { ok: 1 };`,
  );
  writeFileSync(
    join(pty, "index.js"),
    `const { spawnSync } = require("node:child_process");
module.exports.spawn = (file, args, options) => {
  const done = spawnSync(file, args, { cwd: options.cwd, env: options.env, encoding: "utf8" });
  return {
    onData: (listener) => setImmediate(() => listener(done.stdout)),
    onExit: (listener) => setTimeout(() => listener({ exitCode: done.status }), 10),
  };
};`,
  );
};

/** A packaged app's layout with the probe in it, its own natives, and a caller's folder. */
const packaged = () => {
  const dir = mkdtempSync(join(tmpdir(), "gram-probe-"));
  dirs.push(dir);
  const asar = join(dir, "app.asar");
  const server = join(asar, "out", "server");
  mkdirSync(server, { recursive: true });
  const probe = join(server, "native-probe.js");
  copyFileSync(new URL("./native-probe.cjs", import.meta.url), probe);
  natives(asar, join(dir, "own-ran"));
  const foreign = join(dir, "foreign");
  const foreignRan = join(dir, "foreign-ran");
  natives(foreign, foreignRan);
  const scratch = join(dir, "scratch");
  mkdirSync(scratch);
  return { dir, asar, probe, foreign, foreignRan, scratch };
};

const run = (probe: string, args: string[]) =>
  spawnSync(process.execPath, [probe, ...args], { encoding: "utf8", timeout: 20_000 });

describe("the native probe the app ships", () => {
  it("loads the natives of its own app.asar and prints the marker", () => {
    const { asar, probe, scratch } = packaged();
    const done = run(probe, [asar, scratch, "GRAM_PROBE_1"]);
    expect(done.stdout).toContain("NATIVE OK");
  });

  it("loads no code from a folder its caller names", () => {
    const { probe, foreign, foreignRan, scratch } = packaged();
    const done = run(probe, [foreign, scratch, "GRAM_PROBE_1"]);
    expect(done.status).not.toBe(0);
    expect(existsSync(foreignRan)).toBe(false);
  });

  it("hands no text of its caller's to a shell to run", () => {
    const { dir, asar, probe, scratch } = packaged();
    const injected = join(dir, "injected");
    for (const marker of [`X;touch ${injected}`, `$(touch ${injected})`, `X\`touch ${injected}\``])
      run(probe, [asar, scratch, marker]);
    expect(existsSync(injected)).toBe(false);
  });
});
