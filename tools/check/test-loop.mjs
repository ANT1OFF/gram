#!/usr/bin/env node
// bun run test:loop <file> [-n 30]: repeat one Vitest file in fresh processes.
import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function parseLoopArgs(args) {
  let file;
  let count = 30;
  let counted = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-n" && !counted) {
      const value = args[++i];
      if (!/^[1-9]\d*$/.test(value ?? "") || !Number.isSafeInteger(Number(value)))
        throw new Error("-n must be a positive integer");
      count = Number(value);
      counted = true;
    } else if (!args[i].startsWith("-") && !file) file = args[i];
    else throw new Error("Usage: bun run test:loop <file> [-n 30]");
  }
  if (!file) throw new Error("Usage: bun run test:loop <file> [-n 30]");
  return { file, count };
}

const invoke = (args, root) => {
  const r = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 ** 2,
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? "",
    output: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error}` : ""}`,
    signal: r.signal,
  };
};

export function runLoop({ file, count, root = process.cwd(), run = invoke, say = console.log }) {
  const path = realpathSync(resolve(root, file));
  if (!statSync(path).isFile()) throw new Error("Expected one Vitest file");
  // Vitest's positional filters are substrings. Refuse ambiguous filters and files excluded
  // by the repository's projects before executing any tests.
  const listed = run(["list", path, "--json", "--filesOnly"], root);
  if (!listed.ok) throw new Error(`Vitest could not list the file:\n${listed.output}`);
  const files = JSON.parse(listed.stdout);
  if (files.length !== 1 || realpathSync(files[0].file) !== path)
    throw new Error(
      "Expected exactly one included Vitest file; the filter matched zero or multiple files",
    );

  let passed = 0;
  let failed = 0;
  let firstFailure;
  for (let i = 1; i <= count; i++) {
    const result = run(
      ["run", path, "--maxWorkers=1", "--allowOnly=false", "--passWithNoTests=false"],
      root,
    );
    if (result.ok) passed++;
    else {
      failed++;
      firstFailure ??= { iteration: i, output: result.output };
    }
    say(`${i}/${count} ${result.ok ? "PASS" : "FAIL"}`);
    if (result.signal === "SIGINT" || result.signal === "SIGTERM") break;
  }
  say(`\n${passed} passed, ${failed} failed (${passed + failed} runs)`);
  if (firstFailure)
    say(`\nFirst failing output (run ${firstFailure.iteration}):\n${firstFailure.output}`);
  return { passed, failed, firstFailure };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = runLoop({
      ...parseLoopArgs(process.argv.slice(2)),
      root: fileURLToPath(new URL("../../", import.meta.url)),
    });
    process.exitCode = result.failed ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
