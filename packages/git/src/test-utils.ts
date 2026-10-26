import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { realPathSync } from "./paths.ts";

export const hasGit = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

/** A temp dir, realpath'd so macOS `/var` ↔ `/private/var` never splits two spellings of one path. */
export const tempDir = (): string =>
  realPathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "gram-git-test-")));

/** Codes Windows gives for a tree a just-exited git or watcher still holds. */
const BUSY: ReadonlySet<string> = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EMFILE", "ENFILE"]);

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const removeOnce = (dir: string) => fs.rmSync(dir, { recursive: true, force: true });

export interface RemoveDirOptions {
  /** How long a busy tree is retried before it's left behind. */
  readonly deadlineMs?: number;
  /** Deletes the tree once; tests swap it. */
  readonly rm?: (dir: string) => void;
}

/**
 * Deletes `dir` for cleanup. A busy tree is retried until `deadlineMs`, then logged and left behind,
 * so a loaded runner can't fail or stall a cleanup hook; any other error throws.
 */
export const removeDir = (
  dir: string,
  { deadlineMs = 20_000, rm = removeOnce }: RemoveDirOptions = {},
): void => {
  const deadline = Date.now() + deadlineMs;
  for (let attempt = 1; ; attempt++) {
    try {
      rm(dir);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!BUSY.has(code)) throw error;
      const delay = Math.min(100 * attempt, 1_000);
      if (Date.now() + delay > deadline) {
        console.warn(`removeDir: left ${dir} behind after ${attempt} attempts (${code})`);
        return;
      }
      sleepSync(delay);
    }
  }
};

/** Run git synchronously for fixture setup; throws with stderr on failure. */
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

/** `<tmp>/repo` with one commit of `tracked.txt` on `branch`, and a local identity. */
export const makeRepo = (tmp: string, branch = "main"): string => {
  const repo = nodePath.join(tmp, "repo");
  fs.mkdirSync(repo, { recursive: true });
  run(repo, "init", "-q", "-b", branch);
  run(repo, "config", "user.email", "t@t");
  run(repo, "config", "user.name", "t");
  run(repo, "config", "commit.gpgsign", "false");
  // Git for Windows' system config sets `autocrlf=true`, which checks LF files out as CRLF.
  run(repo, "config", "core.autocrlf", "false");
  write(nodePath.join(repo, "tracked.txt"), "tracked");
  run(repo, "add", "-A");
  run(repo, "commit", "-qm", "init");
  return repo;
};
