// The orchestration service's durable state for one workspace: what the last acknowledged digest
// knew, the delivery in flight, the day's spend and what the ledger remembers of each worker.
//
// The store keeps it as an opaque JSON string (`getOutbox` / `putOutbox`); this module is the only
// place that knows its shape, and every read and write goes through the codec here. Rows carry the
// version of their shape (`OUTBOX_VERSION`), and a read tells a workspace with no row from one whose
// row this build can't read, which the service reports and doesn't overwrite.

import {
  AgentFailureKind,
  ModelRef,
  BackgroundTaskKind,
  PrRef,
  PrWakeFired,
  PrWakeEvent,
  PrWatchSeen,
  ReasoningVariant,
  ThreadId,
  type PendingWake,
  TurnId,
  WorkerState,
  WorkerQuestion,
  WorkerQuiet,
  type WorkspaceId,
} from "@gram/contracts";
import * as Schema from "effect/Schema";
import { createHash } from "node:crypto";
import { decodeStored, type FieldPath } from "../persistence/stored.ts";
import type { DigestSnapshot } from "./rules.ts";

/** What the last acknowledged digest knew about one worker; `rules.ts`'s `WorkerSnapshot`. */
const SnapshotEntry = Schema.Struct({
  state: WorkerState,
  feature: Schema.String,
  title: Schema.String,
  interface: Schema.optionalKey(Schema.String),
  overlapsWith: Schema.Array(Schema.String),
  actionKey: Schema.optionalKey(Schema.String),
  reportKey: Schema.optionalKey(Schema.String),
  turnEnds: Schema.optionalKey(Schema.Int),
  quietKey: Schema.optionalKey(Schema.String),
  worktreeMissing: Schema.optionalKey(Schema.Literal(true)),
});

const Snapshot = Schema.Record(Schema.String, SnapshotEntry);

/** `digestDiff`'s next snapshot as the outbox stores it: the same entries, without `undefined` keys. */
export const storedSnapshot = (snapshot: DigestSnapshot): typeof Snapshot.Type =>
  Object.fromEntries(
    Object.entries(snapshot).map(
      ([
        threadId,
        {
          interface: contract,
          turnEnds,
          quietKey,
          worktreeMissing,
          actionKey,
          reportKey,
          ...entry
        },
      ]) => [
        threadId,
        {
          ...entry,
          ...(actionKey === undefined ? {} : { actionKey }),
          ...(reportKey === undefined ? {} : { reportKey }),
          ...(contract === undefined ? {} : { interface: contract }),
          ...(turnEnds === undefined ? {} : { turnEnds }),
          ...(quietKey === undefined ? {} : { quietKey }),
          ...(worktreeMissing === undefined ? {} : { worktreeMissing }),
        },
      ],
    ),
  );

/** A digest handed to the runtime and not yet accepted or failed. */
export const InFlightDigest = Schema.Struct({
  /** The generation it carries; a redelivery after a failure carries the same one. */
  generation: Schema.Int,
  /** The turn that carries it: only that turn's acceptance acknowledges it. */
  turnId: TurnId,
  /** The highest report sequence number the digest included. */
  reportSeqUpTo: Schema.Int,
  /** The ledger as the digest told it, which becomes the snapshot on acknowledgment. */
  nextSnapshot: Snapshot,
  /**
   * The id after the last note the digest carried: acknowledgment drops the notes before it, and
   * none written since.
   */
  notesUpTo: Schema.Int,
  /** The due wakes (`dueWakes`) the digest told of, by id, dropped on acknowledgment. */
  dueWakesTaken: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The closed questions whose copy the digest carried, by id, no longer owed on acknowledgment. */
  questionCopiesTaken: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Live removals this digest told of, by event id; later removals remain owed. */
  liveRemovalsTaken: Schema.optionalKey(Schema.Array(Schema.String)),
  /** `contextNoted` once it is acknowledged. */
  contextNoted: Schema.optionalKey(Schema.Boolean),
  /** `tidyNoted` once it is acknowledged. */
  tidyNoted: Schema.optionalKey(Schema.Array(Schema.String)),
  /** `interfacesRead` once it is acknowledged. */
  interfacesRead: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** Epoch ms the ledger was read for it. */
  claimedAt: Schema.Number,
  /** It told of the orchestrator's limit wait (`OutboxState.limited`), dropped on acknowledgment. */
  limitNoted: Schema.optionalKey(Schema.Boolean),
});
export type InFlightDigest = typeof InFlightDigest.Type;

/**
 * The orchestrator waited out a provider limit, with its digests held meanwhile: the first digest
 * after the wait says how long it lasted and which workers resumed, and is acknowledged with it.
 */
const OrchestratorLimit = Schema.Struct({
  /** Epoch ms the orchestrator stopped on the limit. */
  since: Schema.Number,
  /** Epoch ms the wait ended; absent while it lasts. */
  endedAt: Schema.optionalKey(Schema.Number),
  /** Workers that resumed from a limit since, oldest first. */
  resumed: Schema.Array(ThreadId),
});
type OrchestratorLimit = typeof OrchestratorLimit.Type;

/** A piece of background work a worker has going, kept so a restart can say what it stopped. */
export const BackgroundWork = Schema.Struct({
  kind: BackgroundTaskKind,
  description: Schema.String,
  command: Schema.optionalKey(Schema.String),
  subagentType: Schema.optionalKey(Schema.String),
});
export type BackgroundWork = typeof BackgroundWork.Type;

/** What the loop guard and the ledger remember about one worker. */
export const WorkerMemo = Schema.Struct({
  /** Messages the orchestrator has sent it, the brief not counted. Shown, never capped. */
  messages: Schema.Int,
  /** The user typed into it since its last report, and hasn't handed it back or let it lapse. */
  userIntervened: Schema.Boolean,
  /** Epoch ms of the latest input the user typed into it; without it the hold counts from `lastInputAt`. */
  userInputAt: Schema.optionalKey(Schema.Number),
  /** Epoch ms of the latest input it was given, by the orchestrator or the user. */
  lastInputAt: Schema.Number,
  /** A turn has started, so the brief was picked up. */
  started: Schema.Boolean,
  /** Turns that ended with nothing queued behind them; the digest tells a new one from an old. */
  turnEnds: Schema.Int,
  /** It has reported in the turn now running, which `turnEndsAtReport` is set from as it ends. */
  reportInTurn: Schema.optionalKey(Schema.Boolean),
  /**
   * `turnEnds` as of the stop that ended the last turn it reported in, so that stop isn't taken
   * for a turn that ended without a word. Unset by a reporting turn that ended with more queued,
   * whose end isn't counted, so the stop after it, a turn of its own, still is.
   */
  turnEndsAtReport: Schema.optionalKey(Schema.Int),
  /** The latest unreported stop; a new turn or report supersedes it. */
  quiet: Schema.optionalKey(WorkerQuiet),
  /** The advisory `spawn_worker.scope` claim. */
  scope: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Its background work as last reported; absent when it has none. A restart stops all of it. */
  background: Schema.optionalKey(Schema.Array(BackgroundWork)),
});
export type WorkerMemo = typeof WorkerMemo.Type;

/**
 * Today's spend across the orchestrator and its workers, accumulated from cumulative counters.
 * Information for the ledger; nothing is enforced against it.
 */
export const CostBucket = Schema.Struct({
  /** Epoch ms of the local midnight the bucket belongs to. */
  day: Schema.Number,
  /**
   * The bucket's calendar date, `YYYY-MM-DD`, in the zone it was accrued in. A zone change within
   * the same day keeps the spend; absent for a bucket kept before this, which compares by `day`.
   */
  date: Schema.optionalKey(Schema.String),
  usd: Schema.Number,
  /** Each thread's cumulative `usage.costUsd` when it was last read. */
  seen: Schema.Record(Schema.String, Schema.Number),
});
export type CostBucket = typeof CostBucket.Type;

/**
 * A handoff that has been asked for and isn't over, kept here so a restart in the middle of
 * one finds it. `checkpoint`: the orchestrator has been, or is about to be, asked to write down
 * what isn't in memory yet, and the fresh session waits for that turn to end. `fresh`: the old
 * session is being replaced; `previousAgentSessionId` is what it was when that began, so a restart
 * can tell a replacement that happened from one that didn't.
 */
export const HandoffMarker = Schema.Struct({
  reason: Schema.Literals(["context", "compactions", "user"]),
  target: Schema.optionalKey(ModelRef),
  /** Epoch ms; also the `at` of the transcript's handoff part, which is how a restart finds it. */
  at: Schema.Number,
  phase: Schema.Literals(["checkpoint", "fresh"]),
  /** The turn that carries the checkpoint prompt, once one does. */
  checkpointTurnId: Schema.optionalKey(TurnId),
  previousAgentSessionId: Schema.optionalKey(Schema.String),
});
export type HandoffMarker = typeof HandoffMarker.Type;

/** One delegated `send_message` made with a `clientRequestId`. */
export const SentRequest = Schema.Struct({
  /** Sibling senders have separate retry ids; absent for existing orchestrator records. */
  sender: Schema.optionalKey(ThreadId),
  threadId: ThreadId,
  title: Schema.String,
  delivered: Schema.Literals(["sent", "queued", "steered"]),
  /** `sendFingerprint` of what was sent, so reusing the id for another message is caught. */
  fingerprint: Schema.String,
  /** Epoch ms, which decides the oldest to drop past `SENT_REQUESTS_KEPT`. */
  at: Schema.Number,
});
export type SentRequest = typeof SentRequest.Type;

/**
 * A worker's question as the outbox keeps it (docs/design/worker-questions.md): the record every
 * surface reads, and whether the orchestrator is still owed its copy of how the user closed it.
 */
export const StoredWorkerQuestion = Schema.Struct({
  ...WorkerQuestion.fields,
  /** The user closed it and no acknowledged digest has told the orchestrator yet. */
  copyOwed: Schema.optionalKey(Schema.Literal(true)),
  /** The message in the worker's transcript holding its card, which each change replaces in place. */
  cardMessageId: Schema.optionalKey(Schema.String),
  /**
   * It is answered or dismissed, written with that decision, and the worker hasn't been handed the
   * notice yet. Cleared once a send is acknowledged or the worker can't take one (gone, archived,
   * another workspace's); until then a retry or a restart sends it again.
   */
  deliveryOwed: Schema.optionalKey(Schema.Literal(true)),
});
export type StoredWorkerQuestion = typeof StoredWorkerQuestion.Type;

/** A `schedule_wake` not yet due, kept so a restart arms it again. */
export const StoredWake = Schema.Struct({
  id: Schema.String,
  /** The orchestrator or one of its workers. */
  threadId: ThreadId,
  /** Epoch ms it is due. */
  at: Schema.Number,
  note: Schema.String,
  /** Epoch ms it was set. */
  setAt: Schema.Number,
  /** The PR whose events it waits for beside `at`, which is then its fallback. */
  onPr: Schema.optionalKey(PrRef),
  on: Schema.optionalKey(Schema.Array(PrWakeEvent)),
  /** What it saw of `onPr` when it was set. */
  seen: Schema.optionalKey(PrWatchSeen),
  /**
   * The event of `onPr` that fired it, kept from the moment it fires: a pause holds a worker's,
   * and the resume delivers it even if the PR has moved back since (checks rerun, say).
   */
  fired: Schema.optionalKey(PrWakeFired),
});
export type StoredWake = typeof StoredWake.Type;

/**
 * What the user chose when a spawn found a subscription limit at the workspace's threshold
 * (`OrchestratorCharter.pauseAtLimitPct`): new workers on that agent paused, or spawning kept going,
 * either way until the window resets. Asked once per window, so a later spawn reads it here.
 */
export const LimitHold = Schema.Struct({
  agent: Schema.String,
  /** The agent's name for the window: `five_hour` or `seven_day`. */
  window: Schema.String,
  decision: Schema.Literals(["paused", "keepGoing"]),
  /** Epoch ms the window resets, when the hold ends and paused workers resume. */
  until: Schema.Number,
  /** The share used when the user was asked, as a whole percent. */
  usedPct: Schema.Int,
  /** Epoch ms the user answered. */
  at: Schema.Number,
});
export type LimitHold = typeof LimitHold.Type;

/**
 * A worker the user's resume lets go of in its turn, as the limit resume's batches do: its queue
 * waits until `at`, and one whose turn the pause stopped is then told to continue.
 */
export const PauseResume = Schema.Struct({
  threadId: ThreadId,
  /** Epoch ms it is let go. */
  at: Schema.Number,
  /** The pause stopped its turn. */
  stopped: Schema.optionalKey(Schema.Literal(true)),
  /** Epoch ms the pause began. */
  pausedAt: Schema.Number,
  /** Epoch ms the user resumed. */
  resumedAt: Schema.Number,
});
export type PauseResume = typeof PauseResume.Type;

/**
 * A low-priority `spawn_worker` held near a subscription limit (`HeldBrief`): the call as it would
 * have spawned, kept until the limit resets or the user releases it.
 */
export const StoredSpawnBreaker = Schema.Struct({
  model: ModelRef,
  kind: AgentFailureKind,
  at: Schema.Number,
  cleared: Schema.optionalKey(Schema.Literal(true)),
});
export type StoredSpawnBreaker = typeof StoredSpawnBreaker.Type;

export const StoredHeldBrief = Schema.Struct({
  breaker: Schema.optionalKey(StoredSpawnBreaker),
  id: Schema.String,
  /** The orchestrator thread that asked for it. */
  callerId: ThreadId,
  input: Schema.Struct({
    project: Schema.String,
    alsoIn: Schema.optionalKey(Schema.Array(Schema.String)),
    feature: Schema.String,
    title: Schema.String,
    brief: Schema.String,
    branch: Schema.optionalKey(Schema.String),
    base: Schema.optionalKey(Schema.String),
    model: Schema.optionalKey(Schema.String),
    effort: Schema.optionalKey(ReasoningVariant),
    scope: Schema.optionalKey(Schema.Array(Schema.String)),
    readAlso: Schema.optionalKey(Schema.Array(Schema.String)),
    clientRequestId: Schema.optionalKey(Schema.String),
    group: Schema.optionalKey(Schema.String),
    identities: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    plan: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  /** The project's name, for the card. */
  projectName: Schema.String,
  agent: Schema.String,
  /** The agent's name for the window it waits on: `five_hour` or `seven_day`. */
  window: Schema.String,
  usedPct: Schema.Int,
  /** Epoch ms the window resets, when it is released. */
  until: Schema.Number,
  /** Epoch ms it was held. */
  heldAt: Schema.Number,
  /** Already assigned a batch after headroom or a successful turn; further readings keep it. */
  releasedEarly: Schema.optionalKey(Schema.Literal(true)),
  /**
   * Epoch ms of the next try, after `until`: a release found every worker slot taken, or the spawn
   * refused for now (rate limited, paused). Absent until a release has been tried.
   */
  retryAt: Schema.optionalKey(Schema.Number),
  /** Releases the spawn refused for now, given up after `HELD_RETRIES_MAX`. */
  attempts: Schema.optionalKey(Schema.Int),
  /** The last release found every worker slot taken (`maxConcurrentWorkers`). */
  waitsForSlot: Schema.optionalKey(Schema.Literal(true)),
});
export type StoredHeldBrief = typeof StoredHeldBrief.Type;

/** When a held brief is next tried: its reset, or the later retry a release set. */
export const heldDueAt = (brief: Pick<StoredHeldBrief, "until" | "retryAt">): number =>
  Math.max(brief.until, brief.retryAt ?? 0);

/** A wake as the ledger and the chips show it: when, the note, and the PR it waits on, if any. */
const pendingWakeOf = (wake: {
  readonly id: string;
  readonly at: number;
  readonly note: string;
  readonly onPr?: PrRef | undefined;
  readonly on?: ReadonlyArray<PrWakeEvent> | undefined;
}): PendingWake => ({
  id: wake.id,
  at: wake.at,
  note: wake.note,
  ...(wake.onPr === undefined ? {} : { onPr: wake.onPr }),
  ...(wake.on === undefined ? {} : { on: wake.on }),
});

/** A thread's pending wakes as the ledger shows them, soonest first. */
export const wakesOf = (outbox: OutboxState, threadId: ThreadId): ReadonlyArray<PendingWake> =>
  (outbox.wakes ?? [])
    .filter((wake) => wake.threadId === threadId)
    .toSorted((a, b) => a.at - b.at)
    .map(pendingWakeOf);

/** The outbox with `gone` taken out of its wakes; the same object when none of them was there. */
export const withoutWakes = (
  outbox: OutboxState,
  gone: ReadonlyArray<Pick<StoredWake, "id">>,
): OutboxState => {
  const ids = new Set(gone.map((wake) => wake.id));
  const kept = (outbox.wakes ?? []).filter((wake) => !ids.has(wake.id));
  if (kept.length === (outbox.wakes ?? []).length) return outbox;
  const { wakes: _, ...rest } = outbox;
  return kept.length === 0 ? rest : { ...rest, wakes: kept };
};

/** How many `notes` an outbox keeps; past it the oldest are dropped unsent. */
const NOTES_KEPT = 10;

/** The outbox with `added` after its notes, the oldest dropped past `NOTES_KEPT`. */
export const withNotes = (outbox: OutboxState, added: ReadonlyArray<string>): OutboxState => {
  if (added.length === 0) return outbox;
  const all = [...outbox.notes, ...added];
  const dropped = Math.max(0, all.length - NOTES_KEPT);
  return { ...outbox, notes: all.slice(dropped), notesFrom: (outbox.notesFrom ?? 0) + dropped };
};

/** The id the next note will take, which a digest carrying every note now pending records. */
export const notesEnd = (outbox: OutboxState): number =>
  (outbox.notesFrom ?? 0) + outbox.notes.length;

/** The outbox once a digest that carried the notes before id `upTo` is acknowledged. */
export const withNotesAcked = (outbox: OutboxState, upTo: number): OutboxState => {
  const from = outbox.notesFrom ?? 0;
  const acked = Math.min(Math.max(0, upTo - from), outbox.notes.length);
  if (acked === 0) return outbox;
  return { ...outbox, notes: outbox.notes.slice(acked), notesFrom: from + acked };
};

/** How many `sentRequests` an outbox keeps; a retry comes within seconds, not a hundred sends on. */
export const SENT_REQUESTS_KEPT = 100;

export const OutboxState = Schema.Struct({
  /** Provider launch failures and recovery receipts, separate from subscription limits. */
  spawnBreakers: Schema.optionalKey(Schema.Array(StoredSpawnBreaker)),
  /** Acknowledged digests so far; the next digest carries this number plus one. */
  generation: Schema.Int,
  /**
   * Epoch ms the last acknowledged digest read the ledger, which a stage set later postdates even
   * when the digest was accepted after it. Absent before the first.
   */
  lastDigestAt: Schema.optionalKey(Schema.Number),
  /**
   * By thread id, a hash of the interface this session has read from that worker, quoted whole in
   * an acknowledged digest. A handoff drops it, since the fresh session has read none.
   */
  interfacesRead: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** The first digest of this orchestrator thread has been acknowledged. */
  booted: Schema.Boolean,
  snapshot: Snapshot,
  /** Removed while parked since the last digest, so a stale live snapshot cannot wake over them. */
  archivedRemovals: Schema.optionalKey(Schema.Array(ThreadId)),
  /** Live-worker losses owed a digest, even when the snapshot never saw them live. */
  liveRemovals: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        threadId: ThreadId,
        action: Schema.Literals(["closed", "detached", "moved"]),
      }),
    ),
  ),
  ackedReportSeq: Schema.Int,
  inFlight: Schema.optionalKey(InFlightDigest),
  /** Consecutive deliveries that failed. */
  failures: Schema.Int,
  workers: Schema.Record(Schema.String, WorkerMemo),
  /**
   * `spawn_worker.clientRequestId` → the worker it makes, written before its worktrees are, so a
   * retried call makes no second one.
   */
  requests: Schema.Record(Schema.String, ThreadId),
  /** Retry id (sender-scoped for sibling sends) → what that send did. Existing orchestrator ids stay unchanged. */
  sentRequests: Schema.optionalKey(Schema.Record(Schema.String, SentRequest)),
  cost: CostBucket,
  /** Times the orchestrator changed a workspace checkout itself. */
  orchestratorEdits: Schema.Int,
  /** Server remarks waiting for the next digest, oldest first, at most `NOTES_KEPT`. */
  notes: Schema.Array(Schema.String),
  /**
   * The id of `notes[0]`; each note's id is this plus its index, so ids only grow and a note keeps
   * its id while older ones are dropped ahead of it. Absent means 0.
   */
  notesFrom: Schema.optionalKey(Schema.Int),
  /** A digest has said the context is nearly full, and no reading since has been below that. */
  contextNoted: Schema.optionalKey(Schema.Boolean),
  /** The housekeeping conditions acknowledged digests have noted and that still held (`tidyNotes`). */
  tidyNoted: Schema.optionalKey(Schema.Array(Schema.String)),
  handoff: Schema.optionalKey(HandoffMarker),
  /** Wakes the orchestrator and its workers have set, not yet due; absent when there are none. */
  wakes: Schema.optionalKey(Schema.Array(StoredWake)),
  /**
   * The orchestrator's own wakes that fell due and no acknowledged digest has told of yet. Kept
   * apart from `notes`, whose cap and count-based acknowledgment could lose one.
   */
  dueWakes: Schema.optionalKey(Schema.Array(StoredWake)),
  /** The user's answers at the limit threshold, until their windows reset; absent with none. */
  limitHolds: Schema.optionalKey(Schema.Array(LimitHold)),
  /** Low-priority briefs held until a limit resets, oldest first; absent with none. */
  heldBriefs: Schema.optionalKey(Schema.Array(StoredHeldBrief)),
  /** The orchestrator's limit wait, until a digest after it is acknowledged. */
  limited: Schema.optionalKey(OrchestratorLimit),
  /** Workers the user's last resume hasn't let go of yet, soonest first; absent with none. */
  resuming: Schema.optionalKey(Schema.Array(PauseResume)),
  /** The workers' questions, open and closed, oldest first; absent with none. */
  questions: Schema.optionalKey(Schema.Array(StoredWorkerQuestion)),
  /** The number of the last question id handed out (`WQ<n>`); absent before the first. */
  questionSeq: Schema.optionalKey(Schema.Int),
});
export type OutboxState = typeof OutboxState.Type;

/** A workspace that has never delivered anything. */
export const emptyOutbox: OutboxState = {
  generation: 0,
  booted: false,
  snapshot: {},
  ackedReportSeq: 0,
  failures: 0,
  workers: {},
  requests: {},
  cost: { day: 0, usd: 0, seen: {} },
  orchestratorEdits: 0,
  notes: [],
};

/** A worker nobody has written to or heard from yet. */
export const emptyWorkerMemo = (now: number): WorkerMemo => ({
  messages: 0,
  userIntervened: false,
  lastInputAt: now,
  started: false,
  turnEnds: 0,
});

/** `sentRequests` with `key` recorded, the oldest dropped past `SENT_REQUESTS_KEPT`. */
export const withSentRequest = (
  outbox: OutboxState,
  key: string,
  sent: SentRequest,
): OutboxState => {
  const kept = Object.entries({ ...outbox.sentRequests, [key]: sent })
    .toSorted(([, a], [, b]) => b.at - a.at)
    .slice(0, SENT_REQUESTS_KEPT);
  return { ...outbox, sentRequests: Object.fromEntries(kept) };
};

/** What identifies one `send_message`: its text and mode, hashed. */
export const sendFingerprint = (text: string, mode: string | undefined): string =>
  createHash("sha256")
    .update(JSON.stringify([text, mode ?? null]), "utf8")
    .digest("hex");

/**
 * The thread a `spawn_worker.clientRequestId` makes in a workspace: the same id on every retry, so
 * a crash between the worktrees and the thread row can't lead to a second worker. UUID-shaped.
 */
export const workerThreadId = (workspaceId: WorkspaceId, clientRequestId: string): ThreadId => {
  const hash = createHash("sha256")
    .update(`spawn_worker\0${workspaceId}\0${clientRequestId}`, "utf8")
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return ThreadId.make(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
};

/**
 * The version of the shape `encodeOutbox` writes, kept in the row's `version` beside the state's
 * fields. A change an older build would misread takes the next number, with an upgrade here from
 * the one before; a row numbered above this one was written by a newer build, and a row without
 * one by no build, so both are unreadable here, never taken for an empty outbox. The service replaces a row it can't
 * read with an empty outbox that keeps the old row's text whole in `setAside`, until the user
 * resumes, so a later build that can read it still has it.
 */
export const OUTBOX_VERSION = 1;

/** A workspace's outbox row as read. `state` is `emptyOutbox` unless the row was `read`. */
export type StoredOutbox =
  | { readonly _tag: "absent"; readonly state: OutboxState }
  | {
      readonly _tag: "read";
      readonly state: OutboxState;
      readonly version: number;
      /** The text of an unreadable row this one took the place of, kept until the user resumes. */
      readonly setAside: string | undefined;
    }
  | {
      readonly _tag: "unreadable";
      readonly state: OutboxState;
      /** The row's own version, when it has a readable one. */
      readonly version: number | undefined;
      /** Where it failed, for the log: field paths, never the values. */
      readonly paths: ReadonlyArray<FieldPath>;
    };

const StoredVersion = Schema.Struct({
  version: Schema.Int,
  setAside: Schema.optionalKey(Schema.String),
});

/** The stored row, told apart: no row, a row of a version this build reads, or neither. */
export const readOutbox = (json: string | undefined): StoredOutbox => {
  if (json === undefined) return { _tag: "absent", state: emptyOutbox };
  const marker = decodeStored(StoredVersion, json);
  if (!marker.ok) {
    return { _tag: "unreadable", state: emptyOutbox, version: undefined, paths: marker.paths };
  }
  const version = marker.value.version;
  if (version < 1 || version > OUTBOX_VERSION) {
    return { _tag: "unreadable", state: emptyOutbox, version, paths: [["version"]] };
  }
  const decoded = decodeStored(OutboxState, json);
  return decoded.ok
    ? { _tag: "read", state: decoded.value, version, setAside: marker.value.setAside }
    : { _tag: "unreadable", state: emptyOutbox, version, paths: decoded.paths };
};

/** The stored row as state, `emptyOutbox` for one that isn't there or can't be read. */
export const decodeOutbox = (json: string | undefined): OutboxState => readOutbox(json).state;

const encode = Schema.encodeSync(OutboxState);

/** The row for `state`, carrying `setAside` when an unreadable row it replaced is still kept. */
export const encodeOutbox = (state: OutboxState, setAside?: string): string =>
  JSON.stringify({
    version: OUTBOX_VERSION,
    ...encode(state),
    ...(setAside === undefined ? {} : { setAside }),
  });

/**
 * The outbox once a handoff has given the same orchestrator thread a fresh agent session. Its next
 * digest is a `boot` again, which is all a new session knows, while everything the server knows
 * stays: the snapshot, so that boot and the digests after it are still a diff against what was last
 * acknowledged (a handoff acknowledges nothing), the workers, the requests and the spend. A delivery
 * still marked in flight was the old session's, so the same generation is built again, and the new
 * session's context is empty, so its first crossing is noted again, and so is what is left to tidy,
 * and each worker's interface is quoted whole again.
 */
export const outboxAfterHandoff = (previous: OutboxState): OutboxState => {
  const {
    inFlight: _inFlight,
    handoff: _handoff,
    contextNoted: _noted,
    tidyNoted: _tidy,
    interfacesRead: _read,
    ...rest
  } = previous;
  return { ...rest, booted: false, failures: 0 };
};

/**
 * The outbox once the orchestrator's context has been read below the note's threshold, so its next
 * crossing is noted. A digest still in flight gives its crossing up too, or its acknowledgment would
 * bring back one that has already ended. The same object when there was nothing to clear.
 */
export const outboxContextRearmed = (previous: OutboxState): OutboxState => {
  const { inFlight } = previous;
  const flightNoted = inFlight?.contextNoted === true;
  if (previous.contextNoted !== true && !flightNoted) return previous;
  return {
    ...previous,
    contextNoted: false,
    ...(inFlight === undefined || !flightNoted
      ? {}
      : { inFlight: { ...inFlight, contextNoted: false } }),
  };
};

/**
 * The outbox for an orchestrator thread that has just taken the slot. Delivery starts over (its
 * first digest is a `boot`, it knows no workers, and reports filed for its predecessor are not its
 * to hear), while the generation and the day's spend carry on.
 */
export const outboxForNewOrchestrator = (
  previous: OutboxState,
  latestReportSeq: number,
): OutboxState => ({
  ...emptyOutbox,
  generation: previous.generation,
  ackedReportSeq: latestReportSeq,
  cost: previous.cost,
  ...(previous.spawnBreakers === undefined ? {} : { spawnBreakers: previous.spawnBreakers }),
  // Held briefs are the workspace's, not the session's: the new orchestrator's release spawns them.
  ...(previous.heldBriefs === undefined ? {} : { heldBriefs: previous.heldBriefs }),
  // So are the workers' questions: the new orchestrator triages what is left and gets the copies.
  ...(previous.questions === undefined ? {} : { questions: previous.questions }),
  ...(previous.questionSeq === undefined ? {} : { questionSeq: previous.questionSeq }),
});

/**
 * The outbox once a feature is renamed from `from` to `to`: the last acknowledged snapshot, the one
 * a digest in flight would make the snapshot, and the held briefs all name it by its new slug, so
 * the next digest tells no worker as gone and come back, and a held brief spawns under the new name.
 * The same object when nothing in it names the feature.
 */
export const outboxWithFeatureRenamed = (
  outbox: OutboxState,
  from: string,
  to: string,
): OutboxState => {
  let changed = false;
  const snapshotOf = (snapshot: typeof Snapshot.Type): typeof Snapshot.Type =>
    Object.fromEntries(
      Object.entries(snapshot).map(([threadId, entry]) => {
        if (entry.feature !== from) return [threadId, entry];
        changed = true;
        return [threadId, { ...entry, feature: to }];
      }),
    );
  const snapshot = snapshotOf(outbox.snapshot);
  const inFlight =
    outbox.inFlight === undefined
      ? undefined
      : { ...outbox.inFlight, nextSnapshot: snapshotOf(outbox.inFlight.nextSnapshot) };
  const heldBriefs = outbox.heldBriefs?.map((brief) => {
    if (brief.input.feature !== from) return brief;
    changed = true;
    return { ...brief, input: { ...brief.input, feature: to } };
  });
  const questions = outbox.questions?.map((question) => {
    if (question.feature !== from) return question;
    changed = true;
    return { ...question, feature: to };
  });
  if (!changed) return outbox;
  return {
    ...outbox,
    snapshot,
    ...(inFlight === undefined ? {} : { inFlight }),
    ...(heldBriefs === undefined ? {} : { heldBriefs }),
    ...(questions === undefined ? {} : { questions }),
  };
};
