// Before/after screenshots for a pull request's description: `bun run --filter @gram/web
// pr:shots`. "After" is the working tree; "before" is the merge base with `--base` (origin/main),
// checked out in a temporary worktree that is removed on exit, Ctrl-C included. Both runs use the
// working tree's `pr-shots/` to drive the app, so a shot the base can't stage is captured
// after-only. The images go to `pr-shots/out/`, gitignored: attach them with `gh pr edit --attach`,
// never commit them. `--help` has the flags.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, stripVTControlCharacters } from "node:util";

const webDir = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(webDir, "pr-shots", "out");
const config = join("pr-shots", "playwright.config.ts");

const HELP = `bun run --filter @gram/web pr:shots [flags]

  --shot <name>     a shot from pr-shots/shots.ts; repeat or comma-separate (default: all)
  --path <route>    an ad-hoc shot of a route that only needs loading, e.g. /settings/agents
  --mode <mode>     dark or light (default: both)
  --base <ref>      what "before" is the merge base with (default: origin/main)
  --after-only      skip the base checkout
  --list            print the shots and exit

Writes pr-shots/out/<shot>-<mode>.{before,after}.png and pr-shots/out/shots.md.`;

/** Bounds on what this spawns, so a hung install or browser can't hold the terminal. */
const GIT_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const CAPTURE_TIMEOUT_MS = 15 * 60_000;

/** The child running now, so a signal can stop it before the base worktree is removed. */
let current;
/** Set by SIGINT or SIGTERM: what is running finishes its cleanup and nothing new starts. */
let stopped = false;
const checkStopped = () => {
  if (stopped) throw new Error("stopped");
};

/** How long a child asked to stop gets before SIGKILL. */
const KILL_GRACE_MS = 10_000;

/**
 * SIGTERM first, as Playwright stops its Vite server in its teardown on it, then SIGKILL if the
 * child is still there after `KILL_GRACE_MS`, so a wedged teardown can't hold the run open.
 */
function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const force = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
  child.once("exit", () => clearTimeout(force));
  child.kill("SIGTERM");
}

/** Runs `command` to completion within `timeoutMs`; resolves with its stdout when `capture`. */
function run(command, args, { cwd = webDir, env = process.env, timeoutMs, capture = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
    });
    current = child;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
    }, timeoutMs);
    let stdout = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      current = undefined;
      if (code === 0) return resolve(stdout.trim());
      const why = timedOut ? `timed out after ${timeoutMs / 1000}s` : (signal ?? `exit ${code}`);
      reject(new Error(`${command} ${args.join(" ")} failed (${why})`));
    });
  });
}

const git = (args, cwd = webDir) =>
  run("git", args, { cwd, timeoutMs: GIT_TIMEOUT_MS, capture: true });

const bun = process.env["npm_execpath"] ?? "bun";

/** Playwright's CLI under this Node, so a timeout or a signal reaches it rather than a wrapper. */
const playwrightCli = createRequire(join(webDir, "package.json")).resolve("@playwright/test/cli");

const playwright = (args, env) =>
  run(process.execPath, [playwrightCli, "test", "-c", config, ...args], {
    env: { ...process.env, ...env },
    timeoutMs: CAPTURE_TIMEOUT_MS,
  });

const resultsFile = join(outDir, ".results.json");

/**
 * One capture run for `label`. The report is cleared first, so a run that dies before writing its
 * own can't be read as the last one's. Rejects when the run left no report at all; a run whose
 * shots failed resolves with them failed.
 */
async function captureRun(label, env) {
  rmSync(resultsFile, { force: true });
  const failure = await playwright([], { ...env, GRAM_PR_SHOTS_LABEL: label }).then(
    () => undefined,
    (error) => error,
  );
  checkStopped();
  if (!existsSync(resultsFile)) {
    throw new Error(`the ${label} capture wrote no report (${failure?.message ?? "no error"})`);
  }
  return readResults(label);
}

/**
 * Each test's outcome from the JSON report: title, ok, and the first line of its error. A test is
 * ok only when it passed and its image is there.
 */
function readResults(label) {
  const file = resultsFile;
  const results = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const last = t.results?.at(-1);
        const message = last?.error?.message;
        const error = message && stripVTControlCharacters(message).split("\n")[0];
        const title = t.annotations?.find((a) => a.type === "title")?.description ?? spec.title;
        const ok =
          last?.status === "passed" && existsSync(join(outDir, `${spec.title}.${label}.png`));
        results.push({ id: spec.title, title, ok, error });
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of JSON.parse(readFileSync(file, "utf8")).suites ?? []) walk(suite);
  return results;
}

async function captureBase(base, env) {
  const sha = await git(["merge-base", "HEAD", base]);
  const root = mkdtempSync(join(tmpdir(), "gram-pr-shots-"));
  const tree = join(root, "base");
  console.log(`\nbefore: ${base} (merge base ${sha.slice(0, 10)}) in ${tree}`);
  try {
    await git(["worktree", "add", "--detach", tree, sha]);
    checkStopped();
    await run(bun, ["install", "--frozen-lockfile", "--prefer-offline", "--filter", "@gram/web"], {
      cwd: tree,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    // A failed shot is what "before" is allowed: the base may lack the screen. The report says.
    return await captureRun("before", {
      ...env,
      GRAM_PR_SHOTS_WEB_DIR: join(tree, "apps", "web"),
    });
  } finally {
    await git(["worktree", "remove", "--force", tree]).catch((error) =>
      console.error(`pr-shots: couldn't remove the base worktree ${tree}: ${error.message}`),
    );
    rmSync(root, { recursive: true, force: true });
  }
}

/** The markdown for the PR body; each `./<file>` is what `gh --attach` rewrites to its upload. */
function summary(after, before, afterOnly) {
  const lines = ["### Screenshots", ""];
  for (const shot of after.filter((r) => r.ok)) {
    const had = before.find((r) => r.id === shot.id && r.ok);
    lines.push(`**${shot.title}** (${shot.id.split("-").at(-1)})`, "");
    if (had) {
      lines.push(
        "| Before | After |",
        "| --- | --- |",
        `| ![${shot.id} before](./${shot.id}.before.png) | ![${shot.id} after](./${shot.id}.after.png) |`,
      );
    } else {
      if (!afterOnly) lines.push("_No before: this shot didn't capture on the base._", "");
      lines.push(`![${shot.id} after](./${shot.id}.after.png)`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** `--shot a,b --shot c` as `[a, b, c]`. */
const split = (items) => items.flatMap((item) => item.split(",")).filter((item) => item !== "");

async function main() {
  const { values } = parseArgs({
    // Bun hands a script the `--` that separates its own options from the script's.
    args: process.argv.slice(2).filter((arg) => arg !== "--"),
    options: {
      shot: { type: "string", multiple: true, default: [] },
      path: { type: "string", multiple: true, default: [] },
      mode: { type: "string", multiple: true, default: [] },
      base: { type: "string", default: "origin/main" },
      "after-only": { type: "boolean", default: false },
      list: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return console.log(HELP);
  const modes = split(values.mode);
  const bad = modes.find((mode) => mode !== "dark" && mode !== "light");
  if (bad) throw new Error(`--mode is dark or light, not "${bad}"`);
  const env = {
    GRAM_PR_SHOTS_ONLY: split(values.shot).join(","),
    GRAM_PR_SHOTS_PATHS: split(values.path).join(","),
    GRAM_PR_SHOTS_MODES: modes.join(","),
  };
  if (values.list) return playwright(["--list"], env);

  rmSync(outDir, { recursive: true, force: true });
  console.log("after: the working tree");
  const after = await captureRun("after", env);
  const failed = after.filter((r) => !r.ok);
  if (after.length === 0 || failed.length > 0) {
    for (const r of failed) console.error(`after: ${r.id} failed: ${r.error ?? "see above"}`);
    throw new Error("the working tree's shots must all capture; fix the shot or the screen");
  }
  const afterOnly = values["after-only"];
  let before = [];
  /** Why the base run as a whole failed, when it did: every shot is then after-only. */
  let baseError;
  if (!afterOnly) {
    try {
      before = await captureBase(values.base, env);
    } catch (error) {
      if (stopped) throw error;
      baseError = error.message;
      console.error(`before: ${baseError}; every shot is after-only`);
    }
  }
  rmSync(resultsFile, { force: true });

  const markdown = summary(after, before, afterOnly);
  writeFileSync(join(outDir, "shots.md"), markdown);
  const files = after.flatMap((r) =>
    before.some((b) => b.id === r.id && b.ok)
      ? [`./${r.id}.before.png`, `./${r.id}.after.png`]
      : [`./${r.id}.after.png`],
  );
  console.log("");
  for (const r of after) {
    const had = before.find((b) => b.id === r.id);
    if (afterOnly) console.log(`${r.id}: after`);
    else if (had?.ok) console.log(`${r.id}: before and after`);
    else console.log(`${r.id}: after only; on the base: ${had?.error ?? baseError ?? "not run"}`);
  }
  // Bun runs the script in apps/web; INIT_CWD is where it was typed.
  const out = relative(process.env["INIT_CWD"] ?? process.cwd(), outDir) || ".";
  console.log(`\nWrote ${out}/shots.md. Put it in the PR body, then from ${out}:`);
  console.log(
    `  gh pr edit <pr> --body-file <body.md> ${files.map((f) => `--attach ${f}`).join(" ")} </dev/null`,
  );
}

const stop = (signal) => {
  console.error(`\npr-shots: ${signal}, cleaning up`);
  stopped = true;
  // A Ctrl-C reached the child already; a SIGTERM sent to this process alone didn't. Its exit
  // rejects its run, which unwinds through `captureBase`'s cleanup.
  if (current) terminate(current);
  process.exitCode = 130;
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

main().catch((error) => {
  console.error(`pr-shots: ${error.message}`);
  process.exitCode ||= 1;
});
