// One thread's live runtime state, and the small helpers every part of `ThreadRuntimes` reads it with.

import {
  type AgentUnavailable,
  type MessageId,
  type ModelRef,
  TurnId,
  type UsageSummary,
  type WorkspaceId,
  ThreadId,
  type ThreadStatus,
  type LimitWait,
  type AgentCapabilities,
  type ThreadIdentity,
  type QueuedInput,
  QueueItemId,
  type SessionRestartReason,
  type WaitItem,
  type AgentKind,
  type BackgroundTask,
  type BackgroundOutput,
  type WorkerQuiet,
  type CompactionActivity,
  type AgentStatus,
  type GramUIMessageChunk,
  NotFound,
  type GramUIMessage,
  type ServerEvent,
  type ThreadNotFound,
} from "@gram/contracts";
import type { MessageAccumulator } from "./message-accumulator.ts";
import type { ThreadFeedItem } from "../events/event-hub.ts";
import type * as Deferred from "effect/Deferred";
import type * as Semaphore from "effect/Semaphore";
import type { AgentSession } from "@gram/agents";
import type { CostLedger } from "./cost-ledger.ts";
import type { SystemDelivery } from "./system-delivery.ts";
import type { ActivityTracker } from "./activity.ts";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Cause from "effect/Cause";
import type { CloseThreadOptions } from "./thread-runtimes-shape.ts";

export interface InFlight {
  readonly messageId: MessageId;
  /** The turn the message started in; a background subagent's transcript is saved after it ends. */
  readonly turnId: TurnId | undefined;
  readonly accumulator: MessageAccumulator;
  /** Native source events admitted once per live tool call, even when capture is refused. */
  readonly imageSources: Set<string>;
  /** Genuine native reads admitted in this lane/turn only; never persisted. */
  readonly imageReads: Map<string, string>;
  readonly items: Array<ThreadFeedItem>;
  /** Preliminary tool snapshots can retain this message after its reply finishes. */
  retainedToolOutput: boolean;
  /** The `Task`/`Agent` call this lane belongs to, on a subagent transcript. */
  readonly parentToolUseId: string | undefined;
  /** A subagent transcript, which outlives the turn while the subagent runs in the background. */
  nested: boolean;
  /** Saw `finish` or `abort`: clients treat any later chunk as the message streaming again. */
  finished: boolean;
  /** `performance.now()` before which a completed part isn't stored on its own. */
  nextPersistAt: number;
  /** A completed part is held here and not yet stored, which `flushUnsaved` stores. */
  unsaved: boolean;
}

/** A message whose save took this long has its next saves spaced out. */
export const SLOW_PERSIST_MS = 8;

/**
 * How many times a slow save's own duration passes before the next: at most a twentieth of the
 * time a message streams goes to storing it. Every save rewrites the whole message and its search
 * row, so a reply of 1,185 tool calls and 2 MB was rewritten 1,185 times, about 1.2 GB through the
 * event loop and the WAL.
 */
export const PERSIST_SPACING = 20;

/** The turn's reply that is still streaming: the latest open top-level message. */
export const openReply = (rt: Runtime) =>
  [...rt.open.values()].findLast((inFlight) => !inFlight.nested && !inFlight.finished);

/** The still-streaming transcript of the subagent `toolCallId` spawned. */
export const openLane = (rt: Runtime, toolCallId: string) =>
  [...rt.open.values()].findLast(
    (inFlight) => inFlight.parentToolUseId === toolCallId && !inFlight.finished,
  );

export interface Turn {
  readonly id: TurnId;
  /** Epoch ms it opened: only a turn opened after an account's limit says it lifted. */
  readonly startedAt: number;
  readonly done: Deferred.Deferred<void>;
  usage: UsageSummary | undefined;
  producedOutput?: boolean;
  model: ModelRef;
  /**
   * Epoch ms the latest input of the turn's main conversation reached the agent: its start, a steer
   * it took or a tool result. The next request starts after it, so it bounds that request's start
   * from below; saved as `UsageSummary.lastRequestAt`.
   */
  lastInputAt: number;
  /** Gram opened it to compact the idle thread (`IdleCompactNotice`); see `idleCompaction`. */
  idleCompaction?: { compacted: boolean; readonly workspaceId: WorkspaceId | undefined };
}

export interface Runtime {
  readonly threadId: ThreadId;
  readonly lock: Semaphore.Semaphore;
  /**
   * Held while the stored transcript, `open` and `seq` change, and while a replay reads them. Only
   * ever taken inside `lock` or on its own, so a replay needn't wait on `lock`, which a turn holds
   * across its git checkpoints and a session open.
   */
  readonly feedLock: Semaphore.Semaphore;
  status: ThreadStatus;
  session: AgentSession | undefined;
  /**
   * Whose quota the session's rate limits count against: its agent and the profile it opened with,
   * which a model change mid-session doesn't move.
   */
  quota: string | undefined;
  /** That profile, a gateway's, whose limits aren't the subscription's; absent on the CLI's own login. */
  profileId: string | undefined;
  /**
   * `Thread.limitWait` as the store has it: while set, nothing but the user's own input starts a
   * turn, and the queue and system deliveries wait for the resume.
   */
  limitWait: LimitWait | undefined;
  /** The wait the thread last resumed from, until a turn completes: a backoff counts on from it. */
  resumedFrom: LimitWait | undefined;
  /**
   * The user resumed the wait now: the turn that carries the resume starts even while the account
   * is still known to be limited (`waitWithAccount`), once. Dropped as any turn opens.
   */
  admitted: boolean;
  capabilities: AgentCapabilities | undefined;
  identity: ThreadIdentity | undefined;
  /** The latest usage report: the context meter and cost ticker. */
  usage: UsageSummary | undefined;
  /** Turns the sessions' own cost counters into the thread's, which `usage.costUsd` shows. */
  readonly cost: CostLedger;
  /** The checkout the session runs in; set when the session opens. */
  cwd: string | undefined;
  queue: Array<QueuedInput>;
  /**
   * A send that opened the session, which goes as its first turn. Its message is in the feed from
   * the send on, under the item's id, so clients never see it in `queue`. The store keeps it at the
   * queue's head, so a restart sends it as a queued item; a message never shares an id with a
   * queued item, so the boot and a failed open take the message back.
   */
  launch: (QueuedInput & { readonly turnId: TurnId }) | undefined;
  /**
   * The input on its way to the agent, a launch or the queue's head: gone from `queue`, but kept
   * at the stored queue's head with its turn until the agent has taken it, so a crash in between
   * sends it again rather than lose it. Its message, if published, has the item's id.
   */
  inFlight: (QueuedInput & { readonly turnId: TurnId }) | undefined;
  /** When each queued item was queued and how many messages it holds, since the server started. */
  readonly queuedAt: Map<
    QueueItemId,
    { readonly at: number | undefined; readonly messages: number }
  >;
  /** The key of each queued notice `sendNotice` may replace, since the server started. */
  readonly noticeKeys: Map<QueueItemId, string>;
  turn: Turn | undefined;
  /** Messages still streaming (or finished this turn), by id; subagent transcripts can interleave. */
  readonly open: Map<MessageId, InFlight>;
  /** Running tool calls whose command GitHub will react to (`touchesRemote`), by tool call id. */
  readonly remoteCalls: Set<string>;
  /** The turn `stopAtToolBoundary` stops once no tool call is in flight. */
  stopAtBoundary: TurnId | undefined;
  /** One of those ran in the turn now open. */
  touchedRemote: boolean;
  seq: number;
  /** Why we're closing the session, so its exit maps to the right status. */
  stopping: "evict" | "close" | "recover" | "rewind" | "folderGone" | undefined;
  /** `close` has begun, so a watchdog recovery must neither start nor reopen the session. */
  closing: boolean;
  /** `whileAtRest` is working on its checkout, so sends are turned away until it ends. */
  reserved: boolean;
  endedReason: string | undefined;
  /** The checkout or granted folders changed mid-turn; reopen the session once it's idle. */
  reopenOnIdle: boolean;
  /**
   * A restart was asked for (`asked`) or made on its own (its reason), so the next session to open
   * puts the `session-restart` marker in the transcript. Called off by any end of a session but the
   * one stopped to reopen.
   */
  restartMarker: "asked" | SessionRestartReason | undefined;
  /** `mcpConfigChanged` reached the session, which restarts at its next point of rest. */
  pendingRestart: SessionRestartReason | undefined;
  /** When the last background task ended, while a pending restart waits `BACKGROUND_SETTLE`. */
  tasksEndedAt: number | undefined;
  /**
   * The agent said it is running with no turn open, until it says it is idle: Claude's turn to
   * report on a background task, whose turn opens only once its reply starts.
   */
  agentRunning: boolean;
  /**
   * A reopen has begun and the next session isn't in yet: the outgoing session's last events
   * mustn't make the thread idle, or the queue would drain into the session being replaced.
   */
  reopening: boolean;
  switchSource?: AgentSession | undefined;
  switchOpening?:
    | { id: string; ack: Deferred.Deferred<AgentSession, AgentUnavailable> }
    | undefined;

  /** System deliveries waiting for the thread to be free, by key, oldest first. Never in `queue`. */
  readonly deliveries: Map<string, SystemDelivery>;
  /** The delivery the open turn carries, until the adapter shows it has it or the turn is lost. */
  carrying: { readonly turnId: TurnId; readonly delivery: SystemDelivery } | undefined;
  /**
   * The Waiting on you items a note in turn `turnId` told of, recorded as heard once the agent
   * takes that turn's input as a delivery is (`settleDelivery`), and dropped as news otherwise.
   */
  noteHeard: { readonly turnId: TurnId; readonly items: ReadonlyArray<WaitItem> } | undefined;
  /**
   * The agent reported `retrying` in the open turn and has shown no progress since, which `status`
   * shows as `running`.
   */
  retrying: boolean;
  /** The agent the session opened with; set when the session opens. */
  agent: AgentKind | undefined;
  /** The live activity line, derived from agent events. */
  readonly activity: ActivityTracker;
  /** The session's background tasks still running, from its latest `backgroundTasks` event. */
  background: ReadonlyArray<BackgroundTask>;
  /**
   * The latest output tail of each of `background`'s shells that has written any, by task id; a
   * task's goes when it leaves `background`.
   */
  readonly backgroundOutput: Map<string, BackgroundOutput>;
  /** The live session's claude.ai connectors that need signing in again (`connectorsLapsed`). */
  lapsedConnectors: ReadonlyArray<string>;
  lastProgressAt: number;
  lastTool: string | undefined;
  readonly runningTools: Set<string>;
  quiet: WorkerQuiet | undefined;
  /** The compaction the agent reports under way, which `thread.status` carries while it lasts. */
  compaction: CompactionActivity | undefined;
  /** The line clients last received, and when. */
  activityPublished: string | undefined;
  activityPublishedAt: number;
}

/**
 * The most changed messages a resume sends; further behind, the full history is as cheap and
 * starts the client over.
 */
export const RESUME_MAX_MESSAGES = 256;

/** How much of an `AgentUnavailable` message the log line carries. */
export const UNAVAILABLE_LOG_CHARS = 500;

/** Statuses that show an activity line. */
export const BUSY: ReadonlySet<ThreadStatus> = new Set([
  "starting",
  "running",
  "needsApproval",
  "needsInput",
]);

export const ACTIVITY_THROTTLE_MS = 250;

export const agentStatus = (status: AgentStatus): ThreadStatus => {
  switch (status) {
    case "starting":
      return "starting";
    case "idle":
      return "idle";
    case "running":
    case "compacting":
    case "retrying":
      return "running";
    case "awaitingApproval":
      return "needsApproval";
    case "awaitingInput":
      return "needsInput";
    case "error":
      return "error";
  }
};

export const sameCompaction = (
  a: CompactionActivity | undefined,
  b: CompactionActivity | undefined,
): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.startedAt === b.startedAt &&
    a.trigger === b.trigger &&
    a.preTokens === b.preTokens);

/** A chunk of the agent's own output (text, reasoning, a tool call or its result), not framing. */
export const showsProgress = (chunk: GramUIMessageChunk) =>
  chunk.type.startsWith("text-") ||
  chunk.type.startsWith("reasoning-") ||
  chunk.type.startsWith("tool-");

export const makeTurnId = () => Schema.decodeSync(TurnId)(randomUUID());

export const makeThreadId = () => Schema.decodeSync(ThreadId)(randomUUID());

export const makeQueueItemId = () => Schema.decodeSync(QueueItemId)(randomUUID());

export const locked = <A, E, R>(rt: Runtime, effect: Effect.Effect<A, E, R>) =>
  rt.lock.withPermits(1)(effect);

/**
 * Idle with a session and no background subagent, which stopping the session would kill; the last
 * one to finish arms the idle timer again. Holds the lock.
 */
/** Statuses in which a queued item has nothing to wait for. */
export const NOTHING_RUNNING: ReadonlySet<ThreadStatus> = new Set(["idle", "error", "cold"]);

export const evictable = (rt: Runtime) =>
  rt.status === "idle" && rt.session !== undefined && !rt.activity.subagentsRunning;

/**
 * How much longer than the idle timeout a background task (a `pnpm check` left running, say) keeps
 * an idle session, whose end would kill it and the turn the agent opens when it finishes. Bounded,
 * because a dev server or a `tail -f` never finishes.
 */
export const BACKGROUND_TASK_GRACE = Duration.hours(1);

/** The most of a background shell's output kept and sent: the 8 KiB one read returns. */
export const BACKGROUND_OUTPUT_CHARS = 8_192;

export const feedLocked = <A, E, R>(rt: Runtime, effect: Effect.Effect<A, E, R>) =>
  rt.feedLock.withPermits(1)(effect);

/**
 * Another subsystem's code, whose failure is logged and never becomes the runtime's. An interrupt
 * alone is no failure: the server shutting down stops a callback under way, and says nothing wrong.
 */
export const guarded = (threadId: ThreadId, what: string, effect: Effect.Effect<void>) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      (Cause.hasInterruptsOnly(cause)
        ? Effect.logDebug(`${what} interrupted`)
        : Effect.logWarning(`${what} failed`)
      ).pipe(Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) })),
    ),
  );

/** Hooks belong to other subsystems (git checkpoints); their failures never fail a turn. */
export const runHook = (rt: Runtime, name: string, hook: Effect.Effect<void>) =>
  guarded(rt.threadId, `turn hook ${name}`, hook);

/** How a turn came to end: the adapter said so, or the host ended it itself and why. */
export type TurnEndOrigin = "adapter" | "recovered" | "sessionExit" | "sendFailed";

export const queueIndex = (rt: Runtime, itemId: QueueItemId) =>
  Effect.suspend(() => {
    const index = rt.queue.findIndex((item) => item.id === itemId);
    return index === -1
      ? Effect.fail(new NotFound({ entity: "queueItem", id: itemId }))
      : Effect.succeed(index);
  });

/** `message` with a `data-*` part replaced by type + id, or appended. */
export const withDataPart = (message: GramUIMessage, chunk: GramUIMessageChunk): GramUIMessage => {
  const c = chunk as unknown as { type: string; id?: string; data: unknown };
  const parts = message.parts as unknown as ReadonlyArray<{ type: string; id?: string }>;
  const part = { type: c.type, ...(c.id === undefined ? {} : { id: c.id }), data: c.data };
  const index =
    c.id === undefined ? -1 : parts.findIndex((p) => p.type === c.type && p.id === c.id);
  const next = index === -1 ? [...parts, part] : parts.map((p, i) => (i === index ? part : p));
  return { ...message, parts: next } as unknown as GramUIMessage;
};

/** `thread.status` for `rt`, with its compaction while one is under way. */
export const statusEvent = (
  rt: Runtime,
  status: ThreadStatus,
  line: string | undefined,
): ServerEvent => ({
  type: "thread.status",
  threadId: rt.threadId,
  status,
  ...(line === undefined ? {} : { detail: line }),
  ...(rt.compaction === undefined ? {} : { compaction: rt.compaction }),
});

/** The top-level reply turn `turnId` streamed, finished or not; read before `finishTurn` drops it. */
export const replyOf = (rt: Runtime, turnId: TurnId | undefined) =>
  turnId === undefined
    ? undefined
    : [...rt.open.values()].findLast((f) => !f.nested && f.turnId === turnId)?.messageId;

/**
 * The agent's compaction marker, saying it was Gram's idle compaction and that it completed, when
 * the running turn is one; any other chunk as it is.
 */
export const idleCompactionMarker = (
  rt: Runtime,
  chunk: GramUIMessageChunk,
): GramUIMessageChunk => {
  const idle = rt.turn?.idleCompaction;
  if (idle === undefined || chunk.type !== "data-compaction") return chunk;
  idle.compacted = true;
  return {
    ...chunk,
    data: {
      ...chunk.data,
      reason: "idle",
      outcome: "completed",
      ...(idle.workspaceId === undefined ? {} : { workspaceId: idle.workspaceId }),
    },
  };
};

/** Whether a close with `done`'s options did all that `wanted` asks of the checkout. */
export const coversRelease = (done: CloseThreadOptions, wanted: CloseThreadOptions) =>
  wanted.removeWorktree === undefined ||
  (done.removeWorktree !== undefined &&
    (wanted.permissionRules ?? []).every((rule) => done.permissionRules?.includes(rule)));

/**
 * Nothing running, queued or started: the state a guarded close (`onlyAtRest`) requires. Pending
 * requests are the store's, and the caller checks them. Holds the lock.
 */
export const atRest = (rt: Runtime): boolean =>
  (rt.status === "idle" || rt.status === "cold" || rt.status === "ended") &&
  rt.turn === undefined &&
  rt.queue.length === 0 &&
  rt.background.length === 0 &&
  !rt.activity.subagentsRunning;

/** A thread's runtime, made cold from the store the first time it is asked for. */
export type GetRuntime = (threadId: ThreadId) => Effect.Effect<Runtime, ThreadNotFound>;
