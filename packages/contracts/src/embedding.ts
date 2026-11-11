// The wire shapes of the two endpoints an embedding deployment can point a server at: a decision
// hook asked before each outward action, and an event sink that is sent what happens, in order.
// Both are off unless configured (`ServerConfigShape.decisionHook`, `.eventSink`), and both are
// version 1: a receiver ignores fields, actions and event types it doesn't know.

import * as Schema from "effect/Schema";

export const EMBEDDING_WIRE_VERSION = 1;

/**
 * What a decision is asked about. An open set on the wire: these are the ones this build sends,
 * and a receiver should answer one it doesn't know as it would any other.
 */
export const DecisionAction = Schema.Literals([
  "spawn",
  "push",
  "pr.open",
  "pr.merge",
  "pr.close",
  "release",
  "workflow.run",
  "repo.delete",
  "connector.call",
  /**
   * Placing work on a machine: a session opened or a command run there. `detail.host` says which
   * (`{id, kind: "provisioned" | "joined" | "personal", ownerId?}`), with `command` and `folder`
   * for a command. Named here so the set is stable; nothing in this build asks it yet.
   */
  "host.place",
  /** A shell command that reaches a remote in a way too strange to name. */
  "outward",
]);
export type DecisionAction = typeof DecisionAction.Type;

/** Who caused something: a person (whose `id` is known only behind a fronted sign-in) or a thread. */
export const EmbeddingActor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("person"), id: Schema.optionalKey(Schema.String) }),
  Schema.Struct({
    kind: Schema.Literal("thread"),
    id: Schema.String,
    onBehalfOf: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("system") }),
]);
export type EmbeddingActor = typeof EmbeddingActor.Type;

/** The thread an action is taken in. */
export const DecisionThread = Schema.Struct({
  id: Schema.String,
  workspaceId: Schema.optionalKey(Schema.String),
  role: Schema.optionalKey(Schema.Literals(["orchestrator", "worker", "plain"])),
  spawnedByThreadId: Schema.optionalKey(Schema.String),
});
export type DecisionThread = typeof DecisionThread.Type;

/**
 * The second call for an action a person approved after the first call answered `ask`: the
 * receiver checks the answerer was allowed to, and the action runs only on `allow`.
 */
export const DecisionApproval = Schema.Struct({
  /** The `id` of the call that answered `ask`. */
  decisionId: Schema.String,
  /** The approval card's id, as `ask.opened` carried it. */
  askId: Schema.String,
  answeredBy: Schema.optionalKey(Schema.String),
});
export type DecisionApproval = typeof DecisionApproval.Type;

/** The body POSTed to the decision endpoint. */
export const DecisionRequest = Schema.Struct({
  v: Schema.Literal(EMBEDDING_WIRE_VERSION),
  /** Unique per call: an idempotency key, and what `approval.decisionId` and events refer to. */
  id: Schema.String,
  /** Epoch ms. */
  at: Schema.Number,
  action: DecisionAction,
  /** An agent acting in its turn, or a person acting in the app. */
  initiator: Schema.Literals(["agent", "person"]),
  actor: EmbeddingActor,
  thread: DecisionThread,
  /**
   * What is known about the action, all optional. A push or pull request action: `command` (an
   * agent's own shell line), `repo` (owner/name), `ref`, `base`, `number`, `method`, `draft`,
   * `title`. A connector call: `server`, `tool`, `input`. A spawn: `title`, `project`, `model`,
   * `machine`. Placing work on a host: `host`, `command`, `folder`.
   */
  detail: Schema.Record(Schema.String, Schema.Unknown),
  approval: Schema.optionalKey(DecisionApproval),
});
export type DecisionRequest = typeof DecisionRequest.Type;

/** Whom an `ask` is for; kept on the approval and echoed in `ask.opened`. */
export const DecisionAssignee = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("person"), id: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("role"), role: Schema.String }),
]);
export type DecisionAssignee = typeof DecisionAssignee.Type;

/**
 * The decision endpoint's 200 answer. `ask` puts the action to a person on an approval card. Any
 * other status, a timeout or a body that doesn't read as this is taken as `refuse`.
 */
export const DecisionResponse = Schema.Struct({
  decision: Schema.Literals(["allow", "refuse", "ask"]),
  /** Shown to the person and the agent with a refusal, and on the card with an `ask`. */
  reason: Schema.optionalKey(Schema.String),
  assignees: Schema.optionalKey(Schema.Array(DecisionAssignee)),
  title: Schema.optionalKey(Schema.String),
});
export type DecisionResponse = typeof DecisionResponse.Type;

/**
 * The event types this build sends; an open set on the wire.
 *
 * - `sink.started`: the server started, with `data.threads`, every open thread as `thread.upsert`
 *   would send it, so a receiver can put right anything a crash kept from the outbox.
 * - `thread.upsert` `{id, title?, role?, status?, spawnedByThreadId?, model?}`,
 *   `thread.removed` `{id}`, `thread.status` `{id, status, idle}`.
 * - `ask.opened` `{id, kind, title, decisionId?, assignees?}`.
 * - `ask.resolved` `{id, how, decision?, answeredBy?}`: `how` is `answered` when a person
 *   answered it and `withdrawn` when it went unanswered (the turn stopped, the session went, the
 *   agent took it back). `decision` is the person's `approve` or `reject` of an approval or a
 *   plan; `answeredBy` is their id, where the server knows who is signed in.
 * - `featureCard.upsert` `{id: "<workspaceId>/<feature>", title, status, version}`.
 * - `usage` `{model?, inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, costUsd?}`.
 * - `decision` `{id, action, decision, reason?}`: each call to the decision hook and its outcome.
 */
export const SinkEventType = Schema.Literals([
  "sink.started",
  "thread.upsert",
  "thread.removed",
  "thread.status",
  "ask.opened",
  "ask.resolved",
  "featureCard.upsert",
  "usage",
  "decision",
]);
export type SinkEventType = typeof SinkEventType.Type;

/** One event of the sink's sequence. */
export const SinkEvent = Schema.Struct({
  /** From 1, with no gaps, per `source`. */
  seq: Schema.Int,
  /** Epoch ms the event was recorded. */
  at: Schema.Number,
  type: Schema.String,
  threadId: Schema.optionalKey(Schema.String),
  workspaceId: Schema.optionalKey(Schema.String),
  actor: Schema.optionalKey(EmbeddingActor),
  data: Schema.Record(Schema.String, Schema.Unknown),
});
export type SinkEvent = typeof SinkEvent.Type;

/** The body POSTed to the sink endpoint: consecutive events, lowest `seq` first. */
export const SinkBatch = Schema.Struct({
  v: Schema.Literal(EMBEDDING_WIRE_VERSION),
  /** The outbox's own id, made with it: a new outbox is a new source, whose `seq` starts at 1. */
  source: Schema.String,
  events: Schema.Array(SinkEvent),
});
export type SinkBatch = typeof SinkBatch.Type;

/**
 * The sink endpoint's 200 answer: the highest `seq` it durably holds for the source, with nothing
 * missing below it. It is the authority: the next batch starts at `ack + 1`, whether that is
 * ahead of the batch just sent or behind it. Delivery is at least once, so a receiver ignores a
 * `seq` at or below its own.
 */
export const SinkAck = Schema.Struct({ ack: Schema.Int });
export type SinkAck = typeof SinkAck.Type;
