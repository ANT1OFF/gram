// The server's shutdown, which the desktop shell asks for with a `{ type: "shutdown" }` message
// rather than a signal. Electron's `utilityProcess.kill()` sends SIGTERM and then SIGKILL two seconds
// later on POSIX, and calls TerminateProcess on Windows, so a signal leaves the server no time to
// end its agents. `stopForShutdown` stops the sessions. When the program then returns, the layers
// close the terminals, the agent servers and the database in turn, and the process exits. Main's
// stop timeout bounds all of it: past it, main kills the server with everything under it.

import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import { ThreadRuntimes } from "./thread-runtimes.ts";

/** How long the agent sessions get to stop before the teardown goes on without them. */
export const SESSIONS_TIMEOUT_MS = 4_000;
/**
 * How long counting the threads a quit interrupts may take: it waits on each thread's lock, which
 * a turn's git checkpoint can hold for minutes, and it is only for the progress window.
 */
const WORKING_TIMEOUT_MS = 500;
/**
 * When a shutdown still running is logged as overrun, before main's stop timeout (10 s) kills the
 * server and its tree.
 */
export const SHUTDOWN_DEADLINE_MS = 8_000;

/** Whether `message` is main's request to shut down. */
export const isShutdownRequest = (message: unknown): boolean =>
  typeof message === "object" &&
  message !== null &&
  (message as { readonly type?: unknown }).type === "shutdown";

/** Whether `message` is main's request to shut down for an update, which seals the essentials. */
export const isUpdateShutdownRequest = (message: unknown): boolean =>
  isShutdownRequest(message) && (message as { readonly reason?: unknown }).reason === "update";

/**
 * What an update needs from the server before main may kill whatever else of its teardown is still
 * running. Nothing else (HTTP and WebSocket close, the git command worker, terminals, helper runs,
 * other finalizers) is: a kill loses none of the user's work there.
 *
 * - `sessions`: every agent session stopped and its state persisted (`stopForShutdown`); a kill
 *   mid-stop could leave a transcript or turn half written.
 * - `agents`: every agent process the server owns (the `codex` app-server, a Claude Code CLI) has
 *   exited, a `codex` app-server through its normal stop (`stopOwnedAgentsForUpdate`); a killed
 *   agent can't save its own session files.
 * - `database`: closed, or sealed with its WAL checkpointed and no writer mid-transaction
 *   (`persistence/update-seal.ts`); the new version opens the same file.
 */
export const UPDATE_ESSENTIALS = ["sessions", "agents", "database"] as const;
export type UpdateEssential = (typeof UPDATE_ESSENTIALS)[number];

/**
 * When an update's teardown still running is sealed: past the agents' stop (sessions ≤4.5 s, then
 * agents ≤3.5 s), with the seal's bound (`SEAL_TIMEOUT_MS`) still inside main's stop timeout (10 s).
 * A teardown that finishes first exits as before, the clean path.
 */
export const ESSENTIALS_SEAL_MS = 7_000;
/** How long the owned agent processes get to exit once asked; `stopChild` forces after 3 s. */
export const AGENTS_STOP_TIMEOUT_MS = 3_500;

/** What the server posts main once it has sealed the essentials, or found one it can't. */
export type ShutdownEssentials =
  | {
      readonly type: "shutdownEssentials";
      readonly success: true;
      /** What still holds the teardown, as `process.getActiveResourcesInfo()` kinds and counts. */
      readonly waitingOn: Readonly<Record<string, number>>;
    }
  | {
      readonly type: "shutdownEssentials";
      readonly success: false;
      readonly failed: UpdateEssential;
    };

/** The first essential that isn't attested, in `UPDATE_ESSENTIALS` order; undefined when all are. */
export const failedEssential = (attested: {
  readonly sessions: boolean;
  readonly agents: boolean;
  readonly database: () => boolean | Promise<boolean>;
}): Promise<UpdateEssential | undefined> =>
  !attested.sessions
    ? Promise.resolve("sessions")
    : !attested.agents
      ? Promise.resolve("agents")
      : Promise.resolve(attested.database()).then(
          (sealed) => (sealed ? undefined : "database"),
          () => "database" as const,
        );

/**
 * The essential an update's teardown left unattested when it ended before the seal, so main names
 * it rather than an unconfirmed teardown: the sessions, or an owned agent process that didn't exit
 * by itself. Undefined for a complete teardown, and for one that failed outright, which no
 * essential explains.
 */
export const unattestedEssential = (
  exit: Exit.Exit<boolean, unknown>,
  sessionsStopped: boolean | undefined,
  ownedChildrenOrderly: boolean,
): UpdateEssential | undefined =>
  Exit.isFailure(exit)
    ? undefined
    : sessionsStopped !== true || !exit.value
      ? "sessions"
      : ownedChildrenOrderly
        ? undefined
        : "agents";

/** What the server posts to the shell as it shuts down, for its progress window. */
export interface ShutdownProgress {
  readonly type: "shutdown";
  /** `sessions` while the agent sessions stop, `teardown` while the layers close. */
  readonly phase: "sessions" | "teardown";
  /** Agent sessions still to stop. */
  readonly agents: number;
  /** Threads whose work the quit cuts off (`ThreadRuntimes.working`); 0 when it couldn't tell. */
  readonly working: number;
}

/**
 * Refuses new turns, then stops the agent sessions within `SESSIONS_TIMEOUT_MS`, posting progress
 * as it goes. A turn the stop cuts off stays open for the next boot to mark interrupted
 * (`ThreadRuntimes.shutdown`).
 */
export const stopForShutdown = (post: (progress: ShutdownProgress) => void) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    // Before anything that takes a thread's lock, so nothing starts while the rest waits.
    yield* runtimes.stopAccepting;
    const agents = yield* runtimes.openSessions;
    yield* Effect.sync(() => post({ type: "shutdown", phase: "sessions", agents, working: 0 }));
    const working = Option.match(
      yield* runtimes.working.pipe(Effect.timeoutOption(WORKING_TIMEOUT_MS)),
      { onNone: () => 0, onSome: (threads) => threads.length },
    );
    if (working > 0) {
      yield* Effect.sync(() => post({ type: "shutdown", phase: "sessions", agents, working }));
    }
    const startedAt = yield* Clock.currentTimeMillis;
    const stopped = yield* runtimes.shutdown.pipe(Effect.timeoutOption(SESSIONS_TIMEOUT_MS));
    const ms = (yield* Clock.currentTimeMillis) - startedAt;
    yield* (
      Option.isSome(stopped)
        ? Effect.logInfo("shutdown: agent sessions stopped")
        : Effect.logWarning("shutdown: agent sessions didn't stop in time; going on")
    ).pipe(Effect.annotateLogs({ agents, working, ms }));
    const complete = Option.isSome(stopped) && (yield* runtimes.openSessions) === 0;
    yield* Effect.sync(() =>
      post({ type: "shutdown", phase: "teardown", agents: complete ? 0 : agents, working }),
    );
    return complete;
  });

/** Called only after the provided server layers have finalized. No success attestation on failure. */
export const attestShutdown = (
  exit: Exit.Exit<boolean, unknown>,
  ownedChildrenOrderly: boolean,
  post: (message: { readonly type: "shutdownComplete"; readonly success: true }) => void,
): number => {
  if (Exit.isFailure(exit)) return 1;
  if (exit.value && ownedChildrenOrderly) post({ type: "shutdownComplete", success: true });
  // Normal quit retains its bounded fallback after an incomplete session stop. Update also
  // requires the attestation, so a zero exit alone cannot authorize installation.
  return 0;
};

/** Bounded shutdown evidence only: never serialize errors, stacks, paths or agent payloads. */
export const shutdownDiagnostics = (
  exit: Exit.Exit<boolean, unknown>,
  sessionsStopped: boolean | undefined,
  ownedChildrenOrderly: boolean,
) => ({
  phase: sessionsStopped === undefined ? ("sessions" as const) : ("teardown" as const),
  sessionsStopped: sessionsStopped === true,
  ownedChildrenOrderly,
  result: Exit.isFailure(exit)
    ? ("failed" as const)
    : sessionsStopped === true && exit.value && ownedChildrenOrderly
      ? ("complete" as const)
      : ("incomplete" as const),
  failure: Exit.isFailure(exit)
    ? {
        error: Cause.hasFails(exit.cause),
        defect: Cause.hasDies(exit.cause),
        interrupted: Cause.hasInterrupts(exit.cause),
      }
    : undefined,
});
