import * as Schema from "effect/Schema";
import { MessageId, RequestId, ThreadId } from "./ids.ts";
import { UIMessageSchema } from "./ui-message.ts";

/** How one answer of `thread.respondMany` went. */
export const RespondManyResult = Schema.Struct({
  threadId: ThreadId,
  requestId: RequestId,
  ok: Schema.Boolean,
  /** Why it wasn't given, when `ok` is false. */
  error: Schema.optionalKey(Schema.String),
});
export type RespondManyResult = typeof RespondManyResult.Type;

export const CheckoutRequest = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("current") }),
  Schema.Struct({
    kind: Schema.Literal("newWorktree"),
    branch: Schema.String,
    base: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("existingWorktree"), path: Schema.String }),
]);
export type CheckoutRequest = typeof CheckoutRequest.Type;

export const SendResult = Schema.Struct({
  /** True when a turn was running and the input joined the queue. */
  queued: Schema.Boolean,
});
export type SendResult = typeof SendResult.Type;

/**
 * When a running turn meets `thread.restartSession`: `interrupt` ends it as interrupted and
 * restarts at once, `afterTurn` restarts once it ends.
 */
export const RestartMidTurn = Schema.Literals(["interrupt", "afterTurn"]);
export type RestartMidTurn = typeof RestartMidTurn.Type;

/**
 * What `thread.restartSession` did: `restarting` stops the session and opens it again now,
 * `afterTurn` does once the running turn ends, and `noSession` restarted nothing, since the thread
 * has no conversation yet and its first message opens a session that reads everything anyway.
 */
export const RestartSessionResult = Schema.Literals(["restarting", "afterTurn", "noSession"]);
export type RestartSessionResult = typeof RestartSessionResult.Type;

/**
 * What `thread.startSession` did: `starting` opened the thread's session, and `open` found one open
 * or opening already.
 */
export const StartSessionResult = Schema.Literals(["starting", "open"]);
export type StartSessionResult = typeof StartSessionResult.Type;

export const ThreadSearchHit = Schema.Struct({
  threadId: ThreadId,
  messageId: Schema.optionalKey(MessageId),
  title: Schema.String,
  snippet: Schema.String,
  /** Matched ranges in `snippet`, as UTF-16 offsets with `end` exclusive. */
  highlights: Schema.optionalKey(
    Schema.Array(Schema.Struct({ start: Schema.Int, end: Schema.Int })),
  ),
});
export type ThreadSearchHit = typeof ThreadSearchHit.Type;

/** A page of a thread's older history (`thread.history`). */
export const ThreadHistoryPage = Schema.Struct({
  messages: Schema.Array(UIMessageSchema),
  /** There is more history before these. */
  earlier: Schema.Boolean,
});
export type ThreadHistoryPage = typeof ThreadHistoryPage.Type;

export const ThreadSearchResult = Schema.Struct({
  hits: Schema.Array(ThreadSearchHit),
  /** More hits than `limit`. */
  truncated: Schema.Boolean,
});
export type ThreadSearchResult = typeof ThreadSearchResult.Type;
