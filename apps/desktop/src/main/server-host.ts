// Owns the server process (src/server) for main: forks it, reads its boot URL, relays its output to
// the shell's log and its messages to main, stops it, and restarts it when it dies unasked. There is
// one child at a time. A child that was stopped, or that exited, is detached at once, so a late
// event from it changes nothing. A stop the host was asked for cancels any restart and never leads
// to one: only `start` and `retry` fork after it. Electron stays out of this module, so tests drive
// it with fakes.

import type { UpdateEssential } from "@gram/contracts";
import { createInterface } from "node:readline";

import { bootUrlFromLine, bootUrlFromMessage, isBootLine } from "./boot.ts";

/** How long `stop` waits for the server to exit after asking it to, before killing it outright. */
const STOP_TIMEOUT_MS = 10_000;
/** How long `stop` waits after a forced kill before reporting the server is still there. */
const FORCE_KILL_GRACE_MS = 2_000;
/** How long a start may take to report boot before the child is killed. */
const BOOT_TIMEOUT_MS = 120_000;

/**
 * What `stop` posts to have the server shut down by itself (`packages/server/src/runtime/shutdown.ts`).
 * A message, because no signal gives it the time: see `detach`.
 */
export const SHUTDOWN_REQUEST = { type: "shutdown" } as const;
/**
 * The same for an update: the server also attests its essentials and seals them, after which `stop`
 * kills the rest of its tree rather than wait out its whole teardown (`UPDATE_ESSENTIALS`).
 */
export const UPDATE_SHUTDOWN_REQUEST = { type: "shutdown", reason: "update" } as const;

/**
 * How a running server is asked whether it still answers: an HTTP request to its port that
 * resolves on any response and rejects on none within `timeoutMs`. The process can be alive with
 * its event loop stuck, which no exit reports.
 */
export interface HealthCheck {
  readonly ping: (url: string, timeoutMs: number) => Promise<void>;
  /** The wait between one answer and the next ping. */
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  /** How long it may go unanswered before it is killed and restarted like a crash. */
  readonly hungMs?: number;
}

const HEALTH_INTERVAL_MS = 15_000;
const HEALTH_TIMEOUT_MS = 10_000;
/** Far past the longest stall seen (8 s): a restart costs every running turn. */
const HEALTH_HUNG_MS = 120_000;

/** When and how often an unexpected exit is answered with a restart. */
export interface RecoveryPolicy {
  /** Restarts tried in a row before giving up; 0 never restarts. */
  readonly attempts: number;
  /** The wait before the first restart, doubled for each one after it. */
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** A server that stayed up this long after booting starts the next count afresh. */
  readonly stableMs: number;
}

/** Up to five restarts in a row, 1 s apart and then doubling (1, 2, 4, 8, 16 s). */
export const DEFAULT_RECOVERY: RecoveryPolicy = {
  attempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  stableMs: 60_000,
};

export const NO_RECOVERY: RecoveryPolicy = { ...DEFAULT_RECOVERY, attempts: 0 };

/** The wait before restart number `attempt` (from 1). */
export const restartDelay = (policy: RecoveryPolicy, attempt: number): number =>
  Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);

/** The slice of Electron's `UtilityProcess` the host uses. */
export interface ServerChild {
  readonly pid: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  postMessage(message: unknown): void;
  kill(): boolean;
}

/** Why the host was asked to stop the server: an update install, the app quitting, a smoke run. */
type StopReason = "update" | "quit" | "smoke";

/**
 * `idle` before the first start, `booting` until the boot URL arrives, `running` after it,
 * `stopping` while a stop waits, `stopped` after one, `crashed` when it exited unasked and won't be
 * restarted, `recovering` from an unexpected exit until a restart boots, and `failed` once the
 * restarts are used up.
 */
type ServerState =
  | "idle"
  | "booting"
  | "running"
  | "stopping"
  | "stopped"
  | "crashed"
  | "recovering"
  | "failed";

/** An exit the host didn't ask for. */
export interface ServerExit {
  readonly code: number;
  /** Whether it had reported its boot URL first. */
  readonly booted: boolean;
}

/**
 * Update success requires completed teardown and exit zero (`exited`), or attested essentials, the
 * rest of the tree killed and none of it left (`essentials`). `survived` is a process of the tree
 * still there after that kill, `unverified` a tree that couldn't be read. Quit retains bounded exit
 * recovery.
 */
export type StopOutcome =
  | "exited"
  | "essentials"
  | "failed"
  | "unconfirmed"
  | "forced"
  | "lingering"
  | "survived"
  | "unverified";

/** What `forceKill` killed beside the root (`process-tree.ts`), for the log and the receipt. */
interface ForcedKill {
  readonly under: number;
  readonly names: ReadonlyArray<string>;
}

/**
 * Proves a killed server's tree gone (`update/tree-check.ts`). `watch` starts following the root's
 * tree by birth identity when an update's stop is asked for; undefined when the process table
 * can't be read, which an update takes as a survivor.
 */
export interface TreeCheck {
  readonly watch: (root: number) => TreeWatch | undefined;
}

/**
 * A server tree followed since its stop: `freeze` stops all of it before the kill and is false when
 * that can't be settled; `survivors` counts what is left after it, undefined when that can't be
 * told, and kills what is left either way.
 */
interface TreeWatch {
  readonly freeze: () => Promise<boolean>;
  readonly survivors: () => Promise<number | undefined>;
}

/** How the last update stop went, beyond its outcome: what the receipt and the log record. */
export interface UpdateStopReport {
  readonly outcome: StopOutcome;
  /** The essential the server reported it couldn't attest. */
  readonly failed?: UpdateEssential;
  /** What the server's teardown still waited on when it sealed its essentials. */
  readonly waitingOn?: Readonly<Record<string, number>>;
  readonly killed?: ForcedKill;
  readonly survivors?: number;
}

/** The shell's logger, as the host writes to it. */
interface ServerLog {
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
  error(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface ServerHostOptions {
  readonly fork: () => ServerChild;
  /** Whether a tokenised `boot <url>` stdout line also counts as boot; unpackaged builds only. */
  readonly bootFromStdout: boolean;
  /** Every message from the server; `reply` posts back to the child that sent it. */
  readonly onMessage: (message: unknown, reply: (response: unknown) => void) => void;
  /**
   * Kills the process outright, with everything under it, for a server that ignored its stop or
   * hung, or a quit the user forced (`process-tree.ts`).
   */
  readonly forceKill: (pid: number) => ForcedKill | void;
  /**
   * Without it, an update's server isn't asked to seal its essentials, and an update whose teardown
   * overruns is refused as before.
   */
  readonly treeCheck?: TreeCheck;
  readonly log: ServerLog;
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (timer: unknown) => void;
  readonly now: () => number;
  readonly recovery?: RecoveryPolicy;
  /** Pings the server while it runs; without it only an exit is noticed. */
  readonly health?: HealthCheck;
  readonly bootTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
}

export interface ServerHost {
  /**
   * Forks the server and resolves with its boot URL, which carries the launch token; rejects if it
   * exits or times out first. While a child is booting or running, or a timed-out one is still
   * being made to exit, returns that child's boot.
   */
  start(): Promise<string>;
  /**
   * Asks the server to shut down (`SHUTDOWN_REQUEST`: it stops its agents and closes its database)
   * and waits for it to exit, killing it outright if it hasn't within the stop timeout. Cancels any
   * pending restart.
   */
  stop(reason: StopReason): Promise<StopOutcome>;
  /** Asks the server to shut down without waiting, for a quit or an exit already decided. */
  kill(reason: StopReason): void;
  /**
   * Kills the server outright, the current child or the one a stop is still waiting on, for a quit
   * the user forced.
   */
  terminate(reason: StopReason): void;
  /**
   * Starts again after recovery gave up (or at any time), with the whole restart budget; while a
   * timed-out child is still exiting, once it has.
   */
  retry(): void;
  /** Posts to the current child, if there is one. */
  post(message: unknown): void;
  /** The last boot URL, "" before the first boot. */
  url(): string;
  state(): ServerState;
  /** Why the last stop was asked for, until the next start. */
  stopReason(): StopReason | undefined;
  /** How the last update stop went; undefined before one. */
  updateStop(): UpdateStopReport | undefined;
  /** Calls `listener` on every exit the host didn't ask for; returns the unsubscribe. */
  onUnexpectedExit(listener: (exit: ServerExit) => void): () => void;
  /** Calls `listener` with the boot URL whenever any child boots, the first one included. */
  onBoot(listener: (url: string) => void): () => void;
  /** Calls `listener` with the new boot URL whenever a restart after an unexpected exit boots. */
  onRecovered(listener: (url: string) => void): () => void;
  /** Calls `listener` with what went wrong last once the restarts are used up. */
  onGiveUp(listener: (reason: string) => void): () => void;
}

interface Running {
  readonly child: ServerChild;
  /** Whether it timed out booting and is being made to exit. */
  readonly reaping: () => boolean;
  readonly boot: Promise<string>;
  readonly exited: Promise<number>;
  readonly shutdown: { requested: boolean; complete: boolean; forced: boolean };
  /** What the server reported of its update essentials; `attested` settles when it sealed them. */
  readonly essentials: {
    report?: { readonly failed: UpdateEssential } | { readonly waitingOn: Record<string, number> };
    readonly attested: PromiseWithResolvers<void>;
  };
}

const ESSENTIALS = new Set<unknown>(["sessions", "agents", "database"]);
/** A `process.getActiveResourcesInfo()` kind; at most this many are kept from a report. */
const RESOURCE_KIND = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const MAX_RESOURCE_KINDS = 16;

/** The server's `shutdownEssentials` report, bounded to known essentials and handle kinds. */
export function essentialsFromMessage(
  message: unknown,
): { readonly failed: UpdateEssential } | { readonly waitingOn: Record<string, number> } | null {
  if (typeof message !== "object" || message === null) return null;
  const { type, success, failed, waitingOn } = message as Record<string, unknown>;
  if (type !== "shutdownEssentials") return null;
  if (success === false)
    return ESSENTIALS.has(failed) ? { failed: failed as UpdateEssential } : null;
  if (success !== true) return null;
  const kinds: Record<string, number> = {};
  if (typeof waitingOn === "object" && waitingOn !== null) {
    for (const [kind, count] of Object.entries(waitingOn).slice(0, MAX_RESOURCE_KINDS)) {
      if (RESOURCE_KIND.test(kind) && Number.isSafeInteger(count) && Number(count) > 0)
        kinds[kind] = Number(count);
    }
  }
  return { waitingOn: kinds };
}

const subscribe = <T>(listeners: Set<T>, listener: T) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export function createServerHost(options: ServerHostOptions): ServerHost {
  const { log } = options;
  const policy = options.recovery ?? DEFAULT_RECOVERY;
  const bootTimeoutMs = options.bootTimeoutMs ?? BOOT_TIMEOUT_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  let current: Running | null = null;
  let state: ServerState = "idle";
  let url = "";
  let reason: StopReason | undefined;
  /** Restarts tried since the last server that stayed up `stableMs`. */
  let failures = 0;
  let retryTimer: unknown;
  /** A `retry` asked for while a child is still exiting; it starts once that one has. */
  let retryPending = false;
  /** A child `stop` let go of whose exit isn't confirmed yet; nothing starts until it is. */
  let exiting: Running | null = null;
  const exitListeners = new Set<(exit: ServerExit) => void>();
  const bootListeners = new Set<(url: string) => void>();
  const recoveredListeners = new Set<(url: string) => void>();
  const giveUpListeners = new Set<(reason: string) => void>();

  let lastUpdateStop: UpdateStopReport | undefined;
  const forceKill = (pid: number | undefined): ForcedKill | undefined => {
    try {
      if (pid !== undefined) return options.forceKill(pid) ?? undefined;
    } catch {
      // ESRCH: it exited between the timeout and the kill.
    }
    return undefined;
  };

  const cancelRetry = () => {
    if (retryTimer === undefined) return;
    options.clearTimeout(retryTimer);
    retryTimer = undefined;
  };

  /**
   * The current child is gone without being asked: restart it after the backoff, or give up once
   * the budget is spent. `ranMs` is how long it had been up since booting, null if it never booted.
   */
  const lost = (problem: string, ranMs: number | null) => {
    if (policy.attempts === 0) {
      state = "crashed";
      return;
    }
    if (ranMs !== null && ranMs >= policy.stableMs) failures = 0;
    if (failures >= policy.attempts) {
      state = "failed";
      log.error({ source: "server", attempts: failures }, `server can't be restarted: ${problem}`);
      for (const listener of giveUpListeners) listener(problem);
      return;
    }
    failures++;
    const delayMs = restartDelay(policy, failures);
    state = "recovering";
    log.warn(
      { source: "server", attempt: failures, of: policy.attempts, delayMs },
      `${problem}; restarting it`,
    );
    retryTimer = options.setTimeout(() => {
      retryTimer = undefined;
      if (state !== "recovering" || current !== null) return;
      // A failed restart is counted by `lost` from its exit or boot timeout.
      start().catch(() => {});
    }, delayMs);
  };

  const start = (): Promise<string> => {
    if (current !== null) return current.boot;
    if (exiting !== null) {
      return Promise.reject(new Error("the previous server is still running after being stopped"));
    }
    cancelRetry();
    reason = undefined;
    const restart = state === "recovering";
    const child = options.fork();
    if (!restart) state = "booting";
    let booted = false;
    let bootedAt = 0;
    /** Why it was given up on before booting, while it is being made to exit. */
    let timedOut: string | undefined;
    let reaper: unknown;
    let healthTimer: unknown;
    /** Set once the health check gave up on it, for the exit that follows the kill. */
    let hung: string | undefined;
    /** When it last answered a ping; only that much of its uptime counts toward `stableMs`. */
    let answeredAt: number | undefined;
    const exited = Promise.withResolvers<number>();
    const shutdown = { requested: false, complete: false, forced: false };
    const essentials: Running["essentials"] = { attested: Promise.withResolvers<void>() };
    /** The timed-out child has exited: start what was asked for, else count it as a failure. */
    const gone = (problem: string) => {
      current = null;
      if (retryPending) {
        retryPending = false;
        state = "recovering";
        start().catch(() => {});
      } else if (state !== "failed") {
        if (restart) lost(problem, null);
        else state = "crashed";
      }
    };
    const boot = new Promise<string>((resolve, reject) => {
      const booting = () => !booted && timedOut === undefined && current?.child === child;
      const settle = (bootUrl: string) => {
        if (!booting()) return;
        booted = true;
        bootedAt = options.now();
        options.clearTimeout(timer);
        url = bootUrl;
        state = "running";
        resolve(bootUrl);
        for (const listener of bootListeners) listener(bootUrl);
        if (restart) {
          log.info({ source: "server", attempt: failures }, "server restarted");
          for (const listener of recoveredListeners) listener(bootUrl);
        }
        if (options.health !== undefined) watchHealth(options.health, bootUrl);
      };
      /**
       * Pings the booted child until it is no longer current. A gap between ticks far longer than
       * the interval is the Mac waking from sleep, which restarts the count.
       */
      const watchHealth = (health: HealthCheck, bootUrl: string) => {
        const intervalMs = health.intervalMs ?? HEALTH_INTERVAL_MS;
        const timeoutMs = health.timeoutMs ?? HEALTH_TIMEOUT_MS;
        const hungMs = health.hungMs ?? HEALTH_HUNG_MS;
        let unansweredSince: number | undefined;
        let lastTick = options.now();
        const tick = () => {
          healthTimer = undefined;
          if (current?.child !== child || hung !== undefined) return;
          const at = options.now();
          // Far longer than a tick or a ping can take: the Mac slept, which isn't the server's.
          const slept = (from: number) => options.now() - from > intervalMs + timeoutMs * 3;
          if (slept(lastTick)) unansweredSince = undefined;
          lastTick = at;
          const next = () => {
            if (current?.child === child) healthTimer = options.setTimeout(tick, intervalMs);
          };
          health.ping(bootUrl, timeoutMs).then(
            () => {
              if (current?.child !== child) return;
              answeredAt = options.now();
              if (unansweredSince !== undefined) {
                log.info(
                  { source: "server", downMs: options.now() - unansweredSince },
                  "server answering again",
                );
                unansweredSince = undefined;
              }
              next();
            },
            () => {
              if (current?.child !== child) return;
              // A ping the Mac slept through says nothing of the server either.
              if (slept(at)) {
                unansweredSince = undefined;
                next();
                return;
              }
              const downMs = unansweredSince === undefined ? 0 : options.now() - unansweredSince;
              if (unansweredSince === undefined) {
                unansweredSince = at;
                log.warn({ source: "server", timeoutMs }, "server isn't answering");
              } else if (downMs >= hungMs) {
                hung = `server stopped answering for ${Math.round(downMs / 1000)}s`;
                log.error({ source: "server", downMs, pid: child.pid }, `${hung}; killing it`);
                // Its event loop is stuck, so it can't act on a polite kill.
                forceKill(child.pid);
                return;
              }
              next();
            },
          );
        };
        healthTimer = options.setTimeout(tick, intervalMs);
      };
      const timer = options.setTimeout(() => {
        if (!booting()) return;
        const problem = `server didn't boot within ${bootTimeoutMs / 1000}s`;
        log.warn({ source: "server", timeoutMs: bootTimeoutMs }, `${problem}; stopping it`);
        timedOut = problem;
        if (!restart) state = "crashed";
        reject(new Error(problem));
        // It stays the current child until it has exited, so nothing forks beside it on the same
        // data dir, and a stop or quit still reaches it.
        child.kill();
        reaper = options.setTimeout(() => {
          log.warn(
            { source: "server", pid: child.pid },
            "server ignored the kill; killing it outright",
          );
          forceKill(child.pid);
          reaper = options.setTimeout(() => {
            if (current?.child !== child) return;
            // Still tracked, so nothing starts beside it on the same database; recovery has
            // failed, and only its exit lets a retry start.
            log.error({ source: "server", pid: child.pid }, "server still running after a kill");
            state = "failed";
            const stuck = `${problem}, and it is still running after being killed`;
            for (const listener of giveUpListeners) listener(stuck);
          }, FORCE_KILL_GRACE_MS);
        }, stopTimeoutMs);
      }, bootTimeoutMs);
      child.on("message", (message) => {
        if (
          shutdown.requested &&
          typeof message === "object" &&
          message !== null &&
          Reflect.get(message, "type") === "shutdownComplete" &&
          Reflect.get(message, "success") === true
        )
          shutdown.complete = true;
        const report = shutdown.requested ? essentialsFromMessage(message) : null;
        if (report !== null && essentials.report === undefined) {
          essentials.report = report;
          if ("waitingOn" in report) essentials.attested.resolve();
        }
        const bootUrl = bootUrlFromMessage(message);
        if (bootUrl) settle(bootUrl);
        options.onMessage(message, (response) => {
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Electron UtilityProcess
          child.postMessage(response);
        });
      });
      if (child.stdout) {
        createInterface({ input: child.stdout }).on("line", (line) => {
          // Boot lines are never logged: an older server's line still carries the token.
          if (!isBootLine(line)) {
            log.info({ source: "server" }, line);
            return;
          }
          const bootUrl = options.bootFromStdout ? bootUrlFromLine(line) : null;
          if (bootUrl) settle(bootUrl);
        });
      }
      if (child.stderr) {
        createInterface({ input: child.stderr }).on("line", (line) => {
          log.warn({ source: "server" }, line);
        });
      }
      child.on("exit", (code) => {
        log.info({ source: "server", code }, "server exited");
        options.clearTimeout(timer);
        options.clearTimeout(reaper);
        options.clearTimeout(healthTimer);
        exited.resolve(code);
        if (!booted) reject(new Error(`server exited with code ${code} before booting`));
        // One the host stopped was detached from it then; this is the server dying by itself.
        if (current?.child !== child) return;
        if (timedOut !== undefined) {
          gone(timedOut);
          return;
        }
        current = null;
        // A first start that never booted is its caller's to handle; anything else is recovered.
        // Before the listeners, so one that stops the host cancels the restart this schedules.
        if (booted || restart) {
          // A hung server's unanswered time isn't uptime: counted, a server that hangs straight
          // after every boot would look stable and refill the restart budget each time.
          const ranMs = !booted
            ? null
            : hung === undefined
              ? options.now() - bootedAt
              : (answeredAt ?? bootedAt) - bootedAt;
          lost(hung ?? `server exited with code ${code}`, ranMs);
        } else {
          state = "crashed";
        }
        for (const listener of exitListeners) listener({ code, booted });
      });
    });
    current = {
      child,
      reaping: () => timedOut !== undefined,
      boot,
      exited: exited.promise,
      shutdown,
      essentials,
    };
    return boot;
  };

  /**
   * Cancels any restart, detaches the current child and has it exit: `ask` posts the server's
   * shutdown request, so it ends its agents itself; `kill` is `utilityProcess.kill()`, which is
   * SIGTERM and then SIGKILL two seconds later on POSIX, and TerminateProcess on Windows.
   */
  const detach = (why: StopReason, how: "ask" | "kill"): Running | null => {
    cancelRetry();
    retryPending = false;
    failures = 0;
    reason = why;
    const stopping = current;
    current = null;
    if (how === "kill") {
      if (stopping) stopping.shutdown.forced = true;
      stopping?.child.kill();
    } else {
      if (stopping) stopping.shutdown.requested = true;
      // Only where the kill's leftovers can be checked; elsewhere an update stays as strict as a quit.
      const request =
        why === "update" && options.treeCheck !== undefined
          ? UPDATE_SHUTDOWN_REQUEST
          : SHUTDOWN_REQUEST;
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Electron UtilityProcess
      stopping?.child.postMessage(request);
    }
    return stopping;
  };

  /** Preserves what settled first; undefined means the wait expired. */
  const within = async <T>(settled: Promise<T>, ms: number): Promise<T | undefined> => {
    let timer: unknown;
    const done = await Promise.race([
      settled,
      new Promise<undefined>(
        (resolve) => (timer = options.setTimeout(() => resolve(undefined), ms)),
      ),
    ]);
    options.clearTimeout(timer);
    return done;
  };

  return {
    start,
    async stop(why) {
      const stopping = detach(why, "ask");
      if (stopping === null) {
        if (state !== "idle") state = "stopped";
        return why === "update" ? "unconfirmed" : "exited";
      }
      state = "stopping";
      exiting = stopping;
      void stopping.exited.then(() => {
        if (exiting !== stopping) return;
        exiting = null;
        if (!retryPending) return;
        retryPending = false;
        state = "recovering";
        start().catch(() => {});
      });
      let outcome: StopOutcome = "exited";
      // From the request on, so a process the server starts and orphans while it stops stays known.
      const watch =
        why === "update" && stopping.child.pid !== undefined
          ? options.treeCheck?.watch(stopping.child.pid)
          : undefined;
      // Only an update's server seals its essentials, so only an update stops waiting for that.
      const attested =
        why === "update"
          ? stopping.essentials.attested.promise.then(() => "attested" as const)
          : new Promise<never>(() => {});
      const first = await within(Promise.race([stopping.exited, attested]), stopTimeoutMs);
      const code = typeof first === "number" ? first : undefined;
      let update: Omit<UpdateStopReport, "outcome"> = {};
      const report = stopping.essentials.report;
      if (report !== undefined && "failed" in report) update = { failed: report.failed };
      if (code === undefined && why === "update" && report !== undefined && "waitingOn" in report) {
        const { pid } = stopping.child;
        log.warn(
          { source: "server", reason: why, pid, waitingOn: report.waitingOn },
          first === "attested"
            ? "server sealed its update essentials; killing the rest of its teardown"
            : "server didn't exit in time but sealed its update essentials; killing it",
        );
        let frozen = false;
        let killed: ForcedKill | undefined;
        let exitedAfterKill = false;
        let counted: number | undefined;
        try {
          // Stopped whole before the kill, so nothing under the server can fork past it.
          frozen = (await watch?.freeze()) === true;
          killed = forceKill(pid);
          exitedAfterKill = (await within(stopping.exited, FORCE_KILL_GRACE_MS)) !== undefined;
        } finally {
          // Counted, and the tree released on every path: nothing of it is left stopped.
          counted = await watch?.survivors();
        }
        update = { waitingOn: report.waitingOn, ...(killed === undefined ? {} : { killed }) };
        const survivors = frozen ? counted : undefined;
        if (!exitedAfterKill) {
          outcome = "lingering";
          log.error({ source: "server", reason: why, pid }, "server still running after a kill");
        } else {
          if (survivors !== undefined) update = { ...update, survivors };
          outcome =
            survivors === undefined ? "unverified" : survivors > 0 ? "survived" : "essentials";
          if (outcome !== "essentials") {
            log.error(
              { source: "server", reason: why, pid, survivors: survivors ?? null },
              survivors === undefined
                ? "server's process tree couldn't be read after the kill"
                : "processes of the server's tree survived the kill",
            );
          }
        }
      } else if (code === undefined) {
        const { pid } = stopping.child;
        log.warn(
          { source: "server", reason: why, timeoutMs: stopTimeoutMs, pid },
          "server didn't exit in time after being asked to stop; killing it",
        );
        forceKill(pid);
        outcome =
          (await within(stopping.exited, FORCE_KILL_GRACE_MS)) !== undefined
            ? "forced"
            : "lingering";
        if (outcome === "lingering") {
          log.error({ source: "server", reason: why, pid }, "server still running after a kill");
        }
      }
      if (why === "update" && code !== undefined) {
        outcome = stopping.shutdown.forced
          ? "forced"
          : code !== 0
            ? "failed"
            : stopping.shutdown.complete
              ? "exited"
              : "unconfirmed";
      }
      if (why === "update") lastUpdateStop = { outcome, ...update };
      if (current === null) state = "stopped";
      return outcome;
    },
    kill(why) {
      detach(why, "kill");
      if (state !== "idle") state = "stopped";
    },
    terminate(why) {
      const target = current ?? exiting;
      detach(why, "kill");
      if (target) target.shutdown.forced = true;
      forceKill(target?.child.pid);
      if (state !== "idle") state = "stopped";
    },
    retry() {
      if (state === "stopping") return;
      if (exiting !== null) {
        retryPending = true;
        failures = 0;
        return;
      }
      if (current !== null) {
        // Booting or running already; one that timed out is retried once it has exited.
        if (current.reaping()) {
          retryPending = true;
          failures = 0;
        }
        return;
      }
      failures = 0;
      state = "recovering";
      start().catch(() => {});
    },
    post(message) {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Electron UtilityProcess
      current?.child.postMessage(message);
    },
    url: () => url,
    state: () => state,
    stopReason: () => reason,
    updateStop: () => lastUpdateStop,
    onUnexpectedExit: (listener) => subscribe(exitListeners, listener),
    onBoot: (listener) => subscribe(bootListeners, listener),
    onRecovered: (listener) => subscribe(recoveredListeners, listener),
    onGiveUp: (listener) => subscribe(giveUpListeners, listener),
  };
}
