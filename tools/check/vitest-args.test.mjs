import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { vitestArgs } from "./vitest-args.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Runs Vitest as the check does over one fixture file, outside CI, and returns its exit status. */
const check = (source) => {
  const dir = mkdtempSync(join(tmpdir(), "gram-only-"));
  dirs.push(dir);
  writeFileSync(join(dir, "fixture.test.mjs"), source);
  writeFileSync(join(dir, "vitest.config.mjs"), "export default {};\n");
  const { CI: _ci, GITHUB_ACTIONS: _actions, ...env } = process.env;
  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/vitest/vitest.mjs"),
      ...vitestArgs({ workers: 1, reportFile: join(dir, "report.json") }),
      "--root",
      dir,
    ],
    { cwd: dir, env, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" },
  );
  if (result.error) throw result.error;
  return result;
};

describe("the check's Vitest command", () => {
  it("fails a run with a focused test instead of skipping the rest of the file", () => {
    const focused =
      check(`import { it, expect } from "${join(root, "node_modules/vitest/dist/index.js")}";
it.only("focused", () => expect(1).toBe(1));
it("never run", () => expect(1).toBe(2));
`);
    expect(focused.status).not.toBe(0);
    expect(focused.stdout + focused.stderr).toMatch(/only/i);
  }, 60_000);

  it("passes the same file without the focus", () => {
    const plain =
      check(`import { it, expect } from "${join(root, "node_modules/vitest/dist/index.js")}";
it("runs", () => expect(1).toBe(1));
`);
    expect(plain.status, plain.stdout + plain.stderr).toBe(0);
  }, 60_000);
});
