import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** Runs Vitest as the check does over fixture files, outside CI, and returns its exit status. */
const run = (files, options = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "gram-only-"));
  dirs.push(dir);
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source);
  writeFileSync(join(dir, "vitest.config.mjs"), "export default {};\n");
  const { CI: _ci, GITHUB_ACTIONS: _actions, ...env } = process.env;
  const reportFile = join(dir, "report.json");
  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/vitest/vitest.mjs"),
      ...vitestArgs({ workers: 1, reportFile, ...options }),
      "--root",
      dir,
    ],
    { cwd: dir, env, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" },
  );
  if (result.error) throw result.error;
  return { ...result, report: () => JSON.parse(readFileSync(reportFile, "utf8")) };
};
const check = (source) => run({ "fixture.test.mjs": source });
const vitest = join(root, "node_modules/vitest/dist/index.js");

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

  it("runs each file in exactly one of a set of shards", () => {
    const files = Object.fromEntries(
      ["a", "b", "c", "d"].map((name) => [
        `${name}.test.mjs`,
        `import { it, expect } from "${vitest}";\nit("${name}", () => expect(1).toBe(1));\n`,
      ]),
    );
    const ran = ["1/2", "2/2"].map((shard) => {
      const result = run(files, { shard });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      return result.report().testResults.map((file) => file.name.split("/").at(-1));
    });
    expect(ran.every((names) => names.length > 0)).toBe(true);
    expect(ran.flat().toSorted()).toEqual(Object.keys(files).toSorted());
  }, 60_000);
});
