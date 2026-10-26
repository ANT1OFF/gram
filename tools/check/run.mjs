#!/usr/bin/env node
// `bun run check`: the full local gate. Frozen install, scaffold, docs, release metadata, lint,
// format and types, then every Vitest project once, with each stage's wall time at the end.
//
// Locally the tests first take a machine-wide check slot (slots.mjs), so full checks from several
// worktrees take turns rather than starving each other into timeouts, and each uses its share of
// the cores. On CI (one checkout per job) there is no slot and Vitest keeps three workers.
//
// `bun run check:affected` is the development loop: the same static stages (seconds), then only
// the Vitest projects the branch's changes against `origin/main` can affect, by the workspace
// dependency graph (affected.mjs). It takes no slot: the merge gate stays the full check.
//
// Under the solo merge policy Gram runs `check:ci` itself, on the PR's head merged onto its base in a
// worktree of its own, and accepts that pass in place of GitHub CI (packages/server/src/git/
// local-checks.ts). A run here informs; it records nothing the merge gate reads.
//
// `bun run check:cancel` stops this checkout's running check and every stage it started, and
// nothing else: each stage runs in a process group of its own, recorded per checkout.
//
//   bun run check [--no-slot] [--workers <n>]
//   bun run check:affected [--base <ref>] [--workers <n>]
//   bun run check:cancel
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { affected, workspaces } from "./affected.mjs";
import { slowFiles } from "./timings.mjs";
import { vitestArgs } from "./vitest-args.mjs";
import {
  acquireSlot,
  alive,
  clearRun,
  readRun,
  slotCount,
  workersPerSlot,
  writeRun,
} from "./slots.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const affectedMode = flag("--affected");
const ci = Boolean(process.env["CI"]);

const noop = () => {};
const seconds = (ms) => (ms / 1000).toFixed(1);
const say = (text) => process.stdout.write(`${text}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Signals each recorded process group of `run`, ignoring ones already gone. */
const signalGroups = (groups, signal) => {
  for (const pid of groups) {
    try {
      process.kill(-pid, signal);
    } catch {
      // Already exited.
    }
  }
};

if (flag("--cancel")) {
  const running = readRun(root);
  if (running === undefined || !alive(running.pid)) {
    say(`No check is running in ${root}.`);
    process.exit(0);
  }
  say(`Stopping the check in ${root} (pid ${running.pid}, since ${running.since}).`);
  process.kill(running.pid, "SIGTERM");
  for (let i = 0; i < 100 && alive(running.pid); i++) await sleep(100);
  // It didn't stop its stages in time: they are this checkout's own groups, so end them.
  const left = (readRun(root) ?? running).groups ?? [];
  signalGroups(left, "SIGKILL");
  if (alive(running.pid)) process.kill(running.pid, "SIGKILL");
  say("Stopped.");
  process.exit(0);
}

/** Process groups of the stages running now; each stage leads its own. */
const groups = new Set();
const record = (since) =>
  writeRun(root, {
    pid: process.pid,
    since,
    mode: affectedMode ? "affected" : "full",
    groups: [...groups],
  });

/** Runs one command, buffering its output unless `stream`; a failed stage prints its output. */
function run(name, cmd, cmdArgs, { stream = false } = {}) {
  const begin = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: root,
      detached: true,
      stdio: stream ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
    });
    if (child.pid !== undefined) {
      groups.add(child.pid);
      record(startedAt.toISOString());
    }
    let output = "";
    child.stdout?.on("data", (chunk) => (output += chunk));
    child.stderr?.on("data", (chunk) => (output += chunk));
    child.once("error", (error) => {
      output += String(error);
      resolve({ name, ok: false, ms: Date.now() - begin, output });
    });
    child.once("exit", (code) => {
      groups.delete(child.pid);
      record(startedAt.toISOString());
      resolve({ name, ok: code === 0, ms: Date.now() - begin, output });
    });
  });
}

const report = (result) => {
  say(`  ${result.ok ? "ok    " : "FAILED"} ${result.name} (${seconds(result.ms)}s)`);
  if (!result.ok && result.output) process.stdout.write(result.output.replace(/^/gm, "    "));
};

const git = (gitArgs) =>
  execFileSync("git", gitArgs, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });

/** Paths the branch changes against `base`'s merge base, uncommitted and untracked ones too. */
function changedPaths(base) {
  const mergeBase = git(["merge-base", base, "HEAD"]).trim();
  const lines = [
    ...git(["diff", "--name-only", "--no-renames", mergeBase]).split("\n"),
    ...git(["ls-files", "--others", "--exclude-standard"]).split("\n"),
  ];
  return { mergeBase, paths: [...new Set(lines.filter((line) => line !== ""))] };
}

const startedAt = new Date();
const results = [];
let free = noop;

// Stopped (Ctrl-C, or check:cancel): end every stage's group, give the slot back, and say so.
const stop = (signal) => {
  signalGroups(groups, "SIGTERM");
  free();
  clearRun(root);
  say(`\nCheck stopped (${signal}).`);
  process.exit(signal === "SIGINT" ? 130 : 143);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.once("exit", () => clearRun(root));
record(startedAt.toISOString());

let projects;
if (affectedMode) {
  const base = option("--base") ?? "origin/main";
  const { mergeBase, paths } = changedPaths(base);
  const scope = affected(paths, workspaces(root));
  projects = scope.projects;
  say(
    `▸ Affected by ${paths.length} changed ${paths.length === 1 ? "path" : "paths"} since ` +
      `${base} (${mergeBase.slice(0, 12)}): ` +
      (scope.all
        ? `everything (${scope.reason})`
        : projects.length === 0
          ? "no Vitest project"
          : projects.join(", ")),
  );
}

// Quick, independent stages run side by side; together they take seconds next to the tests.
say("▸ Static");
if (!affectedMode) {
  const install = await run("install", "bun", ["install", "--frozen-lockfile"]);
  report(install);
  results.push(install);
}
if (results.every((result) => result.ok)) {
  const quick = await Promise.all([
    run("scaffold", "node", ["tools/check-public-scaffold.mjs"]),
    run("docs", "node", ["tools/check-docs.mjs"]),
    run("release-metadata", "node", ["tools/check-release-please.mjs"]),
    run("lint", "bun", ["run", "lint"]),
    run("format", "bun", ["run", "fmt:check"]),
    run("types", "bun", ["run", "typecheck"]),
  ]);
  for (const result of quick) report(result);
  results.push(...quick);
}

if (results.every((result) => result.ok) && (projects === undefined || projects.length > 0)) {
  const slots = slotCount();
  const workers = Number(
    option("--workers") ?? process.env["GRAM_CHECK_WORKERS"] ?? (ci ? 3 : workersPerSlot(slots)),
  );
  if (!Number.isInteger(workers) || workers < 1) throw new Error(`invalid workers "${workers}"`);
  if (!affectedMode && !ci && !flag("--no-slot") && process.env["GRAM_CHECK_SLOT"] !== "0") {
    const waited = Date.now();
    free = await acquireSlot({
      slots,
      label: root,
      onWait: (holders) =>
        say(
          `▸ Waiting for one of ${slots} check slots on this machine, held by:\n` +
            holders.map((h) => `    ${h.cwd} (pid ${h.pid}, since ${h.since})`).join("\n"),
        ),
    });
    const ms = Date.now() - waited;
    if (ms >= 1000) results.push({ name: "slot wait", ok: true, ms });
  }
  const reportDir = mkdtempSync(join(tmpdir(), "gram-check-"));
  const reportFile = join(reportDir, "vitest.json");
  say(`▸ Tests (${workers} workers, ${availableParallelism()} cores)`);
  const tests = await run(
    "tests",
    "node",
    ["node_modules/vitest/vitest.mjs", ...vitestArgs({ workers, projects, reportFile })],
    { stream: true },
  );
  free();
  free = noop;
  results.push(tests);
  try {
    const json = JSON.parse(readFileSync(reportFile, "utf8"));
    tests.summary =
      `${json.numPassedTests} passed, ${json.numFailedTests} failed, ` +
      `${json.numPendingTests + json.numTodoTests} skipped, ${json.testResults.length} files`;
    say("\n▸ Slowest test files (including hooks)");
    for (const { file, ms } of slowFiles(json, root)) {
      say(`  ${seconds(ms).padStart(6)}s  ${file}`);
    }
  } catch {
    tests.ok = false;
    tests.summary = "no Vitest report";
  }
  rmSync(reportDir, { recursive: true, force: true });
  report(tests);
}

const ok = results.every((result) => result.ok);
say("\n▸ Stages");
for (const result of results) {
  say(
    `  ${result.name.padEnd(17)} ${seconds(result.ms).padStart(6)}s${result.ok ? "" : "  FAILED"}` +
      `${result.summary ? `  ${result.summary}` : ""}`,
  );
}
say(`  ${"total".padEnd(17)} ${seconds(Date.now() - startedAt.getTime()).padStart(6)}s`);
if (affectedMode && ok)
  say("\nAffected checks passed. The merge gate is still the full `bun run check`.");
process.exit(ok ? 0 : 1);
