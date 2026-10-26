import type {
  TurnId,
  ModelRef,
  ThreadId,
  TurnEndReason,
  Thread,
  WorkerQuiet,
  UserInput,
  LimitWait,
} from "@gram/contracts";
import type * as Effect from "effect/Effect";
import type { ObservedOutput } from "../outputs/observed.ts";

/** A turn that ended, as `RuntimeObserver.onTurnEnd` hears of it. */
export interface ObservedTurnEnd {
  readonly turnId: TurnId;
  readonly reason: TurnEndReason;
  /** The main turn produced model text, reasoning or a tool call before it ended. */
  readonly producedOutput?: boolean;
  /**
   * The host ended the turn itself (the interrupt watchdog, a session that closed or crashed, a
   * send that died) rather than the adapter reporting `turnEnd`.
   */
  readonly synthesized: boolean;
  /** Nothing is waiting to start the next turn: no queued user input and no system delivery. */
  readonly queueEmpty: boolean;
  /** Safe tool metadata for diagnosing a worker that stopped without reporting. */
  readonly lastTool?: string | undefined;
  readonly endedAt?: number | undefined;
  /** How a turn Gram opened to compact the idle thread ended (`IdleCompactNotice`). */
  readonly idleCompaction?: "completed" | "failed" | "unknown";
}

/**
 * Turns as the rest of the server can watch them; no `ServerEvent` reports a turn end. Callbacks
 * run one at a time, in the order things happened, on a fiber of the runtime's own and never under
 * a runtime lock, so they may call back into `ThreadRuntimes`. One that fails or dies is logged. A
 * slow one holds up every later callback, so hand the work to a queue of your own.
 */
export interface RuntimeObserver {
  onTurnStart?(thread: Thread, turnId: TurnId): Effect.Effect<void>;
  /** Substantive main-turn output; framing and nested lanes do not qualify. */
  onTurnProgress?(threadId: ThreadId, model: ModelRef, turnId: TurnId): Effect.Effect<void>;
  onTurnEnd?(thread: Thread, end: ObservedTurnEnd): Effect.Effect<void>;
  /** The agent started or stopped retrying (a rate limit), which `thread.status` shows as `running`. */
  onRetrying?(threadId: ThreadId, retrying: boolean): Effect.Effect<void>;
  /** A running tool's silence flag changed; `undefined` means progress resumed or its turn ended. */
  onQuiet?(thread: Thread, quiet: WorkerQuiet | undefined): Effect.Effect<void>;
  /** A turn the agent opened by itself was asked to stop (its gate closed), as a turn hold asked. */
  onTurnHeld?(thread: Thread, turnId: TurnId): Effect.Effect<void>;
  /** `send` or `steer` took an input with neither `origin` nor `notice`: the user typed it. */
  onUserInput?(thread: Thread, input: UserInput): Effect.Effect<void>;
  /**
   * The thread began waiting out a provider limit (`wait`, `ended` absent), or that wait ended:
   * `resumed` by its timer or the user, or `cancelled` by the user. `thread` is as it is after.
   */
  onLimitWait?(
    thread: Thread,
    wait: LimitWait,
    ended?: "resumed" | "cancelled",
  ): Effect.Effect<void>;
  /**
   * A chunk named a file the thread produced (`outputs/observed.ts`): an image a tool returned, a
   * file the agent sent, a document or media its Write made. Unchecked: the path is as named.
   */
  onOutput?(threadId: ThreadId, output: ObservedOutput): Effect.Effect<void>;
}

/**
 * Hands each observer's `name` callback, as `call` makes it, to the one fiber the runtime runs them
 * on, in order and never under a runtime lock.
 */
export type NotifyObservers = (
  threadId: ThreadId,
  name: keyof RuntimeObserver,
  call: (observer: RuntimeObserver) => Effect.Effect<void> | undefined,
) => Effect.Effect<void>;

/** Hands `callback` to that fiber, which logs it as `what` if it fails. */
export type Dispatch = (
  threadId: ThreadId,
  what: string,
  callback: Effect.Effect<void>,
) => Effect.Effect<void>;
