// Ends everything a kept-running host started, however it got away. Each start of the service
// carries a run token in its environment, which every agent, shell and tool under it inherits. A
// shell in a pseudo-terminal has a session of its own, and what it puts in the background can
// outlive it; on Linux the unit's control group still holds them, but launchd ends only the job's
// own process group. So a stop also finds every process of this user whose environment carries the
// token, and ends it: asked first, then killed.

import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import * as Effect from "effect/Effect";

/** The environment name of the run token. Its value is random and says nothing else. */
export const RUN_TOKEN_ENV = "GRAM_LOCAL_HOST_RUN";

const TOKEN = /^[0-9a-f]{32,64}$/;

/** How long processes asked to end get before they are killed. */
const GRACE_MS = 2_000;

/** The pids whose environment carries `RUN_TOKEN_ENV=<token>`, by `/proc` (Linux). */
export const procCarriers = (token: string, proc = "/proc"): Array<number> => {
  const needle = Buffer.from(`${RUN_TOKEN_ENV}=${token}\0`);
  const found: Array<number> = [];
  let entries: Array<string>;
  try {
    entries = readdirSync(proc);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      // Only this user's processes can be read; anyone else's throws and is skipped.
      if (readFileSync(`${proc}/${entry}/environ`).includes(needle)) found.push(Number(entry));
    } catch {
      // Gone, or not ours.
    }
  }
  return found;
};

/**
 * The pids whose environment carries the token, in `ps -E` output (macOS): each line is a pid,
 * then the command with the process's environment after it.
 */
export const psCarriers = (token: string, listing: string): Array<number> => {
  const word = new RegExp(`(?:^|\\s)${RUN_TOKEN_ENV}=${token}(?:\\s|$)`);
  const found: Array<number> = [];
  for (const line of listing.split("\n")) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);
    if (match !== null && word.test(match[2]!)) found.push(Number(match[1]));
  }
  return found;
};

const psListing = () =>
  Effect.callback<string>((resume) => {
    const child = execFile(
      "ps",
      ["-E", "-ww", "-ax", "-o", "pid=", "-o", "command="],
      { timeout: 10_000, maxBuffer: 64 * 1024 * 1024 },
      (_error, stdout) => resume(Effect.succeed(stdout)),
    );
    return Effect.sync(() => child.kill());
  });

/** The pids carrying `token` now, but this process. */
export const carriers = (
  token: string,
  platform: NodeJS.Platform = process.platform,
): Effect.Effect<ReadonlyArray<number>> =>
  (platform === "linux"
    ? Effect.sync(() => procCarriers(token))
    : platform === "darwin"
      ? Effect.map(psListing(), (listing) => psCarriers(token, listing))
      : Effect.succeed([] as Array<number>)
  ).pipe(Effect.map((pids) => pids.filter((pid) => pid !== process.pid)));

const signal = (pid: number, name: NodeJS.Signals) => {
  try {
    process.kill(pid, name);
  } catch {
    // Gone already.
  }
};

/**
 * Ends every process carrying `token`: SIGTERM, then SIGKILL for any left after the grace. Answers
 * how many were found, and the pids still there after the kill (none, unless one couldn't be).
 */
export const sweepRun = (
  token: string,
  platform: NodeJS.Platform = process.platform,
  graceMs = GRACE_MS,
): Effect.Effect<{ readonly found: number; readonly left: ReadonlyArray<number> }> =>
  Effect.gen(function* () {
    if (!TOKEN.test(token)) return { found: 0, left: [] };
    const found = yield* carriers(token, platform);
    if (found.length === 0) return { found: 0, left: [] };
    for (const pid of found) signal(pid, "SIGTERM");
    const until = Date.now() + graceMs;
    let left = yield* carriers(token, platform);
    while (left.length > 0 && Date.now() < until) {
      yield* Effect.sleep("100 millis");
      left = yield* carriers(token, platform);
    }
    for (const pid of left) signal(pid, "SIGKILL");
    if (left.length > 0) yield* Effect.sleep("200 millis");
    return { found: found.length, left: yield* carriers(token, platform) };
  });
