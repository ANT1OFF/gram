import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { realPathSync } from "@gram/git";
import * as Effect from "effect/Effect";

export const hasGit = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

/** A realpath'd temp dir, so macOS `/var` and `/private/var` never split one path in two. */
export const tempDir = (): string =>
  realPathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "gram-server-git-")));

/**
 * Deletes `dir` or throws. Retries (Node's linear backoff, about 5 s in all) because Windows refuses
 * to delete a tree a just-exited git or a just-released watcher still holds.
 */
export const removeDirStrict = (dir: string): void =>
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

/** Codes Windows gives for a tree a just-exited git or watcher still holds. */
const BUSY: ReadonlySet<string> = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EMFILE", "ENFILE"]);

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const removeOnce = (dir: string) => fs.rmSync(dir, { recursive: true, force: true });

/**
 * The git and gh processes still running on Windows, as candidates for what holds a tree. Given 2 s,
 * since it runs inside the cleanup's own deadline; past that it says so instead of stalling it.
 */
const runningGit = (): string => {
  if (process.platform !== "win32") return "n/a";
  const listed = spawnSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8", timeout: 2_000 });
  if (listed.error !== undefined) return `unknown (tasklist: ${listed.error.message})`;
  const lines = (listed.stdout ?? "")
    .split("\n")
    .filter((line) => /^"(git|gh)[\w-]*\.exe"/i.test(line));
  return lines.join(" | ") || "none";
};

/**
 * Deletes `dir` for cleanup. A busy tree is retried until `deadlineMs`, then logged, with the git and
 * gh processes still running, and left behind, so a loaded runner can't fail or stall a cleanup
 * hook; any other error throws. `rm` deletes the tree once; tests swap it. A tree that is busy at all
 * is logged when it first refuses and again when it goes, with how long it held the hook: a hook
 * cleaning several such trees can time out before any of them reaches its deadline.
 */
export const removeDir = (
  dir: string,
  {
    deadlineMs = 20_000,
    rm = removeOnce,
  }: { readonly deadlineMs?: number; readonly rm?: (dir: string) => void } = {},
): void => {
  const started = Date.now();
  const deadline = started + deadlineMs;
  for (let attempt = 1; ; attempt++) {
    try {
      rm(dir);
      if (attempt > 1) {
        console.warn(
          `removeDir: removed ${dir} after ${attempt} attempts in ${Date.now() - started} ms`,
        );
      }
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!BUSY.has(code)) throw error;
      if (attempt === 1) {
        console.warn(
          `removeDir: ${dir} is busy (${code}), retrying for up to ${deadlineMs} ms; running: ${runningGit()}`,
        );
      }
      const delay = Math.min(100 * attempt, 1_000);
      if (Date.now() + delay > deadline) {
        console.warn(
          `removeDir: left ${dir} behind after ${attempt} attempts in ${Date.now() - started} ms (${code}); running: ${runningGit()}`,
        );
        return;
      }
      sleepSync(delay);
    }
  }
};

export const run = (cwd: string, ...args: Array<string>): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });

export const write = (path: string, content: string): void => {
  fs.mkdirSync(nodePath.dirname(path), { recursive: true });
  fs.writeFileSync(path, content);
};

/** `<tmp>/repo` on `main` with one commit, a local identity, and `.worktrees/` ignored. */
export const makeRepo = (tmp: string): string => {
  const repo = nodePath.join(tmp, "repo");
  fs.mkdirSync(repo, { recursive: true });
  run(repo, "init", "-q", "-b", "main");
  run(repo, "config", "user.email", "t@t");
  run(repo, "config", "user.name", "t");
  run(repo, "config", "commit.gpgsign", "false");
  // Git for Windows' system config sets `autocrlf=true`, which checks LF files out as CRLF.
  run(repo, "config", "core.autocrlf", "false");
  write(nodePath.join(repo, "tracked.txt"), "tracked\n");
  write(nodePath.join(repo, ".gitignore"), ".worktrees/\n.claude/settings.local.json\n");
  run(repo, "add", "-A");
  run(repo, "commit", "-qm", "init");
  return repo;
};

/** Polls `check` on real time until it yields a value; for tests over real processes and watchers. */
export const eventually = <A, E, R>(
  label: string,
  check: Effect.Effect<A | undefined | false, E, R>,
  timeoutMs = 20_000,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = yield* check;
      if (value !== undefined && value !== false) return value;
      yield* Effect.sleep("25 millis");
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });
