import { batchFileInvocation, isWindowsBatchFile } from "@gram/contracts/shell";
import { execFile, spawn, type ChildProcess } from "node:child_process";

export const isRunning = (child: ChildProcess): boolean =>
  child.exitCode === null && child.signalCode === null;

/**
 * How to start `binary`: directly, except a Windows batch file (npm's `codex.cmd` or
 * `codex.cmd`), which Node only runs through `cmd.exe` (CVE-2024-27980), with its arguments escaped.
 */
export const serveInvocation = (
  binary: string,
  args: ReadonlyArray<string>,
  platform: NodeJS.Platform = process.platform,
): { readonly file: string; readonly args: ReadonlyArray<string>; readonly shell: boolean } =>
  platform === "win32" && isWindowsBatchFile(binary)
    ? { ...batchFileInvocation(binary, args), shell: true }
    : { file: binary, args, shell: false };

/** Starts a long-running agent process with piped output; stop it with `stopChild`. */
export const spawnServe = (
  binary: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  options: { readonly stdin?: "ignore" | "pipe"; readonly cwd?: string } = {},
): ChildProcess => {
  const invocation = serveInvocation(binary, args);
  const child = spawn(invocation.file, [...invocation.args], {
    env,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stdio: [options.stdin ?? "ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: invocation.shell,
  });
  // Observe the whole owned lifetime, before host exit listeners remove the child from their set.
  // stopChild's separate observer still records forced cleanup; a natural exit may never reach it.
  child.once("exit", () => recordShutdownExit(child, false));
  ownAgentChild(child, "serve");
  return child;
};

/**
 * Every agent process the server owns and hasn't seen exit: `serve` children (the `codex`
 * app-server) are stopped with `stopChild`; `session` children (a Claude Code CLI) end with the
 * session that started them. An update attests that none is left (`stopOwnedAgentsForUpdate`).
 */
const ownedAgents = new Map<ChildProcess, "serve" | "session">();
/** What each owned agent process was, kept past its exit for the shutdown check's report. */
const agentKinds = new WeakMap<ChildProcess, "serve" | "session">();

/**
 * Tracks `child` as an owned agent process until it exits; a spawn that failed is never tracked.
 * A `session` child's exit is recorded by the shutdown check too (a `serve` child's already is, by
 * `spawnServe`). Only the exit the CLI gives by itself once its input ends is orderly: the session
 * ends a turn still under way first, then the CLI saves its session and exits with the code
 * `cleanExit` names (Claude Code's is 1 when its last result was an error, else 0), or undefined
 * while a turn is still under way, which no exit ends cleanly. A signal proves neither who sent it
 * nor that the session was saved (the SDK's own SIGTERM comes after a 2 s grace, whatever the CLI
 * was doing), so any signal, SIGTERM included, or another code fails the update's `agents`
 * essential.
 */
export const ownAgentChild = (
  child: ChildProcess,
  kind: "serve" | "session",
  cleanExit: () => number | undefined = () => 0,
): void => {
  if (child.pid === undefined || !isRunning(child)) return;
  ownedAgents.set(child, kind);
  agentKinds.set(child, kind);
  child.once("exit", (code) => {
    ownedAgents.delete(child);
    // A signalled child's code is null, which no clean exit is.
    if (kind === "session" && code !== cleanExit()) notOrderly(child, false);
  });
};

/**
 * Ends `child`'s input, which a Claude Code CLI with no turn under way answers by saving its
 * session and exiting; resolves whether it exited within `boundMs`. It never signals the child.
 */
export const endInputAndWait = (child: ChildProcess, boundMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    if (!isRunning(child)) return resolve(true);
    const exited = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener("exit", exited);
      resolve(false);
    }, boundMs);
    child.once("exit", exited);
    child.stdin?.end();
  });

/** How many owned agent processes are still running. */
export const runningOwnedAgents = (): number =>
  [...ownedAgents.keys()].filter((child) => isRunning(child)).length;

/**
 * For an update only: stops every owned `serve` child through its normal `stopChild` path, then
 * waits up to `boundMs` for every owned agent process to have exited. Resolves with how many are
 * still running; the shutdown check (`beginChildShutdownCheck`) records a stop that had to force.
 */
export const stopOwnedAgentsForUpdate = async (
  boundMs: number,
  graceMs = 3_000,
): Promise<number> => {
  const running = [...ownedAgents].filter(([child]) => isRunning(child));
  const exits = running.map(
    ([child]) =>
      new Promise<void>((resolve) =>
        isRunning(child) ? child.once("exit", () => resolve()) : resolve(),
      ),
  );
  for (const [child, kind] of running) if (kind === "serve") void stopChild(child, graceMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(exits),
    new Promise<void>((resolve) => (timer = setTimeout(resolve, boundMs))),
  ]);
  clearTimeout(timer);
  return runningOwnedAgents();
};

// Process-local shutdown observation, enabled only by the server's shutdown request. It leaves
// normal quit's cleanup behavior intact while making forced/crashed owned-child exits observable.
interface ShutdownCheck {
  orderly: boolean;
  readonly exits: Array<NotOrderlyExit>;
}
let shutdownCheck: ShutdownCheck | undefined;

/** An owned child's exit the shutdown check didn't take as orderly: kinds, codes and signals only. */
export interface NotOrderlyExit {
  readonly kind: "serve" | "session" | "other";
  readonly code: number | null;
  readonly signal: string | null;
  /** Its stop had to force it, or gave up waiting for it. */
  readonly forced: boolean;
}

/** At most this many exits are kept for the shutdown's log line. */
const MAX_NOT_ORDERLY = 8;

const notOrderly = (child: ChildProcess, forced: boolean) => {
  if (shutdownCheck === undefined) return;
  shutdownCheck.orderly = false;
  if (shutdownCheck.exits.length < MAX_NOT_ORDERLY)
    shutdownCheck.exits.push({
      kind: agentKinds.get(child) ?? "other",
      code: child.exitCode,
      signal: child.signalCode,
      forced,
    });
};
const stoppingChildren = new WeakSet<ChildProcess>();
const switchStopping = new WeakSet<ChildProcess>();
const switchProtected = new WeakMap<ChildProcess, () => void>();

/**
 * Opt-in protection for a workspace switch. Keep it until startup is accepted, or until the
 * former child exits. A cancelled/failed switch must not let later cleanup escalate its stop.
 * The SDK can call `kill` itself, so the guard also covers that call site.
 */
export const protectChildForSwitch = (child: ChildProcess): (() => void) => {
  if (!isRunning(child)) return () => {};
  const existing = switchProtected.get(child);
  if (existing !== undefined) return existing;
  const kill = child.kill;
  const guarded: ChildProcess["kill"] = function (signal = "SIGTERM") {
    if (process.platform === "win32" || (signal !== "SIGTERM" && signal !== "SIGINT")) {
      return false;
    }
    return kill.call(child, signal);
  };
  const release = () => {
    if (switchProtected.get(child) !== release) return;
    switchProtected.delete(child);
    if (child.kill === guarded) child.kill = kill;
    child.removeListener("exit", release);
  };
  switchProtected.set(child, release);
  child.kill = guarded;
  child.once("exit", release);
  return release;
};

/** Accept only the still-live startup guard, never a cancelled owner's stop protection. */
export const acceptChildSwitchStartup = (child: ChildProcess, release: () => void): boolean => {
  if (!isRunning(child) || switchStopping.has(child) || switchProtected.get(child) !== release)
    return false;
  release();
  return true;
};

/** Requests graceful termination; only actual EXIT returns true. Timeout never escalates. */
export const stopChildForSwitch = (child: ChildProcess, graceMs = 3_000): Promise<boolean> => {
  if (!isRunning(child)) return Promise.resolve(true);
  protectChildForSwitch(child);
  switchStopping.add(child);
  // Windows' process termination is forced even for SIGTERM. No switch qualification there yet.
  if (process.platform === "win32") return Promise.resolve(false);
  return new Promise((resolve) => {
    stoppingChildren.add(child);
    const exited = () => {
      clearTimeout(timer);
      recordShutdownExit(child, false);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener("exit", exited);
      notOrderly(child, true);
      resolve(false);
    }, graceMs);
    child.once("exit", exited);
    // Ignore the return value: acceptance of a signal is not proof of process exit.
    child.kill("SIGTERM");
  });
};
export const beginChildShutdownCheck = (): (() => boolean) => {
  const check: ShutdownCheck = { orderly: true, exits: [] };
  shutdownCheck = check;
  return () => check.orderly;
};
/** The exits the current shutdown check didn't take as orderly, first ones first. */
export const notOrderlyExits = (): ReadonlyArray<NotOrderlyExit> => [
  ...(shutdownCheck?.exits ?? []),
];
const recordShutdownExit = (child: ChildProcess, forced: boolean) => {
  if (
    forced ||
    (child.exitCode !== null && child.exitCode !== 0) ||
    (child.signalCode !== null && (child.signalCode !== "SIGTERM" || !stoppingChildren.has(child)))
  )
    notOrderly(child, forced);
};

/**
 * Ends the direct `child` (Windows also requests tree termination); resolves once it has exited. On Windows a shimmed server
 * runs under `cmd.exe`, and killing only that would orphan the agent, so `taskkill /T /F` ends the
 * whole tree. Elsewhere: SIGTERM, then SIGKILL if it hasn't exited within `graceMs`.
 */
export const stopChild = (child: ChildProcess, graceMs = 3_000): Promise<void> =>
  switchProtected.has(child)
    ? stopChildForSwitch(child, graceMs).then(() => undefined)
    : new Promise((resolve) => {
        if (!isRunning(child)) {
          recordShutdownExit(child, false);
          return resolve();
        }
        stoppingChildren.add(child);
        let forced = false;
        const timer = setTimeout(() => {
          if (isRunning(child)) {
            forced = true;
            child.kill("SIGKILL");
          }
        }, graceMs);
        child.once("exit", () => {
          clearTimeout(timer);
          recordShutdownExit(child, forced);
          resolve();
        });
        if (process.platform === "win32" && child.pid !== undefined) {
          forced = true;
          execFile(
            "taskkill",
            ["/pid", String(child.pid), "/T", "/F"],
            { windowsHide: true },
            () => {
              if (isRunning(child)) child.kill();
            },
          );
        } else {
          child.kill("SIGTERM");
        }
      });
