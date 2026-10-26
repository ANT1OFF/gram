import { spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { afterEach, expect, it } from "vitest";

import { parseLoopArgs, runLoop } from "./test-loop.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "gram-test-loop-"));
  dirs.push(dir);
  return dir;
};
const vitestRoot = (modules = join(ROOT, "node_modules")) => {
  const root = fresh();
  // Vitest clears node_modules/.vitest-cache when the root's lockfile changes.
  // Link only the package: linking node_modules also shares the parent's active cache.
  mkdirSync(join(root, "node_modules"));
  symlinkSync(join(modules, "vitest"), join(root, "node_modules/vitest"), "dir");
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  writeFileSync(
    join(root, "vitest.config.mjs"),
    'export default { test: { include: ["*.test.mjs"] } };',
  );
  return root;
};

it("defaults to 30 runs and accepts the count before or after the file", () => {
  expect(parseLoopArgs(["one.test.ts"])).toEqual({ file: "one.test.ts", count: 30 });
  expect(parseLoopArgs(["one.test.ts", "-n", "2"])).toEqual({ file: "one.test.ts", count: 2 });
  expect(parseLoopArgs(["-n", "2", "one.test.ts"])).toEqual({ file: "one.test.ts", count: 2 });
});

it.each([
  [],
  ["-n", "2"],
  ["a", "b"],
  ["a", "--unknown"],
  ["a", "-n"],
  ["a", "-n", "0"],
  ["a", "-n", "-1"],
  ["a", "-n", "2.5"],
  ["a", "-n", "Infinity"],
  ["a", "-n", "9007199254740992"],
  ["a", "-n", "1", "-n", "2"],
])("rejects invalid arguments: %j", (...args) => {
  expect(() => parseLoopArgs(args)).toThrow();
});

it("counts all runs after a failure and prints only the first failing output", () => {
  const root = fresh();
  const file = join(root, "one.test.mjs");
  writeFileSync(file, "");
  const said = [];
  const calls = [];
  const results = [true, false, false];
  const result = runLoop({
    file,
    count: 3,
    root,
    say: (s) => said.push(s),
    run: (args, cwd) => {
      calls.push({ args, cwd });
      if (args[0] === "list") return { ok: true, stdout: JSON.stringify([{ file }]) };
      const ok = results.shift();
      return { ok, output: `output-${results.length}` };
    },
  });
  expect(result).toEqual({
    passed: 1,
    failed: 2,
    firstFailure: { iteration: 2, output: "output-1" },
  });
  expect(said.join("\n")).toContain("1 passed, 2 failed (3 runs)");
  expect(said.join("\n")).toContain("output-1");
  expect(said.join("\n")).not.toContain("output-0");
  expect(calls.slice(1)).toEqual(
    Array.from({ length: 3 }, () => ({
      cwd: root,
      args: [
        "run",
        realpathSync(file),
        "--maxWorkers=1",
        "--allowOnly=false",
        "--passWithNoTests=false",
      ],
    })),
  );
});

it.each([[], [{ file: "other" }], [{ file: "one" }, { file: "two" }]])(
  "refuses a zero or ambiguous match before running: %j",
  (...files) => {
    const root = fresh();
    const file = join(root, "one.test.mjs");
    writeFileSync(file, "");
    let calls = 0;
    expect(() =>
      runLoop({
        file,
        count: 1,
        root,
        run: () => {
          calls++;
          return { ok: true, stdout: JSON.stringify(files) };
        },
      }),
    ).toThrow();
    expect(calls).toBe(1);
  },
);

it("repeats a real isolated Vitest file in fresh processes and retains its first failure", () => {
  const root = vitestRoot();
  const counter = join(root, "counter");
  writeFileSync(counter, "0");
  writeFileSync(
    join(root, "synthetic.test.mjs"),
    `
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
it("invented intermittent failure", () => {
  const n = Number(readFileSync(${JSON.stringify(counter)}, "utf8")) + 1;
  writeFileSync(${JSON.stringify(counter)}, String(n));
  expect(n, "synthetic-first-failure").not.toBe(2);
});
`,
  );
  const said = [];
  const result = runLoop({ file: "synthetic.test.mjs", root, count: 3, say: (s) => said.push(s) });
  expect(result.passed).toBe(2);
  expect(result.failed).toBe(1);
  expect(result.firstFailure.iteration).toBe(2);
  expect(result.firstFailure.output).toContain("synthetic-first-failure");
  expect(readFileSync(counter, "utf8")).toBe("3");
}, 15_000);

it("keeps a dependency installation's active module cache isolated from nested Vitest", async () => {
  // Model the parent's cache in disposable storage, never in the checkout's node_modules.
  const modules = join(fresh(), "node_modules");
  const cache = join(modules, ".vitest-cache");
  mkdirSync(cache, { recursive: true });
  symlinkSync(join(ROOT, "node_modules/vitest"), join(modules, "vitest"), "dir");
  const metadata = '{"lockfileHash":"invented-parent-lockfile"}';
  writeFileSync(join(cache, "_metadata.json"), metadata);
  const root = vitestRoot(modules);
  writeFileSync(
    join(root, "synthetic.test.mjs"),
    'import { it, expect } from "vitest"; it("invented success", () => expect(1).toBe(1));',
  );
  const stop = new SharedArrayBuffer(4);
  const writer = new Worker(new URL("./fixtures/cache-writer.mjs", import.meta.url), {
    workerData: { cache, stop },
  });
  const exited = once(writer, "exit");
  try {
    await once(writer, "message");
    const result = runLoop({ file: "synthetic.test.mjs", count: 2, root, say: () => {} });
    expect(result).toEqual({ passed: 2, failed: 0, firstFailure: undefined });
    expect(readFileSync(join(cache, "_metadata.json"), "utf8")).toBe(metadata);
  } finally {
    Atomics.store(new Int32Array(stop), 0, 1);
    await exited;
  }
}, 15_000);

it("CLI fails nonzero for an invalid invocation", () => {
  const r = spawnSync(process.execPath, [resolve(ROOT, "tools/check/test-loop.mjs"), "-n", "0"], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin" },
  });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("positive integer");
});
