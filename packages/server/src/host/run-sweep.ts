// Ends what a kept-running host's runs started that its service manager's own stop may miss. Each
// start of the service carries a run token in its environment, which its agents, shells and tools
// inherit. A stop finds this user's processes whose environment carries one of the service's
// outstanding tokens and ends them: asked first, then killed.
//
// It acts on structured process facts only: the effective user, the token as an entry of the
// environment (never text in the command line), and the process's start time, checked again right
// before each signal so a pid reused since the scan is never signalled. A scan that can't read all
// of this user's processes is a failure, never an empty result: a stop then fails and keeps its
// records for another try.
//
// This is not containment. A process that clears its environment (`env -i`) carries no token. On
// Linux the systemd unit's control group holds such a process anyway, and the stop is verified on
// that group (`stopLocalService`); on macOS nothing holds it once it has left the job's process
// group, and the docs say so.

import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import * as Effect from "effect/Effect";

/** The environment name of the run token. Its value is random and says nothing else. */
export const RUN_TOKEN_ENV = "GRAM_LOCAL_HOST_RUN";

const TOKEN = /^[0-9a-f]{32,64}$/;

/** How long processes asked to end get before they are killed. */
const GRACE_MS = 2_000;

/** One process carrying a token: who it is, by pid and start time, so a reused pid isn't it. */
export interface Carrier {
  readonly pid: number;
  readonly start: string;
}

/** A scan of this user's processes: complete, or why it isn't. */
export type Scan =
  | { readonly ok: true; readonly carriers: ReadonlyArray<Carrier> }
  | { readonly ok: false; readonly reason: string };

export type Scanner = (tokens: ReadonlyArray<string>) => Effect.Effect<Scan>;

const gone = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ESRCH";
};

/**
 * This user's processes carrying one of `tokens`, from `/proc` (Linux). A process of this user
 * whose environment can't be read (one that made itself non-dumpable, such as `sshd-session`) is
 * judged by its control group instead, which it can't leave: it is the service's when it is in
 * `unit`'s group. One whose group can't be read either fails the scan.
 */
export const procScan = (
  tokens: ReadonlyArray<string>,
  proc = "/proc",
  uid = process.getuid?.() ?? -1,
  self = process.pid,
  unit?: string,
): Scan => {
  const wanted = new Set(tokens.map((token) => `${RUN_TOKEN_ENV}=${token}`));
  let entries: Array<string>;
  try {
    entries = readdirSync(proc);
  } catch (error) {
    return { ok: false, reason: `couldn't list ${proc}: ${String(error)}` };
  }
  const carriers: Array<Carrier> = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === self) continue;
    try {
      const status = readFileSync(`${proc}/${entry}/status`, "utf8");
      // Real, effective, saved and filesystem user ids; the effective one is whose it is.
      const euid = Number(/^Uid:\s+\d+\s+(\d+)/m.exec(status)?.[1] ?? Number.NaN);
      if (Number.isNaN(euid)) return { ok: false, reason: `unreadable status for ${entry}` };
      if (euid !== uid) continue;
      const stat = readFileSync(`${proc}/${entry}/stat`, "utf8");
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      if (start === undefined) return { ok: false, reason: `unreadable stat for ${entry}` };
      let environ: Array<string> | undefined;
      try {
        environ = readFileSync(`${proc}/${entry}/environ`, "utf8").split("\0");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
      }
      const ours =
        environ === undefined
          ? unit !== undefined &&
            readFileSync(`${proc}/${entry}/cgroup`, "utf8")
              .split("\n")
              .some((line) => line.split("/").includes(unit))
          : environ.some((variable) => wanted.has(variable));
      if (ours) carriers.push({ pid: Number(entry), start });
    } catch (error) {
      if (gone(error)) continue;
      return { ok: false, reason: `couldn't read process ${entry}: ${String(error)}` };
    }
  }
  return { ok: true, carriers };
};

const PLAIN = /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ \d\d:\d\d:\d\d \d{4}) (.*)$/;
const WITH_ENV = /^\s*(\d+) (.*)$/;

/**
 * This user's processes carrying one of `tokens`, from two `ps` listings (macOS): `plain` with each
 * process's user, start time and command line, and `withEnv` with the command line followed by the
 * environment (`ps -E`). The environment is what follows the command line, so a token written in a
 * command line only (an argument, another instance's grep) is never taken for one.
 */
export const psScan = (
  tokens: ReadonlyArray<string>,
  plain: string,
  withEnv: string,
  uid = process.getuid?.() ?? -1,
  self = process.pid,
): Scan => {
  const env = new Map<number, string>();
  for (const line of withEnv.split("\n")) {
    const match = WITH_ENV.exec(line);
    if (match !== null) env.set(Number(match[1]), match[2]!);
  }
  const wanted = new Set(tokens.map((token) => `${RUN_TOKEN_ENV}=${token}`));
  const carriers: Array<Carrier> = [];
  let rows = 0;
  for (const line of plain.split("\n")) {
    if (line.trim() === "") continue;
    const match = PLAIN.exec(line);
    if (match === null) return { ok: false, reason: `an unreadable ps line: ${line.slice(0, 80)}` };
    rows += 1;
    const pid = Number(match[1]);
    if (Number(match[2]) !== uid || pid === self) continue;
    const command = match[4]!;
    const full = env.get(pid);
    // Gone between the two listings: not one of ours any more.
    if (full === undefined) continue;
    if (!full.startsWith(command))
      return { ok: false, reason: `process ${pid} changed between the two listings` };
    const variables = full.slice(command.length).trim().split(/\s+/);
    if (variables.some((variable) => wanted.has(variable)))
      carriers.push({ pid, start: match[3]! });
  }
  return rows === 0 ? { ok: false, reason: "ps listed no processes" } : { ok: true, carriers };
};

const ps = (args: ReadonlyArray<string>) =>
  Effect.callback<{ readonly ok: boolean; readonly out: string }>((resume) => {
    const child = execFile(
      "ps",
      [...args],
      { timeout: 10_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => resume(Effect.succeed({ ok: error === null, out: stdout })),
    );
    return Effect.sync(() => child.kill());
  });

/** The scanner of this platform; on any other, a scan always fails. */
export const systemScanner =
  (platform: NodeJS.Platform = process.platform, unit?: string): Scanner =>
  (tokens) =>
    platform === "linux"
      ? Effect.sync(() => procScan(tokens, "/proc", undefined, undefined, unit))
      : platform === "darwin"
        ? Effect.gen(function* () {
            const plain = yield* ps(["-ax", "-ww", "-o", "pid=,uid=,lstart=,command="]);
            const withEnv = yield* ps(["-E", "-ax", "-ww", "-o", "pid=,command="]);
            if (!plain.ok || !withEnv.ok) return { ok: false, reason: "ps failed" } as const;
            return psScan(tokens, plain.out, withEnv.out);
          })
        : Effect.succeed({ ok: false, reason: `no process scan on ${platform}` } as const);

/** Signals a process; one already gone is fine. */
export type Signaller = (pid: number, signal: NodeJS.Signals) => void;
const systemSignal: Signaller = (pid, signal) => {
  try {
    process.kill(pid, signal);
  } catch {
    // Gone already.
  }
};

const scanOrFail = (scanner: Scanner, tokens: ReadonlyArray<string>, when: string) =>
  Effect.flatMap(scanner(tokens), (scan) =>
    scan.ok
      ? Effect.succeed(scan.carriers)
      : Effect.fail(
          new Error(
            `Couldn't check what the service started (${when}: ${scan.reason}); try Stop again.`,
          ),
        ),
  );

/** Signals `signal` to each of `earlier` still the same process (pid and start) in a fresh scan. */
const signalSame = (
  scanner: Scanner,
  tokens: ReadonlyArray<string>,
  earlier: ReadonlyArray<Carrier>,
  signal: NodeJS.Signals,
  send: Signaller,
) =>
  Effect.gen(function* () {
    const now = yield* scanOrFail(scanner, tokens, `before ${signal}`);
    const same = now.filter((carrier) =>
      earlier.some((was) => was.pid === carrier.pid && was.start === carrier.start),
    );
    for (const carrier of same) send(carrier.pid, signal);
    return now;
  });

/**
 * Ends every process carrying one of `tokens`: SIGTERM, then SIGKILL for any left after the grace.
 * Fails when any scan, the last one after the kill included, isn't complete, or when a carrier is
 * still there at the end. Answers how many were found.
 */
export const sweepRun = (
  tokens: ReadonlyArray<string>,
  scanner: Scanner = systemScanner(),
  graceMs = GRACE_MS,
  send: Signaller = systemSignal,
): Effect.Effect<{ readonly found: number }, Error> =>
  Effect.gen(function* () {
    const valid = tokens.filter((token) => TOKEN.test(token));
    if (valid.length === 0) return { found: 0 };
    const found = yield* scanOrFail(scanner, valid, "the first scan");
    if (found.length === 0) return { found: 0 };
    let left = yield* signalSame(scanner, valid, found, "SIGTERM", send);
    const until = Date.now() + graceMs;
    while (left.length > 0 && Date.now() < until) {
      yield* Effect.sleep("100 millis");
      left = yield* scanOrFail(scanner, valid, "while they ended");
    }
    if (left.length > 0) {
      yield* signalSame(scanner, valid, left, "SIGKILL", send);
      yield* Effect.sleep("200 millis");
    }
    const after = yield* scanOrFail(scanner, valid, "after the kill");
    if (after.length > 0)
      return yield* Effect.fail(
        new Error(
          `${after.length} ${after.length === 1 ? "process" : "processes"} it started couldn't be ended (${after.map((c) => c.pid).join(", ")}).`,
        ),
      );
    return { found: found.length };
  });
