// How a project's check runs as a process: its environment, the wrapper that leads its process
// group and writes how it ended, its timeout and stop, and what its exit means. Gram's own checks
// (`LocalChecksLive`) and a joined machine's (`host/checks.ts`) both run through it, so it imports
// nothing of the server's store: `gram-host` bundles it on its own.
import {
  redactText,
  DEFAULT_LOCAL_CHECK_TIMEOUT_MS,
  type ProjectLocalCheck,
} from "@gram/contracts";
import { canonicalizeOrOwned, isInside } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import * as nodePath from "node:path";

/** All configuration affecting reuse; a record without a project never authorizes a project's gate. */
export interface LocalCheckRun {
  /** How the source was isolated from the agent's repository (`LOCAL_CHECK_ISOLATION`). */
  readonly isolation: string;
  readonly command: string;
  readonly preparation?: NonNullable<ProjectLocalCheck["preparation"]>;
  readonly projectId?: string;
  readonly setup?: string;
  readonly timeoutMs?: number;
  /** Only `unavailable/v1`, for a stored recipe that can't be read; it never runs. */
  readonly profile?: string;
  readonly qualification?: string;
  readonly refusal?: string;
}

/** How long a stopped check's processes get to end on SIGTERM before SIGKILL. */
export const KILL_GRACE_MS = 10_000;

/** Why a check didn't pass, as the worker and the ledger are told it. */
export const LocalCheckFailure = Schema.Struct({
  kind: Schema.Literals([
    /** A command the check runs wasn't on its PATH. */
    "not-found",
    /** It ran past the configured timeout and was stopped. */
    "timed-out",
    /** It ran and exited non-zero: a failing check. */
    "exited",
    /** A signal stopped it. */
    "stopped",
    /** Gram couldn't start it, or prepare the source for it. */
    "unstartable",
    /** The head conflicts with its base: nothing to check. */
    "conflict",
  ]),
  /** The command that wasn't found. */
  command: Schema.optionalKey(Schema.String),
  /** The PATH the check ran on. */
  path: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.Number),
  /** The output's last lines. */
  tail: Schema.optionalKey(Schema.String),
});
export type LocalCheckFailure = typeof LocalCheckFailure.Type;

/** How a run ended: `reason` is its line, `failure` what a reader can act on. */
export interface LocalCheckOutcome {
  readonly ok: boolean;
  readonly reason?: string | undefined;
  readonly failure?: LocalCheckFailure | undefined;
}

/**
 * Git's variables that locate a repository, its objects, index or config, or inject config: one
 * inherited from Gram's own launch would point a git call made for the check (Gram's or the
 * check's own) at another repository, the agent's say, whatever folder it runs in. Only how git
 * reaches a remote and asks for credentials is kept.
 */
export const isGitControl = (name: string): boolean =>
  name.toUpperCase().startsWith("GIT_") &&
  !["GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT", "GIT_ASKPASS"].includes(name.toUpperCase());

/** Gram's own variables stay out of the check, whose tests set what they need themselves. */
const checkEnv = (
  base: Readonly<Record<string, string | undefined>>,
  pathValue: string,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (
      value === undefined ||
      name === "CI" ||
      isGitControl(name) ||
      (name.startsWith("GRAM_") && !name.startsWith("GRAM_CHECK_")) ||
      name.startsWith("SB_") ||
      name.startsWith("ELECTRON_")
    )
      continue;
    env[name] = value;
  }
  if (pathValue !== "") env["PATH"] = pathValue;
  return env;
};

export interface CheckEnvironment {
  /** The server's environment, filtered by `checkEnv`. */
  readonly base: Readonly<Record<string, string | undefined>>;
  /** The login-shell PATH; empty keeps `base`'s. */
  readonly pathValue: string;
  /** Grace for stopping remaining command processes; tests may shorten it. */
  readonly killGraceMs?: number | undefined;
  /** Keeps the check's source when its stopped processes couldn't be shown gone. */
  readonly retain?: (() => void) | undefined;
  /** Makes the check survive a quit, for Gram's own runs (`LocalChecksLive`). */
  readonly durable?: DurableCheck | undefined;
}

/** At most this much of the log's end is read to explain a failure. */
const TAIL_BYTES = 64 * 1024;

/** The end of `log`; empty when it can't be read. */
export const readTail = (log: string): string => {
  try {
    const fd = openSync(log, "r");
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
};

/**
 * `text` as plain lines: terminal escape sequences (colours, titles) and other control characters
 * gone, and a carriage return's overwrite kept as its last state.
 */
const plainLines = (text: string): Array<string> =>
  text
    // oxlint-disable-next-line no-control-regex -- terminal escape sequences
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g, "")
    .split("\n")
    .map((line) => {
      const parts = line.split("\r").filter((part) => part !== "");
      // oxlint-disable-next-line no-control-regex -- the control characters left
      return (parts.at(-1) ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trimEnd();
    });

/**
 * The last few non-blank lines of `text`, plain and bounded for a message, with anything shaped
 * like a secret redacted: the check runs with the server's environment, which a test may print.
 */
export const lastLines = (text: string, lines = 12, chars = 1500): string => {
  const kept = redactText(
    plainLines(text)
      .filter((line) => line.trim() !== "")
      .slice(-lines)
      .join("\n"),
  );
  return kept.length > chars ? `…${kept.slice(-chars)}` : kept;
};

/**
 * The command a shell or `env` said it couldn't find, the last one named in `output`: bash's
 * `sh: line 1: foo: command not found`, dash's `sh: 1: foo: not found`, zsh's and Bun's
 * `command not found: foo` and `env: foo: No such file or directory`. Only a line a shell or `env`
 * starts counts, so a test's own `Error: command not found` blames nothing.
 */
export const missingCommand = (output: string): string | undefined => {
  const shell = String.raw`(?:\S*/)?(?:ba|z|da|k)?sh`;
  const name = String.raw`([^\s:'"‘’]+)`;
  const patterns = [
    // A script names itself by its path: `./scripts/x.sh: line 3: foo: command not found` in bash,
    // `./scripts/x.sh: 3: foo: not found` in dash (`/bin/sh` on Debian and Ubuntu).
    new RegExp(String.raw`^(?:${shell}|\S*/\S*): (?:line \d+: )?${name}: command not found$`),
    new RegExp(String.raw`^(?:${shell}|\S*/\S*): \d+: ${name}: not found$`),
    new RegExp(String.raw`^(?:${shell}|(?:\S*/)?bun): command not found: ${name}$`),
    new RegExp(String.raw`^(?:\S*/)?env: ['"‘]?${name}['"’]?: No such file or directory$`),
  ];
  let found: string | undefined;
  for (const line of plainLines(output)) {
    for (const pattern of patterns) {
      const match = pattern.exec(line.trim());
      if (match !== null) {
        found = match[1];
        break;
      }
    }
  }
  return found;
};

/** What an exit means, from its code, signal and output: the line a worker can act on. */
export const diagnoseExit = (
  code: number | null,
  signal: NodeJS.Signals | null,
  output: string,
  pathValue: string,
): LocalCheckOutcome => {
  if (code === 0) return { ok: true };
  const tail = lastLines(output);
  const withTail = (failure: LocalCheckFailure): LocalCheckFailure =>
    tail === "" ? failure : { ...failure, tail };
  if (signal !== null)
    return {
      ok: false,
      reason: `stopped by ${signal}`,
      failure: withTail({ kind: "stopped" }),
    };
  if (code === 127) {
    const command = missingCommand(output);
    return {
      ok: false,
      reason: `${command === undefined ? "a command" : `\`${command}\``} was not found on the check's PATH (exit 127); install it or add its folder to PATH in your shell profile, then restart Gram. PATH=${pathValue}`,
      failure: withTail({
        kind: "not-found",
        ...(command === undefined ? {} : { command }),
        path: pathValue,
        exitCode: 127,
      }),
    };
  }
  return {
    ok: false,
    reason: `exited ${code}`,
    failure: withTail({ kind: "exited", ...(code === null ? {} : { exitCode: code }) }),
  };
};

/**
 * What makes a check's command durable across a quit (`LocalChecksLive`): where its wrapper writes
 * how it ended, a record of its process made before Gram waits on it, and whether a stop is Gram
 * quitting, which leaves the recorded process running for the next start to take back.
 */
export interface DurableCheck {
  /** The file the wrapper writes the exit status to, outside the checked tree. */
  readonly status: string;
  /** Records the started process; false when it couldn't be, and a quit then stops it. */
  readonly started: (process: CheckProcess) => Effect.Effect<boolean>;
  /** Whether Gram is quitting, so a recorded process is left running. */
  readonly detach: () => boolean;
}

/** A check's running wrapper, as recorded to take it back after a restart. */
export interface CheckProcess {
  readonly pid: number;
  /** `ps`'s start time of `pid`: with the PID and its folder, what proves it is still this one. */
  readonly processStart: string;
  /** Epoch ms when Gram stops it. */
  readonly deadline: number;
  /** The PATH it runs on, for explaining a missing command after a restart. */
  readonly pathValue: string;
}

/**
 * The setup and the command, each in its own shell, in one wrapper that leads the check's process
 * group and writes the exit status (`$1`) once they end: a check Gram left running when it quit
 * still says how it ended to the next start. A watchdog in the group stops it, SIGTERM then
 * SIGKILL after `$5` seconds, once `$4` seconds pass with the wrapper still there: the timeout Gram
 * isn't running to enforce. It ignores SIGTERM only once it sent its own, so Gram's stops it at once.
 */
const WRAPPER = `status=$1 setup=$2 command=$3 limit=$4 grace=$5
(
  n=0
  while [ "$n" -lt "$limit" ]; do
    sleep 1
    kill -0 $$ 2>/dev/null || exit 0
    n=$((n + 1))
  done
  trap '' TERM
  kill -TERM 0
  sleep "$grace"
  kill -KILL 0
) &
code=0
if [ -n "$setup" ]; then /bin/sh -c "$setup"; code=$?; fi
if [ "$code" -eq 0 ]; then /bin/sh -c "$command"; code=$?; fi
if [ -n "$status" ]; then printf '%s\\n' "$code" > "$status.tmp" && mv -f "$status.tmp" "$status"; fi
exit "$code"`;

/** How long past its timeout the watchdog waits for Gram to stop a check, before doing it. */
const WATCHDOG_SLACK_S = 30;

/** Configured setup then check on the resolved login-shell PATH, with shared diagnostics. */
export const spawnCheck = (
  dir: string,
  log: string,
  environment: CheckEnvironment,
  run: LocalCheckRun,
) =>
  Effect.gen(function* () {
    const env = checkEnv(environment.base, environment.pathValue);
    // Only the approved recipe can supply this binding; never inherit a caller's claim.
    delete env["GRAM_CHECK_SOURCE_SELECTION_MANIFEST"];
    delete env["GRAM_CHECK_SOURCE_SELECTION_SHA256"];
    delete env["GRAM_CHECK_APPROVED_INPUT_SHA256"];
    if (run.preparation !== undefined) {
      env["GRAM_CHECK_SOURCE_SELECTION_MANIFEST"] = run.preparation.manifest;
      env["GRAM_CHECK_SOURCE_SELECTION_SHA256"] = run.preparation.sha256;
      if (run.preparation.inputConfigSha256 !== undefined) {
        env["GRAM_CHECK_APPROVED_INPUT_SHA256"] = run.preparation.inputConfigSha256;
      }
    }
    const timeoutMs = run.timeoutMs ?? DEFAULT_LOCAL_CHECK_TIMEOUT_MS;
    const graceMs = environment.killGraceMs ?? KILL_GRACE_MS;
    return yield* spawnCommand(
      dir,
      log,
      env,
      run.setup ?? "",
      run.command,
      timeoutMs,
      graceMs,
      environment.retain,
      environment.durable,
    );
  });

/** `90 minutes`, `1 minute`, `500 ms`. */
const spell = (ms: number) =>
  ms >= 60_000 && ms % 60_000 === 0
    ? `${ms / 60_000} minute${ms === 60_000 ? "" : "s"}`
    : `${ms} ms`;

export const timedOut = (log: string, timeoutMs: number): LocalCheckOutcome => {
  const tail = lastLines(readTail(log));
  return {
    ok: false,
    reason: `timed out: still running after ${spell(timeoutMs)}, so Gram stopped it`,
    failure: { kind: "timed-out", ...(tail === "" ? {} : { tail }) },
  };
};

/**
 * How long a group sent SIGKILL gets to be gone, its leader reaped, before Gram stops waiting and
 * keeps the check's source (`CheckEnvironment.retain`): a process stuck in the kernel outlives it.
 */
const REAP_MS = 5_000;

/** Sends `signal` to the process group `pgid`; false when there is none. */
const signalGroup = (pgid: number, signal: NodeJS.Signals | 0) => {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
};

/**
 * Stops a check's process group: SIGTERM, SIGKILL for whatever is still there after `graceMs`,
 * then a wait of up to `REAP_MS` for it to be gone. True once `present` says it is gone; false when
 * it couldn't be shown gone, or `present` stopped vouching that the group is the check's.
 */
const stopGroup = (
  pgid: number,
  present: () => "ours" | "gone" | "unsure",
  graceMs: number,
): Promise<boolean> =>
  new Promise<boolean>((done) => {
    const first = present();
    if (first !== "ours") return done(first === "gone");
    signalGroup(pgid, "SIGTERM");
    const stoppedAt = Date.now();
    let killed = false;
    const poll = setInterval(() => {
      const now = present();
      if (now !== "ours") {
        clearInterval(poll);
        return done(now === "gone");
      }
      const waited = Date.now() - stoppedAt;
      if (!killed && waited >= graceMs) {
        killed = true;
        signalGroup(pgid, "SIGKILL");
      }
      if (waited >= graceMs + REAP_MS) {
        clearInterval(poll);
        done(false);
      }
    }, 50);
  });

/**
 * The wrapper in its own process group. However it ends (exit, timeout, interruption), what is
 * left of the group, such as a watcher it started in the background, is stopped before the result
 * is told, the interruption ends and the worktree is removed (`stopGroup`). A group that can't be
 * shown gone keeps the source (`retain`). Only this group is signalled, by the id it was spawned
 * with; a process that left it (`setsid`) is beyond what Gram can follow. Interrupted while Gram
 * quits, a durable check that was recorded is left running instead (`DurableCheck`).
 */
const spawnCommand = (
  dir: string,
  log: string,
  env: Record<string, string>,
  setup: string,
  command: string,
  timeoutMs: number,
  graceMs: number,
  retain?: () => void,
  durable?: DurableCheck,
) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const pathValue = env["PATH"] ?? "";
      const deadline = Date.now() + timeoutMs;
      const running = yield* Effect.sync(() => {
        const fd = openSync(log, "w");
        const child = (() => {
          try {
            return spawn(
              "/bin/sh",
              [
                "-c",
                WRAPPER,
                "gram-check",
                durable?.status ?? "",
                setup,
                command,
                String(Math.ceil(timeoutMs / 1000) + WATCHDOG_SLACK_S),
                String(Math.ceil(graceMs / 1000)),
              ],
              { cwd: dir, env, detached: true, stdio: ["ignore", fd, fd] },
            );
          } finally {
            closeSync(fd);
          }
        })();
        /** Node reaped the leader: until then its zombie keeps the group's id taken. */
        let reaped = child.pid === undefined;
        const present = () =>
          !reaped || (child.pid !== undefined && signalGroup(child.pid, 0)) ? "ours" : "gone";
        let stopping: Promise<void> | undefined;
        /** Stops what is left of the group and waits for it to be gone, once however often asked. */
        const stop = () =>
          (stopping ??=
            child.pid === undefined
              ? Promise.resolve()
              : stopGroup(child.pid, present, graceMs).then((gone) => {
                  if (!gone) retain?.();
                }));
        let settled = false;
        let release: (() => void) | undefined;
        const outcome = new Promise<LocalCheckOutcome>((resolve) => {
          /** Stops what is left of the group, then tells `outcome`, once. */
          const settle = (told: () => LocalCheckOutcome) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            void stop().then(() => resolve(told()));
          };
          const timer = setTimeout(() => {
            // Like the exit handler, capture the check's output before stopping its group:
            // bash can print a termination notice while its children are being killed.
            const result = timedOut(log, timeoutMs);
            settle(() => result);
          }, timeoutMs);
          release = () => {
            settled = true;
            clearTimeout(timer);
          };
          child.once("error", (error) => {
            if (child.pid === undefined) reaped = true;
            settle(() => ({
              ok: false,
              reason: `couldn't start: ${error.message}`,
              failure: { kind: "unstartable", path: pathValue },
            }));
          });
          child.once("exit", (code, signal) => {
            reaped = true;
            // Read now: what the group's leftovers print while they are stopped is not the check's.
            const output = readTail(log);
            settle(() => diagnoseExit(code, signal, output, pathValue));
          });
        });
        return {
          pid: child.pid,
          outcome,
          stop: () => {
            release?.();
            return stop();
          },
          /** Lets it run on past Gram: nothing of it keeps this process alive. */
          leave: () => {
            release?.();
            child.unref();
          },
        };
      });
      let recorded = false;
      return yield* restore(
        Effect.gen(function* () {
          if (durable !== undefined && running.pid !== undefined) {
            const processStart = processStartOf(running.pid);
            if (processStart !== undefined)
              recorded = yield* durable.started({
                pid: running.pid,
                processStart,
                deadline,
                pathValue,
              });
          }
          return yield* Effect.promise(() => running.outcome);
        }),
      ).pipe(
        // Interrupted, the group is stopped the same way, and the interruption waits for it;
        // unless Gram is quitting and the next start can take it back.
        Effect.onInterrupt(() =>
          recorded && durable?.detach() === true
            ? Effect.sync(running.leave)
            : Effect.promise(running.stop),
        ),
      );
    }),
  );

/** `ps`, at its path: an app opened from the Dock has launchd's PATH, and a shell may alias it. */
const PS = ["/bin/ps", "/usr/bin/ps"].find((path) => existsSync(path)) ?? "ps";

/** When `pid` started, as `ps` says it, in a fixed locale; undefined when it isn't there. */
const processStartOf = (pid: number): string | undefined => {
  try {
    const out = execFileSync(PS, ["-o", "lstart=", "-p", String(pid)], {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "" ? undefined : out;
  } catch {
    return undefined;
  }
};

/** The folder `pid` runs in; undefined when it can't be read. */
const processCwdOf = (pid: number): string | undefined => {
  try {
    if (process.platform === "linux") return readlinkSync(`/proc/${pid}/cwd`);
    const out = execFileSync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = out.split("\n").find((each) => each.startsWith("n"));
    return line === undefined ? undefined : line.slice(1);
  } catch {
    return undefined;
  }
};

/**
 * Whether a process of the group `pgid` runs inside the worktree `work`: what a check leaves
 * behind inherits its folder, and no other process has a reason to be in Gram's own worktree.
 */
const memberInWork = (pgid: number, work: string): boolean => {
  try {
    const members = execFileSync(PS, ["-A", "-o", "pid=,pgid="], {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    })
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter(([pid, group]) => group === pgid && Number.isInteger(pid))
      .map(([pid]) => pid!);
    const root = canonicalizeOrOwned(work);
    return members.some((pid) => {
      const cwd = processCwdOf(pid);
      if (cwd === undefined) return false;
      return isInside(root, canonicalizeOrOwned(cwd));
    });
  } catch {
    return false;
  }
};

/**
 * Whether the check's process group is still the one recorded. `ours`: its leader is there with
 * the recorded start time and, when `checkCwd`, folder. `gone`: no such group, or the PID now
 * names a process that started later, which it couldn't while the check's group was there.
 * Without its leader, the group is `ours` when, `checkCwd`, one of its processes runs inside the
 * worktree, and otherwise `leaderless`: only a caller who verified it before may take it as the
 * check's. `unsure`: the start time
 * matches but the folder doesn't, or can't be read.
 */
export const recordedGroup = (
  job: { readonly pid: number; readonly processStart: string; readonly work: string },
  checkCwd = true,
): "ours" | "gone" | "leaderless" | "unsure" => {
  if (!signalGroup(job.pid, 0)) return "gone";
  const leaderless = () => (checkCwd && memberInWork(job.pid, job.work) ? "ours" : "leaderless");
  try {
    process.kill(job.pid, 0);
  } catch {
    return leaderless();
  }
  const start = processStartOf(job.pid);
  if (start === undefined) return signalGroup(job.pid, 0) ? leaderless() : "gone";
  if (start !== job.processStart) return "gone";
  if (!checkCwd) return "ours";
  const cwd = processCwdOf(job.pid);
  return cwd !== undefined && canonicalizeOrOwned(cwd) === canonicalizeOrOwned(job.work)
    ? "ours"
    : "unsure";
};

/**
 * Stops the group `pgid` of a check Gram took back, which the caller has just verified as the
 * check's: while any of it is left, no other process can take its id. True once it is gone.
 */
export const stopVerifiedGroup = (pgid: number, graceMs = KILL_GRACE_MS) =>
  stopGroup(pgid, () => (signalGroup(pgid, 0) ? "ours" : "gone"), graceMs);

/** How many seconds a group without its leader, unverified, gets to be gone before it is kept. */
export const LEADERLESS_WAITS = 5;

/** In a work folder, marks a worktree kept because its processes weren't shown gone. */
export const RETAINED = "retained";

/** Marks the work folder of the worktree `dir` as kept: nothing reclaims it. */
export const markRetained = (dir: string) => {
  try {
    writeFileSync(nodePath.join(nodePath.dirname(dir), RETAINED), "");
  } catch {
    // The worktree is kept regardless; only retention reads this.
  }
};

/** The status the wrapper wrote, or undefined when it wrote none. */
export const readExitStatus = (path: string): number | undefined => {
  try {
    const text = readFileSync(path, "utf8").trim();
    return /^\d{1,3}$/.test(text) ? Number(text) : undefined;
  } catch {
    return undefined;
  }
};

/** How a check ended that Gram took back, from what its wrapper wrote and its log's end. */
export const recordedOutcome = (code: number, log: string, pathValue: string): LocalCheckOutcome =>
  diagnoseExit(code, null, readTail(log), pathValue);
