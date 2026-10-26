import { AutomaticDreamState, completionBaseline } from "./automatic-dream-state.ts";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import {
  type PrWakeFired,
  type PrWatchSeen,
  CLOSED_THREADS_LIMIT,
  DEFAULT_SETTINGS,
  DRAFT_STASH_LIMIT,
  DraftStash,
  Dream,
  DreamWatermark,
  FeatureCard,
  FeatureCardSummary,
  GatewayProfile,
  type GitError,
  InvalidState,
  Label,
  NotFound,
  normalizeThreadPrs,
  Palette,
  PendingRequest,
  PlanItem,
  Project,
  ProjectLocalCheck,
  applyProjectSettingsWrites,
  type SettingsWrite,
  ProjectId,
  SeenConnector,
  Settings,
  TaskChipDataSchema,
  WaitItem,
  Thread,
  ThreadPlan,
  ThreadWake,
  ThreadNotFound,
  UIMessageSchema,
  UsageSummary,
  UserInput,
  WorkerReport,
  WorkspaceState,
  type ClosedThread,
  type CompletedReason,
  type DreamId,
  type LabelId,
  type QueueItemId,
  type QueuedInput,
  type PaletteId,
  type ProfileId,
  type RequestId,
  type StashId,
  type GramUIMessage,
  type TaskChipData,
  type TaskId,
  type WaitId,
  type WaitResolver,
  ThreadId,
  type TurnEndReason,
  type TurnId,
  type WorkspaceId,
  type UsageOverview,
  type UsageOverviewQuery,
} from "@gram/contracts";
import { projectRoot, projectRootKey } from "@gram/git";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { createHash, randomUUID } from "node:crypto";
import { SqlClient, SqlError } from "../platform/unstable.ts";
import { MigrationsLayer } from "./migrations.ts";
import { isLockWait, SearchCatchUp } from "../search/catch-up.ts";
import * as UpdateSeal from "./update-seal.ts";
import * as WalCheckpointer from "./wal-checkpointer.ts";
import { readUsageOverview } from "../usage/query.ts";
import type { UsageHistoryInput } from "../usage/history-reader.ts";
import {
  decodeMended,
  decodeStored,
  decodeStoredValue,
  type FieldPath,
  makeUnreadableLog,
  mapDecoded,
  mendedWrite,
  readableRow,
  readableRows,
} from "./stored.ts";
import { DAY_MS } from "../zone-time.ts";

/** One of a closed orchestrator's workers: the worker, and the feature it was spawned for. */
export const ClosedWorker = Schema.Struct({ threadId: ThreadId, feature: Schema.String });
export type ClosedWorker = typeof ClosedWorker.Type;
const ClosedWorkers = Schema.Array(ClosedWorker);

export interface TurnRecord {
  readonly id: TurnId;
  readonly threadId: ThreadId;
  readonly startedAt: number;
  readonly endedAt: number | undefined;
  readonly reason: TurnEndReason | undefined;
}

interface TaskRecord {
  readonly messageId: string;
  readonly task: TaskChipData;
}

/** A worker's report with the sequence number a digest acknowledges it by. */
interface WorkerReportRecord {
  readonly seq: number;
  readonly report: WorkerReport;
}

/** A worker's latest report, with the interface its reports last stated. */
interface LatestWorkerReport {
  readonly report: WorkerReport;
  /** The latest report's own, or an earlier one's when the latest left it out. */
  readonly interface?: string | undefined;
}

/** One entry to append to a workspace's orchestration audit. */
interface OrchestrationEventEntry {
  /** Epoch ms. */
  readonly at: number;
  /** `spawn`, `message`, `wake`, `pause`, `drift`…; the service owns the vocabulary. */
  readonly kind: string;
  /** Anything JSON can carry. */
  readonly data: unknown;
}

interface OrchestrationEventRecord extends OrchestrationEventEntry {
  readonly seq: number;
  readonly workspaceId: WorkspaceId;
}

/** One approved settings change by chat, as `settings_propose` records it. */
export interface SettingsAuditEntry {
  /** Epoch ms it was applied. */
  readonly at: number;
  /** The thread that proposed it. */
  readonly threadId: ThreadId;
  readonly proposerRole: string;
  readonly scope: "app" | "workspace" | "project";
  readonly projectId?: ProjectId | undefined;
  readonly workspaceId?: WorkspaceId | undefined;
  /** The approval card's request. */
  readonly requestId?: string | undefined;
  /** Who answered the card; only the user can. */
  readonly approvedBy: "user";
  /** Epoch ms the card was answered. */
  readonly approvedAt: number;
  /** Each stored field written, as stored before and after; `null` is absent. */
  readonly changes: ReadonlyArray<{
    readonly key: string;
    readonly before: unknown;
    readonly after: unknown;
  }>;
  /** The rows the card showed the user. */
  readonly shown: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly before: string | null;
    readonly after: string | null;
  }>;
  readonly reason?: string | undefined;
}

interface SettingsAuditRecord extends SettingsAuditEntry {
  readonly seq: number;
}

/** Where a thread's feed stands, for resuming it (`thread.subscribe`'s `afterRev`). */
interface FeedRevision {
  /** The revision of the thread's latest message write. */
  readonly rev: number;
  /** The revision its messages were last removed or replaced at; nothing older can resume. */
  readonly resetRev: number;
}

/** Where one stored message sits, without its text: what a dream's watermark is judged by. */
export interface MessageMark {
  readonly seq: number;
  readonly id: string;
  /** The feed revision it was last written at; 0 for a closed thread's kept copy, which has none. */
  readonly rev: number;
  /**
   * `metadata.createdAt`, or else when its turn ended (or began, while it runs): a reply stored
   * before the runtime dated replies carries no time of its own. `undefined` when neither says.
   */
  readonly at: number | undefined;
  /** Whether it belongs to a turn that hasn't ended. */
  readonly open: boolean;
}

/** A stored message with its seq. */
export interface SeqMessage {
  readonly seq: number;
  readonly message: GramUIMessage;
}

/**
 * Prunes the append-only history tables to what they keep (`ORCHESTRATION_EVENTS_KEPT_MS` and the
 * rest), as of `now`. Run by the store's start.
 */
export const pruneHistory = (sql: SqlClient.SqlClient, now: number) =>
  sql
    .withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM orchestration_events
          WHERE at < ${now - ORCHESTRATION_EVENTS_KEPT_MS}
            AND NOT (kind = 'spawn' AND json_valid(data)
              AND (json_extract(data, '$.threadId') IN (SELECT id FROM threads)
                OR json_extract(data, '$.threadId') IN (SELECT thread_id FROM closed_threads)))`;
        yield* sql`DELETE FROM settings_audit
          WHERE at < ${now - SETTINGS_AUDIT_KEPT_MS}
            AND seq NOT IN (SELECT seq FROM settings_audit ORDER BY seq DESC
              LIMIT ${SETTINGS_AUDIT_KEPT_ROWS})
            AND (request_id IS NULL OR request_id NOT IN (SELECT id FROM requests))`;
        yield* sql`DELETE FROM helper_usage WHERE day < ${utcDayOf(now - HELPER_USAGE_KEPT_MS)}`;
        yield* sql`DELETE FROM helper_events WHERE day < ${utcDayOf(now - HELPER_EVENTS_KEPT_MS)}`;
      }),
    )
    .pipe(
      // History it couldn't prune now waits for the next start; nothing depends on it going.
      Effect.catchCause((cause) =>
        Effect.logWarning("couldn't prune the history tables").pipe(
          Effect.annotateLogs({ cause: Cause.pretty(cause) }),
        ),
      ),
    );

/** Who resolved a Waiting on you item, when, and what they said of it. */
export interface WaitResolution {
  readonly by: WaitResolver;
  readonly at: number;
  readonly note?: string | undefined;
}

/** How long a resolved Waiting on you item is kept, for the tray's Resolved line. */
const RESOLVED_WAITS_KEPT_MS = 30 * DAY_MS;

// What the start's sweep keeps of the append-only history tables (`pruneHistory`). Nothing shows
// these past their windows; each rule keeps whatever something still reads.
/**
 * `orchestration_events`: 90 days. A worker's `spawn` event stays while the worker does, open or
 * closed and reopenable: a `clientRequestId` retry reads it to tell a finished spawn from one a
 * crash cut short.
 */
export const ORCHESTRATION_EVENTS_KEPT_MS = 90 * DAY_MS;
/**
 * `settings_audit`: a year, and the newest 1,000 whatever their age; an entry whose approval
 * request is still open stays too.
 */
export const SETTINGS_AUDIT_KEPT_MS = 365 * DAY_MS;
export const SETTINGS_AUDIT_KEPT_ROWS = 1_000;
/** `helper_usage`: 400 UTC days of daily totals, of which the helper reads today's. */
export const HELPER_USAGE_KEPT_MS = 400 * DAY_MS;
/** `helper_events`: 30 UTC days of daily counts, of which the helper reads the last 7. */
export const HELPER_EVENTS_KEPT_MS = 30 * DAY_MS;

/** The UTC day `at` falls on, as the helper tables key their rows. */
const utcDayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

/** A thread's plan and the agent's latest todo list, as `thread_plans` keeps them. */
export interface ThreadPlanRecord {
  readonly plan: ThreadPlan | undefined;
  readonly turnPlan: ReadonlyArray<PlanItem> | undefined;
}

const TurnPlanJson = Schema.Array(PlanItem);

/** Authority facts read in the same transaction as a guarded thread edit. */
export interface ThreadUpdateContext {
  readonly caller: Thread | undefined;
  readonly workspace: WorkspaceState | undefined;
  readonly settings: Settings;
}

/** Trusted server plan; mutation revalidates its stored target and checkout. */
export interface HistoryRewind {
  readonly messageId: string;
  readonly role: GramUIMessage["role"];
  readonly turnId: TurnId | undefined;
  readonly cwd: string;
  readonly resumeAt: string | undefined;
}

export interface ThreadStoreShape {
  usageOverview(
    query: UsageOverviewQuery,
    history?: UsageHistoryInput,
  ): Effect.Effect<UsageOverview, InvalidState>;
  ensureProject(input: { root: string; name: string; repoRoot?: string }): Effect.Effect<Project>;
  /** `ensureProject`, saying whether this call inserted the row: one transaction decides both. */
  registerProject(input: {
    root: string;
    name: string;
    repoRoot?: string;
  }): Effect.Effect<{ readonly project: Project; readonly created: boolean }>;
  listProjects: Effect.Effect<ReadonlyArray<Project>>;
  updateProjectLocalCheckAudited(
    id: ProjectId,
    writes: ReadonlyArray<SettingsWrite>,
    audit: SettingsAuditEntry,
    expectedRevision: string,
  ): Effect.Effect<{ readonly auditSeq: number } | undefined>;
  setProjectBookmarked(id: ProjectId, bookmarked: boolean): Effect.Effect<Project, NotFound>;
  /** Removes a project from the recents; refused while any thread belongs to it. */
  forgetProject(id: ProjectId): Effect.Effect<void, NotFound | InvalidState>;

  insertThread(thread: Thread): Effect.Effect<void>;
  getThread(id: ThreadId): Effect.Effect<Thread, ThreadNotFound>;
  /** Read-only authority snapshot from one transaction, for the final check after provider I/O. */
  getThreadWithAuthority(
    id: ThreadId,
    callerId: ThreadId,
  ): Effect.Effect<
    { readonly thread: Thread; readonly context: ThreadUpdateContext },
    ThreadNotFound
  >;
  listThreads: Effect.Effect<ReadonlyArray<Thread>>;
  updateThread(
    id: ThreadId,
    f: (thread: Thread, context?: ThreadUpdateContext) => Thread,
    /** Ask for caller/workspace/settings facts atomically with the write. */
    authorityCaller?: ThreadId,
  ): Effect.Effect<Thread, ThreadNotFound>;
  /** Sets `completedAt` with its reason, or clears both. */
  setCompletion(
    id: ThreadId,
    completion: { at: number; reason: CompletedReason } | undefined,
  ): Effect.Effect<Thread, ThreadNotFound>;
  /**
   * Edits a thread's completion (`completedAt`, `completedReason`, `settledMerge`) as the
   * transaction reads it, keeping the `completed_reason` column in step. `f` returns the thread to
   * write, or `undefined` to leave it be, which `changed: false` reports.
   */
  updateCompletion(
    id: ThreadId,
    f: (thread: Thread) => Thread | undefined,
  ): Effect.Effect<{ readonly thread: Thread; readonly changed: boolean }, ThreadNotFound>;
  getCompletedReason(id: ThreadId): Effect.Effect<CompletedReason | undefined>;

  listQueue(threadId: ThreadId): Effect.Effect<ReadonlyArray<QueuedInput>>;
  /** Replaces the thread's persisted queue, in order. */
  putQueue(threadId: ThreadId, queue: ReadonlyArray<QueuedInput>): Effect.Effect<void>;
  /**
   * Deletes a thread with everything it owns, conversation included. An orchestrator's workspace
   * slot is emptied and its workers lose `spawnedBy` (they keep `workspaceId`); a worker's reports
   * go with it.
   */
  removeThread(id: ThreadId): Effect.Effect<void>;
  /**
   * Deletes a thread like `removeThread` and puts it on the closed list as of `closedAt`, with a copy
   * of its messages and turns for ⌘⇧T, in one transaction. The queue, requests and tasks don't
   * survive, nor does what `removeThread` undoes of its orchestration. Without a live row it does
   * nothing, so a second close can't empty the conversation the first one kept.
   */
  closeThread(id: ThreadId, closedAt: number): Effect.Effect<void>;
  /**
   * Puts back the messages and turns `closeThread` kept, once the thread row is in again. The
   * reports it filed as a worker stayed where they were, so they are its own again too.
   */
  restoreClosedHistory(id: ThreadId): Effect.Effect<void>;
  /**
   * The workers a closed orchestrator had when it closed, whose `spawnedBy` the close cut; empty
   * for any other thread, or once it left the closed list.
   */
  closedWorkers(id: ThreadId): Effect.Effect<ReadonlyArray<ClosedWorker>>;

  /** The last closed threads, newest first, at most `CLOSED_THREADS_LIMIT`. */
  listClosed: Effect.Effect<ReadonlyArray<ClosedThread>>;
  /**
   * Keeps `thread` as it was when closed, with the workers it had (`closedWorkers`) when given.
   * The oldest past the limit are dropped with the conversations `closeThread` kept for them.
   */
  rememberClosed(
    thread: Thread,
    closedAt: number,
    workers?: ReadonlyArray<ClosedWorker>,
  ): Effect.Effect<void>;
  forgetClosed(threadId: ThreadId): Effect.Effect<void>;
  /**
   * Takes the newest closed thread that reads off the list, with `closedWorkers`, in one
   * transaction, so two reopens at once take two entries, never the same one twice.
   */
  takeNewestClosed: Effect.Effect<
    { readonly closed: ClosedThread; readonly workers: ReadonlyArray<ClosedWorker> } | undefined
  >;

  listMessages(threadId: ThreadId): Effect.Effect<ReadonlyArray<GramUIMessage>>;
  /** The thread's user messages in order, without reading or decoding the replies between them. */
  listUserMessages(threadId: ThreadId): Effect.Effect<ReadonlyArray<GramUIMessage>>;
  /**
   * The thread's messages whose stored form holds any of `needles`, in order; only those messages
   * are decoded. For checking that a path was written in the conversation.
   */
  messagesWith(
    threadId: ThreadId,
    needles: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<GramUIMessage>>;
  /** The text parts of `messagesWith`'s messages, in order. */
  messageTextsWith(
    threadId: ThreadId,
    needles: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<string>>;
  /** The conversation `closeThread` kept for a closed thread; empty once it left the closed list. */
  listClosedMessages(threadId: ThreadId): Effect.Effect<ReadonlyArray<GramUIMessage>>;
  /**
   * Every message of a thread as a mark, in seq order, decoding no text. `closed` reads the copy
   * `closeThread` kept instead.
   */
  messageMarks(threadId: ThreadId, closed?: boolean): Effect.Effect<ReadonlyArray<MessageMark>>;
  /** A thread's messages from `fromSeq` on, in seq order, without those that don't decode. */
  listMessagesFrom(
    threadId: ThreadId,
    fromSeq: number,
    closed?: boolean,
  ): Effect.Effect<ReadonlyArray<SeqMessage>>;
  getMessage(threadId: ThreadId, messageId: string): Effect.Effect<GramUIMessage | undefined>;
  getMessageTurn(
    threadId: ThreadId,
    messageId: string,
  ): Effect.Effect<
    { readonly role: GramUIMessage["role"]; readonly turnId: TurnId | undefined } | undefined
  >;
  /** The message stored just before `messageId`, if any. */
  previousMessage(threadId: ThreadId, messageId: string): Effect.Effect<GramUIMessage | undefined>;
  /** One transaction: admission, history truncation, session reset and final provenance check.
   * The optional trusted checkpoint effect runs after admission, before SQL commit. */
  rewindThread(
    threadId: ThreadId,
    plan: HistoryRewind,
    restoreFiles?: Effect.Effect<void, GitError>,
  ): Effect.Effect<Thread, ThreadNotFound | InvalidState | GitError>;
  /** Deletes `messageId` and every message after it; returns how many went. */
  truncateMessagesFrom(threadId: ThreadId, messageId: string): Effect.Effect<number>;
  /** Deletes every message after `messageId`; returns how many went. */
  truncateMessagesAfter(threadId: ThreadId, messageId: string): Effect.Effect<number>;
  /** Deletes the one message, resetting the thread's feed; whether there was one. */
  deleteMessage(threadId: ThreadId, messageId: string): Effect.Effect<boolean>;
  /**
   * Deletes every message that shares an id with a queued item, which a send whose agent never got
   * it leaves, and resets those threads' feeds; returns how many went.
   */
  deleteQueuedMessages(): Effect.Effect<number>;
  /**
   * Inserts a message at the end of the thread, or replaces it in place. Returns the thread's feed
   * revision the write took. A `streaming` save leaves the message's search index row as it was,
   * for a later save, `refreshSearch` or the startup sweep to refresh (`messageSearchPending`).
   */
  upsertMessage(
    threadId: ThreadId,
    message: GramUIMessage,
    turnId?: TurnId,
    options?: { readonly streaming?: boolean },
  ): Effect.Effect<number>;
  /**
   * Brings the message's search index row up to its stored text, if a `streaming` save left it
   * behind. Writes nothing else, so the feed revision doesn't move. `false` when another
   * connection held the write lock past the busy timeout, for the caller to try again later.
   */
  refreshSearch(threadId: ThreadId, messageId: string): Effect.Effect<boolean>;
  /** `undefined` when there's no such thread. */
  feedRevision(threadId: ThreadId): Effect.Effect<FeedRevision | undefined>;
  /**
   * The messages written after feed revision `afterRev`, in thread order and from `fromId` on when
   * it's given, or `undefined` when there are more than `limit` of them or `fromId` isn't stored.
   */
  messagesSince(
    threadId: ThreadId,
    afterRev: number,
    limit: number,
    fromId?: string,
  ): Effect.Effect<ReadonlyArray<GramUIMessage> | undefined>;
  /**
   * The messages before `beforeId` (the newest without it), from the `turns`th user message back
   * on, and whether there are older ones. Empty when `beforeId` isn't stored.
   */
  recentMessages(
    threadId: ThreadId,
    turns: number,
    beforeId?: string,
  ): Effect.Effect<{
    readonly messages: ReadonlyArray<GramUIMessage>;
    readonly earlier: boolean;
  }>;
  /**
   * Copies `from`'s messages up to and including `upToMessageId` into `to` under new ids, keeping
   * their metadata. The copies aren't linked to `from`'s turns. Returns the copies.
   */
  copyMessages(
    from: ThreadId,
    to: ThreadId,
    upToMessageId: string,
  ): Effect.Effect<ReadonlyArray<GramUIMessage>>;

  startTurn(threadId: ThreadId, turnId: TurnId, startedAt: number): Effect.Effect<void>;
  endTurn(
    turnId: TurnId,
    end: { endedAt: number; reason: TurnEndReason; usage?: UsageSummary },
  ): Effect.Effect<void>;
  listTurns(threadId: ThreadId): Effect.Effect<ReadonlyArray<TurnRecord>>;
  /**
   * Ends every turn still open as `interrupted` at `endedAt` (or its start, if later) and returns
   * them. Only for boot, when no agent process is left to own one.
   */
  closeOpenTurns(endedAt: number): Effect.Effect<ReadonlyArray<TurnRecord>>;
  /** The usage of the latest ended turn that reported any; `undefined` without one. */
  lastTurnUsage(threadId: ThreadId): Effect.Effect<UsageSummary | undefined>;
  /**
   * The turn opened last, ended or not; `undefined` without one. By insertion, not `started_at`:
   * the wall clock can move back between two turns.
   */
  lastTurn(threadId: ThreadId): Effect.Effect<TurnRecord | undefined>;

  putRequest(threadId: ThreadId, request: PendingRequest, createdAt: number): Effect.Effect<void>;
  /** True when a row was removed. */
  removeRequest(threadId: ThreadId, requestId: RequestId): Effect.Effect<boolean>;
  listRequests(threadId: ThreadId): Effect.Effect<ReadonlyArray<PendingRequest>>;
  clearRequests(threadId?: ThreadId): Effect.Effect<void>;

  /** The thread's plan and todo list; both absent for a thread that has neither. */
  getPlan(threadId: ThreadId): Effect.Effect<ThreadPlanRecord>;
  /**
   * Rewrites the thread's plan record in one transaction and answers the new one; `f` answering
   * the same record writes nothing.
   */
  updatePlan(
    threadId: ThreadId,
    f: (record: ThreadPlanRecord) => ThreadPlanRecord,
  ): Effect.Effect<ThreadPlanRecord>;

  /** Every plain thread's pending wakes, soonest first. */
  listThreadWakes: Effect.Effect<ReadonlyArray<ThreadWake>>;
  /** Stores `wake` unless its thread has `max` pending already; answers whether it did. */
  addThreadWake(wake: ThreadWake, max: number): Effect.Effect<boolean>;
  /**
   * Keeps what a pending wake on a PR last saw of it, or the first event that fired it; nothing
   * for a wake that is gone or on no PR.
   */
  updateThreadWakePr(
    id: string,
    change: { readonly seen?: PrWatchSeen; readonly fired?: PrWakeFired },
  ): Effect.Effect<void>;
  /** Removes the thread's wake `id`, or with no `id` all of them, and answers those removed. */
  removeThreadWakes(
    threadId: ThreadId,
    id: string | undefined,
  ): Effect.Effect<ReadonlyArray<ThreadWake>>;

  putTask(threadId: ThreadId, messageId: string, task: TaskChipData): Effect.Effect<void>;
  getTask(threadId: ThreadId, taskId: TaskId): Effect.Effect<TaskRecord, NotFound>;

  /**
   * The thread's Waiting on you items, oldest first: the open ones, or with `all` the resolved ones
   * kept too. A row that doesn't decode is left out.
   */
  listWaits(threadId: ThreadId, which?: "open" | "all"): Effect.Effect<ReadonlyArray<WaitItem>>;
  /** The thread's items resolved at or after `since` (epoch ms), oldest first. */
  listResolvedWaits(threadId: ThreadId, since: number): Effect.Effect<ReadonlyArray<WaitItem>>;
  getWait(threadId: ThreadId, id: WaitId): Effect.Effect<WaitItem, NotFound>;
  /**
   * Adds an item, or replaces the one with its id. `toldAt` is when the agent learned of it as it
   * now is, the agent having written it; absent, the agent hasn't, and it is news (`listWaitNews`).
   */
  putWait(threadId: ThreadId, item: WaitItem, toldAt?: number): Effect.Effect<void>;
  /**
   * Resolves an item as `resolution` says, or with `undefined` reopens it, in one transaction, and
   * answers it as it then is. An item already resolved keeps its first resolution. The agent's own
   * resolution is no news to it, nor is reopening an item before it heard the item was done.
   */
  resolveWait(
    threadId: ThreadId,
    id: WaitId,
    resolution: WaitResolution | undefined,
  ): Effect.Effect<WaitItem, NotFound>;
  /**
   * The thread's items whose state the agent hasn't heard, oldest first: added by the user, resolved
   * by someone else since it last heard, or reopened after it heard they were done.
   */
  listWaitNews(threadId: ThreadId): Effect.Effect<ReadonlyArray<WaitItem>>;
  /**
   * Records that the agent heard of `items` at `at`, each as given. One resolved or reopened since
   * it was read is news again: what the agent heard of it is no longer so.
   */
  markWaitsTold(
    threadId: ThreadId,
    items: ReadonlyArray<WaitItem>,
    at: number,
  ): Effect.Effect<void>;

  getSettings: Effect.Effect<Settings>;
  putSettings(settings: Settings): Effect.Effect<void>;
  /**
   * Read-modify-write in one transaction; returns the stored settings. `touched` names the paths
   * `f` sets or clears, so a part the read couldn't decode is replaced only when `f` set it.
   */
  updateSettings(
    f: (settings: Settings) => Settings,
    touched?: ReadonlyArray<FieldPath>,
  ): Effect.Effect<Settings>;

  /**
   * The claude.ai connectors Claude threads last reported (`connectors/claude-ai-seen.ts`). An
   * entry this build can't read is left out, and dropped by the next write: it is only a cache of
   * what a thread said, which the next report puts back.
   */
  getSeenConnectors: Effect.Effect<ReadonlyArray<SeenConnector>>;
  /** Read-modify-write in one transaction; `f` answering `undefined` writes nothing. */
  updateSeenConnectors(
    f: (seen: ReadonlyArray<SeenConnector>) => ReadonlyArray<SeenConnector> | undefined,
  ): Effect.Effect<void>;

  listLabels: Effect.Effect<ReadonlyArray<Label>>;
  upsertLabel(label: Label): Effect.Effect<void>;
  removeLabel(id: LabelId): Effect.Effect<void, NotFound>;

  listPalettes: Effect.Effect<ReadonlyArray<Palette>>;
  upsertPalette(palette: Palette): Effect.Effect<void>;
  removePalette(id: PaletteId): Effect.Effect<void, NotFound>;

  listProfiles: Effect.Effect<ReadonlyArray<GatewayProfile>>;
  upsertProfile(profile: GatewayProfile): Effect.Effect<void>;
  removeProfile(id: ProfileId): Effect.Effect<void, NotFound>;

  /** Every workspace, oldest first. */
  listWorkspaces: Effect.Effect<ReadonlyArray<WorkspaceState>>;
  getWorkspace(id: WorkspaceId): Effect.Effect<WorkspaceState, NotFound>;
  /**
   * Inserts or replaces a workspace whole, slot included. To change one that may be claimed or
   * released meanwhile, use {@link ThreadStoreShape.updateWorkspace}.
   */
  putWorkspace(state: WorkspaceState): Effect.Effect<void>;
  /** Read-modify-write in one transaction; `f` must keep the workspace's id. */
  updateWorkspace(
    id: WorkspaceId,
    f: (state: WorkspaceState) => WorkspaceState,
  ): Effect.Effect<WorkspaceState, NotFound>;
  /**
   * Deletes a workspace with its reports, outbox, dreams and audit; refused while a thread that
   * still exists holds its slot, or is one of its dreams' threads.
   */
  removeWorkspace(id: WorkspaceId): Effect.Effect<void, NotFound | InvalidState>;
  /**
   * Makes `threadId` the workspace's orchestrator if nobody is, in one statement, so of two
   * concurrent claims one wins. A slot naming a thread that no longer exists counts as empty, and
   * the holder claiming again keeps it. False when another thread holds it, or when the workspace
   * or the claiming thread doesn't exist.
   */
  claimOrchestratorSlot(workspaceId: WorkspaceId, threadId: ThreadId): Effect.Effect<boolean>;
  /** Empties whichever slot `threadId` holds; nothing happens when it holds none. */
  releaseOrchestratorSlot(threadId: ThreadId): Effect.Effect<void>;

  /** Stores a worker's report and returns its sequence number. */
  addWorkerReport(workspaceId: WorkspaceId, report: WorkerReport): Effect.Effect<number>;
  /** A workspace's reports in order, after `afterSeq` when given. */
  listWorkerReports(
    workspaceId: WorkspaceId,
    afterSeq?: number,
  ): Effect.Effect<ReadonlyArray<WorkerReportRecord>>;
  /**
   * The latest report each of `threadIds` filed in the workspace, in that order, leaving out a
   * thread that filed none: found by index, however long the history.
   */
  latestWorkerReports(
    workspaceId: WorkspaceId,
    threadIds: ReadonlyArray<ThreadId>,
  ): Effect.Effect<ReadonlyArray<LatestWorkerReport>>;
  /** The sequence number of the workspace's latest report, 0 with none. */
  latestWorkerReportSeq(workspaceId: WorkspaceId): Effect.Effect<number>;

  /** The orchestration service's delivery state for a workspace, as the JSON it stored. */
  getOutbox(workspaceId: WorkspaceId): Effect.Effect<string | undefined>;
  /** Opaque here: the service owns the schema of what it stores. */
  putOutbox(workspaceId: WorkspaceId, json: string): Effect.Effect<void>;

  /** Appends to the workspace's audit and returns the entry's sequence number. */
  appendOrchestrationEvent(
    workspaceId: WorkspaceId,
    entry: OrchestrationEventEntry,
  ): Effect.Effect<number>;
  /**
   * A settings change by chat and its audit, in one transaction: `f` answers the settings to store,
   * or `undefined` when what it was approved against has moved, which writes nothing, audit
   * included. `touched` is as for `updateSettings`.
   */
  updateSettingsAudited(
    f: (settings: Settings) => Settings | undefined,
    touched: ReadonlyArray<FieldPath>,
    audit: SettingsAuditEntry,
  ): Effect.Effect<{ readonly settings: Settings; readonly auditSeq: number } | undefined>;
  /**
   * A workspace change by chat and its audit, in one transaction, with the workspace's own
   * `settings` orchestration event: as `updateSettingsAudited`, for a workspace.
   */
  updateWorkspaceAudited(
    id: WorkspaceId,
    f: (state: WorkspaceState) => WorkspaceState | undefined,
    audit: SettingsAuditEntry,
    /** Read against the app settings in the same transaction; `false` writes nothing. */
    holds?: (settings: Settings) => boolean,
  ): Effect.Effect<
    { readonly state: WorkspaceState; readonly auditSeq: number } | undefined,
    NotFound
  >;
  /**
   * A workspace made by chat and its audit, in one transaction, with the workspace's own `settings`
   * orchestration event.
   */
  putWorkspaceAudited(
    state: WorkspaceState,
    audit: SettingsAuditEntry,
  ): Effect.Effect<{ readonly auditSeq: number }>;
  /** The latest `limit` settings changes by chat, newest first. */
  listSettingsAudit(limit: number): Effect.Effect<ReadonlyArray<SettingsAuditRecord>>;
  /** The workspace's audit entries at or after `since` (epoch ms), oldest first. */
  listOrchestrationEvents(
    workspaceId: WorkspaceId,
    since: number,
  ): Effect.Effect<ReadonlyArray<OrchestrationEventRecord>>;

  /** The workspace's live feature cards, oldest first; a row that no longer decodes is left out. */
  listFeatureCards(workspaceId: WorkspaceId): Effect.Effect<ReadonlyArray<FeatureCard>>;
  /** Writes a card over the feature's previous one. */
  putFeatureCard(card: FeatureCard): Effect.Effect<void>;
  /**
   * Sets the helper's sentence on a card, only while the card is still at `summary.version`: a
   * summary of an older version never lands on a newer card. Whether it landed.
   */
  putFeatureCardSummary(
    workspaceId: WorkspaceId,
    feature: string,
    summary: FeatureCardSummary,
  ): Effect.Effect<boolean>;

  /**
   * A feature's rename, in one transaction: each worker `holder` spawned for `from` takes `to`, the
   * workspace becomes `workspace(current)`, `cards` are written over the rows they key, and the
   * outbox row becomes `outbox` when one is given. Answers the threads it rewrote.
   */
  renameFeature(input: {
    readonly workspaceId: WorkspaceId;
    readonly holder: ThreadId | undefined;
    readonly from: string;
    readonly to: string;
    readonly workspace: (state: WorkspaceState) => WorkspaceState;
    readonly cards: ReadonlyArray<FeatureCard>;
    readonly outbox: string | undefined;
  }): Effect.Effect<ReadonlyArray<Thread>, NotFound>;

  getAutomaticDreamState(workspaceId: WorkspaceId): Effect.Effect<AutomaticDreamState | undefined>;
  updateAutomaticDreamState(
    workspaceId: WorkspaceId,
    f: (state: AutomaticDreamState) => AutomaticDreamState,
  ): Effect.Effect<void>;

  /** Inserts or replaces a dream's row. */
  putDream(dream: Dream): Effect.Effect<void>;
  /**
   * Final Dream file access under the SQLite connection's transaction lock. Running/binding
   * checks made inside this effect cannot race cancel, close or rebind writes through the store.
   * Stage temp writes before entering; hold this only through the bounded final operation.
   */
  withDreamFileCommit<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E>;
  getDream(id: DreamId): Effect.Effect<Dream, NotFound>;
  /** A workspace's dreams, newest first. */
  listDreams(workspaceId: WorkspaceId): Effect.Effect<ReadonlyArray<Dream>>;
  /** Every dream still `running`, whatever its workspace: what a restart has to look at. */
  readonly listRunningDreams: Effect.Effect<ReadonlyArray<Dream>>;
  /** Deletes the row; one that isn't there is already deleted. The folder is `DreamFiles`'. */
  removeDream(id: DreamId): Effect.Effect<void>;

  /** How much of each thread a workspace's memory `version` has consolidated, unreadable rows left out. */
  listDreamWatermarks(
    workspaceId: WorkspaceId,
    version: string,
  ): Effect.Effect<ReadonlyArray<DreamWatermark>>;
  /** Makes `marks` the whole of `version`'s set, in one transaction. */
  putDreamWatermarks(
    workspaceId: WorkspaceId,
    version: string,
    marks: ReadonlyArray<DreamWatermark>,
  ): Effect.Effect<void>;
  /** Deletes the marks of `threadIds` from every version of the workspace, digests and all. */
  forgetDreamThreads(
    workspaceId: WorkspaceId,
    threadIds: ReadonlyArray<ThreadId>,
  ): Effect.Effect<void>;
  /** Deletes the marks of every version of the workspace but `keep`, the versions memory kept. */
  pruneDreamWatermarks(workspaceId: WorkspaceId, keep: ReadonlyArray<string>): Effect.Effect<void>;

  /** A thread's stashed drafts, newest first. */
  listStashes(threadId: ThreadId): Effect.Effect<ReadonlyArray<DraftStash>>;
  /** Stores `stash`; returns the thread's oldest stashes it dropped past `DRAFT_STASH_LIMIT`. */
  putStash(stash: DraftStash): Effect.Effect<ReadonlyArray<DraftStash>>;
  /** Deletes a stash and returns it. */
  takeStash(threadId: ThreadId, stashId: StashId): Effect.Effect<DraftStash, NotFound>;
}

/** A thread wake's `pr` column: the PR it waits on, its events, and what it saw when set. */
const ThreadWakePr = Schema.Struct({
  onPr: ThreadWake.fields.onPr,
  on: ThreadWake.fields.on,
  seen: ThreadWake.fields.seen,
  fired: ThreadWake.fields.fired,
});

const toJson = <S extends Schema.Top>(schema: S, value: S["Type"]): string =>
  JSON.stringify(Schema.encodeSync(schema as unknown as Schema.Codec<S["Type"], unknown>)(value));

const ENCODED_DEFAULT_SETTINGS = Schema.encodeSync(Settings)(DEFAULT_SETTINGS);

const bool = (n: number | bigint | null | undefined) => Number(n ?? 0) !== 0;

/**
 * The connection's commits stop waiting for the disk. Every query runs on the event loop, and in
 * WAL mode `FULL` syncs the log on each commit, which a streaming reply makes several times a
 * second; `NORMAL` syncs at checkpoints only. The database can't be corrupted either way: what
 * `NORMAL` can lose is the last commits before the OS itself crashes or loses power.
 */
const NormalSync = Layer.effectDiscard(
  Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) => sql`PRAGMA synchronous = NORMAL`),
);

/**
 * SQLite's page cache, per connection: 16 MiB, up from its 2 MB default (~500 pages). One 380 KB
 * reply is ~95 pages, and an open transcript's window of turns several hundred, so the default holds
 * barely one thread's; the rest is read back from the OS on every page and resume. It grows only as
 * pages are read, and 16 MiB is a tenth of the server's resident memory.
 */
const CACHE_SIZE_KIB = 16_384;

/**
 * Reads of the database file's first 64 MiB map the OS page cache instead of copying it into the
 * process: the same pages, read without a syscall each. Writes, and pages still in the WAL, go
 * through the usual calls. Kept small: a mapped page counts in resident memory while mapped, and an
 * I/O error on one would end the process rather than fail its query, which only a local disk makes
 * rare enough. A build without memory-mapped I/O ignores it.
 */
const MMAP_SIZE_BYTES = 64 * 1024 * 1024;

const PageCache = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`PRAGMA cache_size = -${CACHE_SIZE_KIB}`);
    yield* sql.unsafe(`PRAGMA mmap_size = ${MMAP_SIZE_BYTES}`);
  }),
);

/** A broken database is a defect, not something callers can handle. */
const run = <A, E, R>(
  effect: Effect.Effect<A, E | SqlError, R>,
): Effect.Effect<A, Exclude<E, SqlError>, R> =>
  effect.pipe(
    Effect.catch((e) =>
      e instanceof SqlError ? Effect.die(e) : Effect.fail(e as Exclude<E, SqlError>),
    ),
  );

export class ThreadStore extends Context.Service<ThreadStore, ThreadStoreShape>()(
  "@gram/server/ThreadStore",
) {
  static readonly layerNoDeps: Layer.Layer<ThreadStore, never, SqlClient.SqlClient> = Layer.effect(
    ThreadStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const unreadable = makeUnreadableLog();
      // Every public method is one statement or one top-level transaction; nothing nests.
      const tx = <A, E, R>(effect: Effect.Effect<A, E, R>) => run(sql.withTransaction(effect));

      /** A settings-by-chat audit row, and a workspace's own `settings` event; inside a `tx`. */
      const insertSettingsAudit = (entry: SettingsAuditEntry) =>
        Effect.gen(function* () {
          const [row] = yield* sql<{ seq: number }>`INSERT INTO settings_audit (at, thread_id,
              proposer_role, scope, workspace_id, request_id, approved_by, approved_at, changes,
              shown, reason, project_id)
            VALUES (${entry.at}, ${entry.threadId}, ${entry.proposerRole}, ${entry.scope},
              ${entry.workspaceId ?? null}, ${entry.requestId ?? null}, ${entry.approvedBy},
              ${entry.approvedAt}, ${JSON.stringify(entry.changes)}, ${JSON.stringify(entry.shown)},
              ${entry.reason ?? null}, ${entry.projectId ?? null})
            RETURNING seq`;
          const auditSeq = Number(row!.seq);
          if (entry.workspaceId !== undefined) {
            yield* sql`INSERT INTO orchestration_events (workspace_id, at, kind, data)
              VALUES (${entry.workspaceId}, ${entry.at}, ${"settings"}, ${JSON.stringify({
                by: entry.threadId,
                role: entry.proposerRole,
                approvedBy: entry.approvedBy,
                requestId: entry.requestId,
                changes: entry.changes,
                auditSeq,
              })})`;
          }
          return auditSeq;
        });

      /** The conversation `closeThread` kept for a thread. */
      const purgeHistory = (id: string) =>
        Effect.gen(function* () {
          yield* sql`DELETE FROM closed_messages WHERE thread_id = ${id}`;
          yield* sql`DELETE FROM closed_turns WHERE thread_id = ${id}`;
          yield* sql`DELETE FROM worker_reports WHERE thread_id = ${id}
            AND thread_id NOT IN (SELECT id FROM threads)`;
          yield* sql`DELETE FROM thread_plans WHERE thread_id = ${id}
            AND thread_id NOT IN (SELECT id FROM threads)`;
        });

      /** Puts a thread on the closed list, dropping the oldest past the limit with what was kept. */
      const keepClosed = (
        id: string,
        closedAt: number,
        data: string,
        workers: ReadonlyArray<ClosedWorker> = [],
      ) =>
        Effect.gen(function* () {
          yield* sql`INSERT INTO closed_threads (thread_id, closed_at, data, workers)
            VALUES (${id}, ${closedAt}, ${data},
              ${workers.length === 0 ? null : toJson(ClosedWorkers, workers)})
            ON CONFLICT (thread_id) DO UPDATE SET closed_at = excluded.closed_at,
              workers = excluded.workers, data = excluded.data`;
          const evicted = yield* sql<{ thread_id: string }>`SELECT thread_id FROM closed_threads
            ORDER BY closed_at DESC, rowid DESC LIMIT -1 OFFSET ${CLOSED_THREADS_LIMIT}`;
          for (const { thread_id: evictedId } of evicted) {
            yield* sql`DELETE FROM closed_threads WHERE thread_id = ${evictedId}`;
            yield* purgeHistory(evictedId);
          }
        });

      // Conversations kept for closed threads that left the list without coming back (a reopen that
      // found its folder gone): nothing can reach them any more.
      yield* tx(
        Effect.gen(function* () {
          yield* sql`DELETE FROM closed_messages
            WHERE thread_id NOT IN (SELECT thread_id FROM closed_threads)`;
          yield* sql`DELETE FROM closed_turns
            WHERE thread_id NOT IN (SELECT thread_id FROM closed_threads)`;
          yield* sql`DELETE FROM worker_reports
            WHERE thread_id NOT IN (SELECT id FROM threads)
              AND thread_id NOT IN (SELECT thread_id FROM closed_threads)`;
          yield* sql`DELETE FROM thread_plans
            WHERE thread_id NOT IN (SELECT id FROM threads)
              AND thread_id NOT IN (SELECT thread_id FROM closed_threads)`;
          yield* sql`DELETE FROM wait_items
            WHERE resolved_at < ${Date.now() - RESOLVED_WAITS_KEPT_MS}`;
        }),
      );
      yield* pruneHistory(sql, Date.now());

      /** A thread's messages in the order given, without those that don't decode. */
      const messageRows = (
        table: "messages" | "closed_messages",
        threadId: string,
        rows: ReadonlyArray<{ readonly id: string; readonly message: string }>,
      ) =>
        readableRows(
          unreadable,
          table,
          rows,
          (r) => `${threadId}/${r.id}`,
          (r) => decodeStored(UIMessageSchema, r.message),
        );

      const readWait = (threadId: ThreadId, id: WaitId) =>
        sql<{ item: string }>`SELECT item FROM wait_items
          WHERE thread_id = ${threadId} AND id = ${id}`.pipe(
          Effect.flatMap((rows) =>
            rows[0] === undefined
              ? Effect.succeed(undefined)
              : readableRow(
                  unreadable,
                  "wait_items",
                  `${threadId}/${id}`,
                  decodeStored(WaitItem, rows[0].item),
                ),
          ),
          Effect.flatMap((item) =>
            item === undefined
              ? Effect.fail(new NotFound({ entity: "wait", id }))
              : Effect.succeed(item),
          ),
        );

      /** `toldAt`: `null` for news to the agent, `undefined` to leave what was stored. */
      const writeWait = (threadId: ThreadId, item: WaitItem, toldAt: number | null | undefined) =>
        (toldAt === undefined
          ? sql`INSERT INTO wait_items (thread_id, id, message_id, created_at, resolved_at, item)
              VALUES (${threadId}, ${item.id}, ${item.messageId ?? null}, ${item.createdAt},
                ${item.resolvedAt ?? null}, ${toJson(WaitItem, item)})
              ON CONFLICT (thread_id, id) DO UPDATE SET message_id = excluded.message_id,
                resolved_at = excluded.resolved_at, item = excluded.item`
          : sql`INSERT INTO wait_items
                (thread_id, id, message_id, created_at, resolved_at, told_at, item)
              VALUES (${threadId}, ${item.id}, ${item.messageId ?? null}, ${item.createdAt},
                ${item.resolvedAt ?? null}, ${toldAt}, ${toJson(WaitItem, item)})
              ON CONFLICT (thread_id, id) DO UPDATE SET message_id = excluded.message_id,
                resolved_at = excluded.resolved_at, told_at = excluded.told_at,
                item = excluded.item`
        ).pipe(Effect.asVoid);

      const toldAtOf = (threadId: ThreadId, id: WaitId) =>
        sql<{ told_at: number | null }>`SELECT told_at FROM wait_items
          WHERE thread_id = ${threadId} AND id = ${id}`.pipe(
          Effect.map((rows) => rows[0]?.told_at ?? null),
        );

      /** The plan record, with the stored text of a column that doesn't decode, to write back. */
      const readPlan = (threadId: string) =>
        Effect.gen(function* () {
          const [row] = yield* sql<{ plan: string | null; turn_plan: string | null }>`
            SELECT plan, turn_plan FROM thread_plans WHERE thread_id = ${threadId}`;
          const plan = row?.plan == null ? undefined : decodeStored(ThreadPlan, row.plan);
          const turnPlan =
            row?.turn_plan == null ? undefined : decodeStored(TurnPlanJson, row.turn_plan);
          const record: ThreadPlanRecord = {
            plan:
              plan === undefined
                ? undefined
                : yield* readableRow(unreadable, "thread_plans.plan", threadId, plan),
            turnPlan:
              turnPlan === undefined
                ? undefined
                : yield* readableRow(unreadable, "thread_plans.turn_plan", threadId, turnPlan),
          };
          return {
            record,
            unreadPlan: plan?.ok === false ? row!.plan! : undefined,
            unreadTurnPlan: turnPlan?.ok === false ? row!.turn_plan! : undefined,
          };
        });

      interface WakeRow {
        id: string;
        thread_id: string;
        at: number;
        set_at: number;
        note: string;
        pr: string | null;
      }
      const wakeRows = (rows: ReadonlyArray<WakeRow>) =>
        readableRows(
          unreadable,
          "thread_wakes",
          rows,
          (r) => r.id,
          (r) => {
            const pr = r.pr === null ? undefined : decodeStored(ThreadWakePr, r.pr);
            if (pr !== undefined && !pr.ok) return pr;
            return decodeStored(
              ThreadWake,
              JSON.stringify({
                id: r.id,
                threadId: r.thread_id,
                at: Number(r.at),
                setAt: Number(r.set_at),
                note: r.note,
                ...pr?.value,
              }),
            );
          },
        );

      interface ProjectRow {
        id: string;
        root: string;
        name: string;
        repo_root: string | null;
        bookmarked: number;
        last_opened_at: number | null;
        local_check?: string | null;
      }
      const toProject = (r: ProjectRow): Project => {
        // A recipe with a key this build doesn't know is unreadable, never a check without it: the
        // gate then reads unavailable rather than off.
        const decoded =
          r.local_check == null
            ? undefined
            : decodeStored(ProjectLocalCheck, r.local_check, { onExcessProperty: "error" });
        return Schema.decodeUnknownSync(Project)({
          id: r.id,
          root: r.root,
          name: r.name,
          ...(r.repo_root === null ? {} : { repoRoot: r.repo_root }),
          ...(decoded?.ok ? { localCheck: decoded.value } : {}),
          localCheckRevision: createHash("sha256")
            .update(JSON.stringify([r.local_check ?? null]))
            .digest("hex"),
          ...(decoded !== undefined && !decoded.ok
            ? {
                localCheckUnavailable:
                  "Stored local-check configuration is unreadable; local evidence is unavailable until approved repair.",
              }
            : {}),
          bookmarked: bool(r.bookmarked),
          ...(r.last_opened_at === null ? {} : { lastOpenedAt: Number(r.last_opened_at) }),
        });
      };

      /** The row whose root is the folder `root` names, however either of them is spelled. */
      const projectAt = (root: string) =>
        sql<ProjectRow>`SELECT * FROM projects`.pipe(
          Effect.map((rows) => {
            const key = projectRootKey(root);
            return rows.find((row) => projectRootKey(row.root) === key);
          }),
        );

      const registerProject: ThreadStoreShape["registerProject"] = (input) =>
        tx(
          Effect.gen(function* () {
            const root = projectRoot(input.root);
            const { name } = input;
            const repoRoot = input.repoRoot === undefined ? undefined : projectRoot(input.repoRoot);
            const row = yield* projectAt(root);
            if (row !== undefined) return { project: toProject(row), created: false };
            const id = Schema.decodeSync(ProjectId)(randomUUID());
            yield* sql`INSERT INTO projects (id, root, name, repo_root, bookmarked)
              VALUES (${id}, ${root}, ${name}, ${repoRoot ?? null}, 0)`;
            const project = toProject({
              id,
              root,
              name,
              repo_root: repoRoot ?? null,
              bookmarked: 0,
              last_opened_at: null,
            });
            return { project, created: true };
          }),
        );

      const ensureProject: ThreadStoreShape["ensureProject"] = (input) =>
        registerProject(input).pipe(Effect.map(({ project }) => project));

      const listProjects = run(
        sql<ProjectRow>`SELECT * FROM projects ORDER BY name`.pipe(
          Effect.map((rows) => rows.map(toProject)),
        ),
      );

      const setProjectBookmarked: ThreadStoreShape["setProjectBookmarked"] = (id, bookmarked) =>
        tx(
          Effect.gen(function* () {
            yield* sql`UPDATE projects SET bookmarked = ${bookmarked ? 1 : 0} WHERE id = ${id}`;
            const row = (yield* sql<ProjectRow>`SELECT * FROM projects WHERE id = ${id}`)[0];
            if (row === undefined) {
              return yield* new NotFound({
                entity: "project",
                id,
                message: "That project no longer exists.",
              });
            }
            return toProject(row);
          }),
        );

      const forgetProject: ThreadStoreShape["forgetProject"] = (id) =>
        tx(
          Effect.gen(function* () {
            const row = (yield* sql<ProjectRow>`SELECT * FROM projects WHERE id = ${id}`)[0];
            if (row === undefined) {
              return yield* new NotFound({
                entity: "project",
                id,
                message: "That project no longer exists.",
              });
            }
            const [threads] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM threads
              WHERE project_id = ${id}`;
            if (Number(threads?.count ?? 0) > 0) {
              return yield* new InvalidState({
                message: `Close the threads in ${row.name} before removing it from recents.`,
              });
            }
            yield* sql`DELETE FROM projects WHERE id = ${id}`;
          }),
        );

      const writeThread = (thread: Thread) =>
        Effect.gen(function* () {
          if (thread.labels.length > 1)
            return yield* Effect.die(new Error(`thread ${thread.id} has more than one label`));
          yield* sql`INSERT INTO threads
            (id, project_id, agent_session_id, pinned, parked, created_at, last_activity_at, data)
          VALUES (${thread.id}, ${thread.projectId}, ${thread.agentSessionId ?? null},
            ${thread.pinned ? 1 : 0}, ${thread.parked ? 1 : 0}, ${thread.createdAt},
            ${thread.lastActivityAt}, ${toJson(Thread, thread)})
          ON CONFLICT (id) DO UPDATE SET
            agent_session_id = excluded.agent_session_id,
            pinned = excluded.pinned,
            parked = excluded.parked,
            last_activity_at = excluded.last_activity_at,
            data = excluded.data`;
        });

      /**
       * `listThreads`' last result and the `threads_version` token it was read under. Every caller
       * shares the decoded threads, which nothing mutates: they are read-only values.
       */
      let listedThreads: { token: string; threads: ReadonlyArray<Thread> } | undefined;

      /** A row that doesn't decode is a thread this build can't open, so it isn't found. */
      const readThread = (id: ThreadId) =>
        sql<{ data: string }>`SELECT data FROM threads WHERE id = ${id}`.pipe(
          Effect.flatMap((rows) =>
            rows[0] === undefined
              ? Effect.succeed(undefined)
              : readableRow(unreadable, "threads", id, decodeStored(Thread, rows[0].data)),
          ),
          Effect.flatMap((thread) =>
            thread === undefined
              ? Effect.fail(new ThreadNotFound({ threadId: id }))
              : Effect.succeed(thread),
          ),
        );

      const updateThread: ThreadStoreShape["updateThread"] = (id, f, authorityCaller) =>
        tx(
          Effect.gen(function* () {
            // The one door every thread edit takes, so the one-row-per-PR invariant holds whoever
            // wrote `boundPr`.
            const thread = yield* readThread(id);
            const context =
              authorityCaller === undefined
                ? undefined
                : yield* readThreadAuthority(thread, authorityCaller);
            const next = normalizeThreadPrs(f(thread, context));
            yield* writeThread(next);
            return next;
          }),
        );

      /**
       * Takes the next feed revision for a write to `threadId`'s messages, inside the write's
       * transaction; `reset` when the write removed or replaced some, which no resume can express.
       */
      const takeRev = (threadId: string, reset = false) =>
        Effect.gen(function* () {
          const [row] = yield* sql<{ rev: number }>`UPDATE feed_revision SET rev = rev + 1
            WHERE id = 0 RETURNING rev`;
          const rev = Number(row!.rev);
          yield* reset
            ? sql`UPDATE threads SET feed_rev = ${rev}, feed_reset_rev = ${rev}
                WHERE id = ${threadId}`
            : sql`UPDATE threads SET feed_rev = ${rev} WHERE id = ${threadId}`;
          return rev;
        });

      const truncateMessages = (threadId: ThreadId, messageId: string, inclusive: boolean) =>
        Effect.gen(function* () {
          const [target] = yield* sql<{ seq: number }>`SELECT seq FROM messages
            WHERE thread_id = ${threadId} AND id = ${messageId}`;
          if (target === undefined) return 0;
          const removed = inclusive
            ? yield* sql<{
                id: string;
              }>`DELETE FROM messages WHERE thread_id=${threadId} AND seq >= ${target.seq} RETURNING id`
            : yield* sql<{
                id: string;
              }>`DELETE FROM messages WHERE thread_id=${threadId} AND seq > ${target.seq} RETURNING id`;
          yield* takeRev(threadId, true);
          return removed.length;
        });

      const upsertMessage: ThreadStoreShape["upsertMessage"] = (
        threadId,
        message,
        turnId,
        options,
      ) =>
        tx(
          Effect.gen(function* () {
            const rev = yield* takeRev(threadId);
            // The revision marks a streaming save: unique, so the search triggers see it move.
            const pending = options?.streaming === true ? rev : null;
            yield* sql`INSERT INTO messages
                (thread_id, id, seq, role, turn_id, message, rev, search_pending)
              VALUES (${threadId}, ${message.id},
                (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE thread_id = ${threadId}),
                ${message.role}, ${turnId ?? null}, ${JSON.stringify(message)}, ${rev}, ${pending})
              ON CONFLICT (thread_id, id) DO UPDATE SET
                message = excluded.message,
                turn_id = COALESCE(excluded.turn_id, messages.turn_id),
                rev = excluded.rev,
                search_pending = excluded.search_pending`;
            return rev;
          }),
        );

      interface TurnRow {
        id: string;
        thread_id: string;
        started_at: number;
        ended_at: number | null;
        reason: string | null;
      }

      const entityStore = <S extends Schema.Top & { Type: { id: string } }>(
        table: "labels" | "palettes" | "profiles",
        entity: NotFound["entity"],
        schema: S,
      ) => ({
        list: run(
          sql<{ id: string; data: string }>`SELECT id, data FROM ${sql(table)} ORDER BY rowid`.pipe(
            Effect.flatMap((rows) =>
              readableRows(
                unreadable,
                table,
                rows,
                (r) => r.id,
                (r) => decodeStored(schema, r.data),
              ),
            ),
          ),
        ),
        upsert: (value: S["Type"]) =>
          run(
            sql`INSERT INTO ${sql(table)} (id, data) VALUES (${value.id}, ${toJson(schema, value)})
              ON CONFLICT (id) DO UPDATE SET data = excluded.data`,
          ),
        remove: (id: string) =>
          tx(
            Effect.gen(function* () {
              const rows = yield* sql<{
                id: string;
              }>`SELECT id FROM ${sql(table)} WHERE id = ${id}`;
              if (rows.length === 0) return yield* new NotFound({ entity, id });
              yield* sql`DELETE FROM ${sql(table)} WHERE id = ${id}`;
            }),
          ),
      });
      const labels = entityStore("labels", "label", Label);
      const palettes = entityStore("palettes", "palette", Palette);
      const profiles = entityStore("profiles", "profile", GatewayProfile);

      const storedSettings = sql<{
        value: string;
      }>`SELECT value FROM settings WHERE key = 'app'`.pipe(Effect.map((rows) => rows[0]?.value));
      /** Field by field: a part that doesn't decode reads as its default, and the rest is kept. */
      const readSettings = Effect.gen(function* () {
        const stored = yield* storedSettings;
        if (stored === undefined) return DEFAULT_SETTINGS;
        const { value, mended } = decodeMended(
          Settings,
          DEFAULT_SETTINGS,
          ENCODED_DEFAULT_SETTINGS,
          stored,
        );
        if (mended.length > 0) yield* unreadable("settings", "app", mended);
        return value;
      });
      /**
       * Writes `settings` over the stored row, keeping what the read couldn't decode wherever the
       * caller didn't set it (`touched`, or without it, wherever `settings` still has the default
       * read in its place), and the keys this build doesn't know. A row with nothing to keep is set
       * aside under its own key before it is replaced.
       */
      const writeSettings = (settings: Settings, touched?: ReadonlyArray<FieldPath>) =>
        Effect.gen(function* () {
          const stored = yield* storedSettings;
          const { json, replacesUnreadable } = mendedWrite(
            Settings,
            DEFAULT_SETTINGS,
            ENCODED_DEFAULT_SETTINGS,
            stored,
            Schema.encodeSync(Settings)(settings),
            touched,
          );
          if (replacesUnreadable) {
            const at = yield* Clock.currentTimeMillis;
            yield* sql`INSERT OR REPLACE INTO settings (key, value)
              VALUES (${`app.unreadable.${at}`}, ${stored!})`;
            yield* Effect.logWarning("stored row set aside").pipe(
              Effect.annotateLogs({
                table: "settings",
                key: "app",
                setAsideAs: `app.unreadable.${at}`,
              }),
            );
          }
          yield* sql`INSERT INTO settings (key, value) VALUES ('app', ${JSON.stringify(json)})
            ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
        });

      /** Beside the settings, in the same table under its own key: it isn't one of them. */
      const SEEN_CONNECTORS_KEY = "claudeai.connectors";
      const readSeenConnectors = Effect.gen(function* () {
        const rows = yield* sql<{
          value: string;
        }>`SELECT value FROM settings WHERE key = ${SEEN_CONNECTORS_KEY}`;
        const stored = rows[0]?.value;
        if (stored === undefined) return [];
        const list = yield* readableRow(
          unreadable,
          "settings",
          SEEN_CONNECTORS_KEY,
          decodeStored(Schema.Array(Schema.Unknown), stored),
        );
        return yield* readableRows(
          unreadable,
          "settings",
          (list ?? []).map((value, index) => ({ value, index })),
          ({ index }) => `${SEEN_CONNECTORS_KEY}[${index}]`,
          ({ value }) => decodeStoredValue(SeenConnector, value),
        );
      });

      const updateCompletion: ThreadStoreShape["updateCompletion"] = (id, f) =>
        tx(
          Effect.gen(function* () {
            const current = yield* readThread(id);
            const next = f(current);
            if (next === undefined) return { thread: current, changed: false };
            yield* writeThread(next);
            yield* sql`UPDATE threads SET completed_reason = ${next.completedReason ?? null}
              WHERE id = ${id}`;
            return { thread: next, changed: true };
          }),
        );

      const setCompletion: ThreadStoreShape["setCompletion"] = (id, completion) =>
        updateCompletion(id, (thread) => {
          const { completedAt, completedReason, ...rest } = thread;
          void completedAt;
          void completedReason;
          return completion === undefined
            ? rest
            : { ...rest, completedAt: completion.at, completedReason: completion.reason };
        }).pipe(Effect.map(({ thread }) => thread));

      /**
       * What a thread leaves behind in orchestration when it goes: the slot it held (column and
       * JSON), its workers' link to it, the reports it filed unless `keepReports` (a close, whose
       * reopen makes them its own again), and the link from a dream that ran as it. The dream's row
       * stays, since its output is still there to review or discard. Runs inside the caller's
       * transaction.
       */
      // SQLite's JSON functions raise on text that isn't JSON, so each is behind `json_valid`, and a
      // row that doesn't parse is left as it is rather than failing the statement for every row.
      const unlinkOrchestration = (id: ThreadId, keepReports = false) =>
        Effect.gen(function* () {
          yield* sql`UPDATE workspaces SET orchestrator_thread_id = NULL,
              data = CASE WHEN json_valid(data)
                THEN json_remove(data, '$.workspace.orchestratorThreadId') ELSE data END
            WHERE orchestrator_thread_id = ${id}`;
          yield* sql`UPDATE threads SET data = json_remove(data, '$.spawnedBy')
            WHERE CASE WHEN json_valid(data)
              THEN json_extract(data, '$.spawnedBy.threadId') = ${id} ELSE 0 END`;
          if (!keepReports) yield* sql`DELETE FROM worker_reports WHERE thread_id = ${id}`;
          yield* sql`UPDATE dreams SET thread_id = NULL,
              data = CASE WHEN json_valid(data) THEN json_remove(data, '$.threadId') ELSE data END
            WHERE thread_id = ${id}`;
        });

      const readAutomaticDreamState = (id: WorkspaceId) =>
        sql<{ data: string }>`SELECT data FROM automatic_dream WHERE workspace_id = ${id}`.pipe(
          Effect.map((rows) =>
            rows[0] === undefined
              ? undefined
              : Schema.decodeUnknownSync(Schema.fromJsonString(AutomaticDreamState))(rows[0].data),
          ),
        );
      const writeAutomaticDreamState = (id: WorkspaceId, state: AutomaticDreamState) =>
        sql`INSERT INTO automatic_dream (workspace_id, data) VALUES (${id}, ${toJson(AutomaticDreamState, state)})
          ON CONFLICT (workspace_id) DO UPDATE SET data = excluded.data`;

      const writeWorkspace = (state: WorkspaceState) =>
        Effect.gen(function* () {
          const id = state.workspace.id;
          const threshold = state.charter.automaticDreamThreshold;
          const previous = yield* readAutomaticDreamState(id);
          if (threshold === undefined) {
            yield* sql`DELETE FROM automatic_dream WHERE workspace_id = ${id}`;
          } else if (previous?.threshold !== threshold) {
            const rows = yield* sql<{
              data: string;
            }>`SELECT data FROM threads UNION ALL SELECT data FROM closed_threads`;
            const threads = rows.flatMap((row) => {
              const decoded = decodeStored(Thread, row.data);
              return decoded.ok ? [decoded.value] : [];
            });
            // Associate only a currently running owning-workspace run with the new
            // count epoch. Completed history must never become an enable/edit trigger.
            const dreamRows = yield* sql<{
              data: string;
            }>`SELECT data FROM dreams WHERE workspace_id = ${id}`;
            const runningDreams = dreamRows.flatMap((row) => {
              const decoded = decodeStored(Dream, row.data);
              return decoded.ok &&
                decoded.value.workspaceId === id &&
                decoded.value.status === "running"
                ? [decoded.value]
                : [];
            });
            yield* writeAutomaticDreamState(id, {
              ...completionBaseline(
                threshold,
                threads,
                state,
                yield* Clock.currentTimeMillis,
                previous,
              ),
              ...(runningDreams.length === 1 ? { observedDreamId: runningDreams[0]!.id } : {}),
            });
          }
          yield* sql`INSERT INTO workspaces (id, orchestrator_thread_id, created_at, data)
          VALUES (${id}, ${state.workspace.orchestratorThreadId ?? null},
            ${state.workspace.createdAt}, ${toJson(WorkspaceState, state)})
          ON CONFLICT (id) DO UPDATE SET
            orchestrator_thread_id = excluded.orchestrator_thread_id,
            data = excluded.data`;
        });

      /** As with threads, a row that doesn't decode is a workspace that isn't found. */
      const readWorkspace = (id: WorkspaceId) =>
        sql<{ data: string }>`SELECT data FROM workspaces WHERE id = ${id}`.pipe(
          Effect.flatMap((rows) =>
            rows[0] === undefined
              ? Effect.succeed(undefined)
              : readableRow(
                  unreadable,
                  "workspaces",
                  id,
                  decodeStored(WorkspaceState, rows[0].data),
                ),
          ),
          Effect.flatMap((state) =>
            state === undefined
              ? Effect.fail(
                  new NotFound({
                    entity: "workspace",
                    id,
                    message: "That workspace no longer exists.",
                  }),
                )
              : Effect.succeed(state),
          ),
        );

      const readThreadAuthority = (thread: Thread, callerId: ThreadId) =>
        Effect.gen(function* () {
          return {
            caller: yield* readThread(callerId).pipe(Effect.orElseSucceed(() => undefined)),
            workspace:
              thread.workspaceId === undefined
                ? undefined
                : yield* readWorkspace(thread.workspaceId).pipe(
                    Effect.orElseSucceed(() => undefined),
                  ),
            settings: yield* readSettings,
          };
        });

      const messagesWith: ThreadStoreShape["messagesWith"] = (threadId, needles) =>
        run(
          Effect.forEach(
            // As `upsertMessage` stored it: a needle's quotes and backslashes are escaped there.
            [...new Set(needles.map((needle) => JSON.stringify(needle).slice(1, -1)))],
            (needle) =>
              sql<{ seq: number; id: string; message: string }>`SELECT seq, id, message
                FROM messages WHERE thread_id = ${threadId} AND instr(message, ${needle}) > 0`,
          ).pipe(
            Effect.map((batches) => {
              const bySeq = new Map(batches.flat().map((row) => [row.seq, row]));
              return [...bySeq.values()].toSorted((a, b) => a.seq - b.seq);
            }),
            Effect.flatMap((rows) => messageRows("messages", threadId, rows)),
          ),
        );

      return ThreadStore.of({
        setCompletion,
        updateCompletion,
        listQueue: (threadId) =>
          run(
            sql<{
              id: string;
              input: string;
              notice_key: string | null;
              turn_id: string | null;
            }>`SELECT id, input, notice_key, turn_id FROM queue_items
              WHERE thread_id = ${threadId} ORDER BY position`.pipe(
              Effect.flatMap((rows) =>
                readableRows(
                  unreadable,
                  "queue_items",
                  rows,
                  (r) => `${threadId}/${r.id}`,
                  (r) =>
                    mapDecoded(decodeStored(UserInput, r.input), (input): QueuedInput => ({
                      id: r.id as QueueItemId,
                      input,
                      ...(r.notice_key === null ? {} : { noticeKey: r.notice_key }),
                      ...(r.turn_id === null ? {} : { turnId: r.turn_id as TurnId }),
                    })),
                ),
              ),
            ),
          ),
        putQueue: (threadId, queue) =>
          tx(
            Effect.gen(function* () {
              // `listQueue` left out the items that don't decode, so they stay as they are.
              const stored = yield* sql<{ id: string; input: string }>`SELECT id, input
                FROM queue_items WHERE thread_id = ${threadId}`;
              for (const row of stored) {
                if (!decodeStored(UserInput, row.input).ok) continue;
                yield* sql`DELETE FROM queue_items WHERE thread_id = ${threadId} AND id = ${row.id}`;
              }
              for (const [position, item] of queue.entries()) {
                yield* sql`INSERT OR REPLACE INTO queue_items
                  (thread_id, id, position, input, notice_key, turn_id)
                  VALUES (${threadId}, ${item.id}, ${position}, ${toJson(UserInput, item.input)},
                    ${item.noticeKey ?? null}, ${item.turnId ?? null})`;
              }
            }),
          ),
        getMessage: (threadId, messageId) =>
          run(
            sql<{ message: string }>`SELECT message FROM messages
              WHERE thread_id = ${threadId} AND id = ${messageId}`.pipe(
              Effect.flatMap((rows) =>
                rows[0] === undefined
                  ? Effect.succeed(undefined)
                  : readableRow(
                      unreadable,
                      "messages",
                      `${threadId}/${messageId}`,
                      decodeStored(UIMessageSchema, rows[0].message),
                    ),
              ),
            ),
          ),
        getMessageTurn: (threadId, messageId) =>
          run(
            sql<{ role: string; turn_id: string | null }>`SELECT role, turn_id FROM messages
              WHERE thread_id = ${threadId} AND id = ${messageId}`.pipe(
              Effect.map((rows) =>
                rows[0] === undefined
                  ? undefined
                  : {
                      role: rows[0].role as GramUIMessage["role"],
                      turnId: (rows[0].turn_id ?? undefined) as TurnId | undefined,
                    },
              ),
            ),
          ),
        previousMessage: (threadId, messageId) =>
          run(
            sql<{ id: string; message: string }>`SELECT id, message FROM messages
              WHERE thread_id = ${threadId} AND seq < (
                SELECT seq FROM messages WHERE thread_id = ${threadId} AND id = ${messageId}
              )
              ORDER BY seq DESC LIMIT 1`.pipe(
              Effect.flatMap((rows) =>
                rows[0] === undefined
                  ? Effect.succeed(undefined)
                  : readableRow(
                      unreadable,
                      "messages",
                      `${threadId}/${rows[0].id}`,
                      decodeStored(UIMessageSchema, rows[0].message),
                    ),
              ),
            ),
          ),
        rewindThread: (threadId, plan, restoreFiles = Effect.void) =>
          tx(
            Effect.gen(function* () {
              const before = yield* readThread(threadId);
              const [target] = yield* sql<{
                role: string;
                turn_id: string | null;
              }>`SELECT role,turn_id FROM messages WHERE thread_id=${threadId} AND id=${plan.messageId}`;
              if (
                target === undefined ||
                target.role !== plan.role ||
                (target.turn_id ?? undefined) !== plan.turnId ||
                before.checkout.path !== plan.cwd
              )
                return yield* new InvalidState({
                  threadId,
                  message:
                    "The rewind target changed; history and files are preserved. Resolve the target again.",
                });
              yield* truncateMessages(threadId, plan.messageId, plan.role === "user");
              if (plan.resumeAt === undefined) {
                const { agentSessionId, agentSessionUnused, codexHome, ...rest } = before;
                void agentSessionId;
                void agentSessionUnused;
                void codexHome;
                yield* writeThread(rest);
              }
              // The transaction holds its writer snapshot through the checkpoint effect: a checkpoint
              // error, defect or interruption rolls back all SQL.
              yield* restoreFiles;
              return yield* readThread(threadId);
            }),
          ),
        truncateMessagesFrom: (threadId, messageId) =>
          tx(truncateMessages(threadId, messageId, true)),
        truncateMessagesAfter: (threadId, messageId) =>
          tx(truncateMessages(threadId, messageId, false)),
        deleteMessage: (threadId, messageId) =>
          tx(
            Effect.gen(function* () {
              const removed = yield* sql<{ id: string }>`DELETE FROM messages
                WHERE thread_id = ${threadId} AND id = ${messageId} RETURNING id`;
              if (removed.length === 0) return false;
              yield* takeRev(threadId, true);
              return true;
            }),
          ),
        deleteQueuedMessages: () =>
          tx(
            Effect.gen(function* () {
              const removed = yield* sql<{ thread_id: string }>`DELETE FROM messages
                WHERE EXISTS (SELECT 1 FROM queue_items q
                  WHERE q.thread_id = messages.thread_id AND q.id = messages.id)
                RETURNING thread_id`;
              for (const threadId of new Set(removed.map((row) => row.thread_id))) {
                yield* takeRev(threadId, true);
              }
              return removed.length;
            }),
          ),
        getCompletedReason: (id) =>
          run(
            sql<{ completed_reason: string | null }>`SELECT completed_reason FROM threads
              WHERE id = ${id}`.pipe(
              Effect.map(
                (rows) => (rows[0]?.completed_reason ?? undefined) as CompletedReason | undefined,
              ),
            ),
          ),
        updateSettings: (f, touched) =>
          tx(
            Effect.gen(function* () {
              yield* writeSettings(f(yield* readSettings), touched);
              // Read back: what was kept of the stored row can make it read more than `f` returned.
              return yield* readSettings;
            }),
          ),
        usageOverview: (query, history) =>
          run(
            readUsageOverview(query, history).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
          ),
        ensureProject,
        registerProject,
        listProjects,
        updateProjectLocalCheckAudited: (id, writes, audit, expectedRevision) =>
          tx(
            Effect.gen(function* () {
              const row = (yield* sql<ProjectRow>`SELECT * FROM projects WHERE id = ${id}`)[0];
              if (row === undefined) return undefined;
              const before = toProject(row);
              // Pin the COMPLETE raw value, including malformed A -> malformed B, inside this
              // same transaction. A stale approval writes neither configuration nor audit.
              if (before.localCheckRevision !== expectedRevision) return undefined;
              const next = applyProjectSettingsWrites(before, writes);
              if (next === undefined) return undefined;
              const checked = Schema.decodeUnknownSync(Project)(next);
              yield* sql`UPDATE projects SET local_check = ${checked.localCheck === undefined ? null : JSON.stringify(checked.localCheck)} WHERE id = ${id}`;
              const auditSeq = yield* insertSettingsAudit({ ...audit, projectId: id });
              return { auditSeq };
            }),
          ),
        setProjectBookmarked,
        forgetProject,

        insertThread: (thread) => tx(writeThread(thread)),
        getThread: (id) => run(readThread(id)),
        getThreadWithAuthority: (id, callerId) =>
          tx(
            Effect.gen(function* () {
              const thread = yield* readThread(id);
              return { thread, context: yield* readThreadAuthority(thread, callerId) };
            }),
          ),
        listThreads: run(
          Effect.gen(function* () {
            // The token first: a write landing between the two reads leaves the list under the
            // older token, which the next call no longer matches.
            const [version] = yield* sql<{
              token: string;
            }>`SELECT hex(token) AS token FROM threads_version`;
            if (version !== undefined && listedThreads?.token === version.token) {
              return listedThreads.threads;
            }
            const rows = yield* sql<{
              id: string;
              data: string;
            }>`SELECT id, data FROM threads ORDER BY sort_order, created_at`;
            const threads = yield* readableRows(
              unreadable,
              "threads",
              rows,
              (r) => r.id,
              (r) => decodeStored(Thread, r.data),
            );
            listedThreads = version === undefined ? undefined : { token: version.token, threads };
            return threads;
          }),
        ),
        updateThread,
        // SQLite doesn't enforce foreign keys unless asked, so child rows go explicitly.
        removeThread: (id) =>
          tx(
            Effect.gen(function* () {
              for (const table of [
                "queue_items",
                "requests",
                "tasks",
                "messages",
                "turns",
                "draft_stashes",
                "thread_plans",
                "helper_outputs",
                "wait_items",
                "thread_wakes",
                "thread_outputs",
              ]) {
                yield* sql`DELETE FROM ${sql(table)} WHERE thread_id = ${id}`;
              }
              yield* sql`DELETE FROM threads WHERE id = ${id}`;
              yield* unlinkOrchestration(id);
            }),
          ),
        closeThread: (id, closedAt) =>
          tx(
            Effect.gen(function* () {
              const live = yield* sql<{ data: string }>`SELECT data FROM threads WHERE id = ${id}`;
              if (live.length === 0) return;
              // Read before `unlinkOrchestration` cuts the link below, which is the only record.
              const linked = yield* sql<{ data: string }>`SELECT data FROM threads
                WHERE CASE WHEN json_valid(data)
                  THEN json_extract(data, '$.spawnedBy.threadId') = ${id} ELSE 0 END`;
              const workers = linked.flatMap((row): Array<ClosedWorker> => {
                const decoded = decodeStored(Thread, row.data);
                return decoded.ok && decoded.value.spawnedBy !== undefined
                  ? [{ threadId: decoded.value.id, feature: decoded.value.spawnedBy.feature }]
                  : [];
              });
              yield* keepClosed(id, closedAt, live[0]!.data, workers);
              yield* purgeHistory(id);
              yield* sql`INSERT INTO closed_messages (thread_id, id, seq, role, turn_id, message)
                SELECT thread_id, id, seq, role, turn_id, message FROM messages
                WHERE thread_id = ${id}`;
              yield* sql`INSERT INTO closed_turns
                (id, thread_id, started_at, ended_at, reason, usage, cost_usd, checkpoint_ref)
                SELECT id, thread_id, started_at, ended_at, reason, usage, cost_usd, checkpoint_ref
                FROM turns WHERE thread_id = ${id}`;
              // Stashes go with the thread: its attachments folder is deleted on close too. So do its
              // wakes: a reopened thread starts with none.
              for (const table of [
                "queue_items",
                "requests",
                "tasks",
                "messages",
                "turns",
                "draft_stashes",
                "helper_outputs",
                "wait_items",
                "thread_wakes",
                "thread_outputs",
              ]) {
                yield* sql`DELETE FROM ${sql(table)} WHERE thread_id = ${id}`;
              }
              yield* sql`DELETE FROM threads WHERE id = ${id}`;
              yield* unlinkOrchestration(id, true);
            }),
          ),
        restoreClosedHistory: (id) =>
          tx(
            Effect.gen(function* () {
              const rev = yield* takeRev(id, true);
              yield* sql`INSERT INTO messages (thread_id, id, seq, role, turn_id, message, rev)
                SELECT thread_id, id, seq, role, turn_id, message, ${rev} FROM closed_messages
                WHERE thread_id = ${id} ORDER BY seq`;
              yield* sql`INSERT INTO turns
                (id, thread_id, started_at, ended_at, reason, usage, cost_usd, checkpoint_ref)
                SELECT id, thread_id, started_at, ended_at, reason, usage, cost_usd, checkpoint_ref
                FROM closed_turns WHERE thread_id = ${id}`;
              yield* purgeHistory(id);
            }),
          ),

        listClosed: run(
          sql<{
            thread_id: string;
            data: string;
            closed_at: number;
          }>`SELECT thread_id, data, closed_at FROM closed_threads
            ORDER BY closed_at DESC, rowid DESC`.pipe(
            Effect.flatMap((rows) =>
              readableRows(
                unreadable,
                "closed_threads",
                rows,
                (r) => r.thread_id,
                (r) =>
                  mapDecoded(decodeStored(Thread, r.data), (thread) => ({
                    thread,
                    closedAt: Number(r.closed_at),
                  })),
              ),
            ),
          ),
        ),
        closedWorkers: (id) =>
          run(
            sql<{ workers: string | null }>`SELECT workers FROM closed_threads
              WHERE thread_id = ${id}`.pipe(
              Effect.map((rows) => {
                const text = rows[0]?.workers;
                if (text === undefined || text === null) return [];
                // Only a link back is lost to a list that doesn't read: the workers stay detached.
                const decoded = decodeStored(ClosedWorkers, text);
                return decoded.ok ? decoded.value : [];
              }),
            ),
          ),
        rememberClosed: (thread, closedAt, workers) =>
          tx(keepClosed(thread.id, closedAt, toJson(Thread, thread), workers)),
        takeNewestClosed: tx(
          Effect.gen(function* () {
            const rows = yield* sql<{
              thread_id: string;
              data: string;
              closed_at: number;
              workers: string | null;
            }>`SELECT thread_id, data, closed_at, workers FROM closed_threads
              ORDER BY closed_at DESC, rowid DESC`;
            for (const row of rows) {
              // One that doesn't read is left where it is, as `listClosed` leaves it out.
              const decoded = decodeStored(Thread, row.data);
              if (!decoded.ok) continue;
              yield* sql`DELETE FROM closed_threads WHERE thread_id = ${row.thread_id}`;
              const workers =
                row.workers === null ? undefined : decodeStored(ClosedWorkers, row.workers);
              return {
                closed: { thread: decoded.value, closedAt: Number(row.closed_at) },
                workers: workers?.ok === true ? workers.value : [],
              };
            }
            return undefined;
          }),
        ),
        forgetClosed: (threadId) =>
          run(sql`DELETE FROM closed_threads WHERE thread_id = ${threadId}`.pipe(Effect.asVoid)),

        listMessages: (threadId) =>
          run(
            sql<{ id: string; message: string }>`SELECT id, message FROM messages
              WHERE thread_id = ${threadId} ORDER BY seq`.pipe(
              Effect.flatMap((rows) => messageRows("messages", threadId, rows)),
            ),
          ),
        listUserMessages: (threadId) =>
          run(
            sql<{ id: string; message: string }>`SELECT id, message FROM messages
              WHERE thread_id = ${threadId} AND role = 'user' ORDER BY seq`.pipe(
              Effect.flatMap((rows) => messageRows("messages", threadId, rows)),
            ),
          ),
        messagesWith,
        messageTextsWith: (threadId, needles) =>
          messagesWith(threadId, needles).pipe(
            Effect.map((messages) =>
              messages.flatMap((message) =>
                message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
              ),
            ),
          ),
        messageMarks: (threadId, closed = false) =>
          run(
            (closed
              ? sql<{ seq: number; id: string; rev: number; at: unknown; open: number }>`
                  SELECT m.seq, m.id, 0 AS rev,
                    COALESCE(CASE WHEN json_valid(m.message)
                      THEN json_extract(m.message, '$.metadata.createdAt') END,
                      t.ended_at, t.started_at) AS at,
                    0 AS open
                  FROM closed_messages m LEFT JOIN closed_turns t ON t.id = m.turn_id
                  WHERE m.thread_id = ${threadId} ORDER BY m.seq`
              : sql<{ seq: number; id: string; rev: number; at: unknown; open: number }>`
                  SELECT m.seq, m.id, m.rev,
                    COALESCE(CASE WHEN json_valid(m.message)
                      THEN json_extract(m.message, '$.metadata.createdAt') END,
                      t.ended_at, t.started_at) AS at,
                    (t.id IS NOT NULL AND t.ended_at IS NULL) AS open
                  FROM messages m LEFT JOIN turns t ON t.id = m.turn_id
                  WHERE m.thread_id = ${threadId} ORDER BY m.seq`
            ).pipe(
              Effect.map((rows) =>
                rows.map((r): MessageMark => ({
                  seq: Number(r.seq),
                  id: r.id,
                  rev: Number(r.rev),
                  at: typeof r.at === "number" ? r.at : undefined,
                  open: Number(r.open) === 1,
                })),
              ),
            ),
          ),
        listMessagesFrom: (threadId, fromSeq, closed = false) =>
          run(
            (closed
              ? sql<{ id: string; seq: number; message: string }>`SELECT id, seq, message
                  FROM closed_messages WHERE thread_id = ${threadId} AND seq >= ${fromSeq}
                  ORDER BY seq`
              : sql<{ id: string; seq: number; message: string }>`SELECT id, seq, message
                  FROM messages WHERE thread_id = ${threadId} AND seq >= ${fromSeq}
                  ORDER BY seq`
            ).pipe(
              Effect.flatMap((rows) =>
                readableRows(
                  unreadable,
                  closed ? "closed_messages" : "messages",
                  rows,
                  (r) => `${threadId}/${r.id}`,
                  (r) =>
                    mapDecoded(decodeStored(UIMessageSchema, r.message), (message): SeqMessage => ({
                      seq: Number(r.seq),
                      message,
                    })),
                ),
              ),
            ),
          ),
        listClosedMessages: (threadId) =>
          run(
            sql<{ id: string; message: string }>`SELECT id, message FROM closed_messages
              WHERE thread_id = ${threadId} ORDER BY seq`.pipe(
              Effect.flatMap((rows) => messageRows("closed_messages", threadId, rows)),
            ),
          ),
        upsertMessage,
        refreshSearch: (threadId, messageId) =>
          run(
            sql`UPDATE messages SET search_pending = NULL
              WHERE thread_id = ${threadId} AND id = ${messageId} AND search_pending IS NOT NULL`.pipe(
              Effect.as(true),
              Effect.catch((error) =>
                isLockWait(error) ? Effect.succeed(false) : Effect.fail(error),
              ),
            ),
          ),
        feedRevision: (threadId) =>
          run(
            sql<{ feed_rev: number; feed_reset_rev: number }>`SELECT feed_rev, feed_reset_rev
              FROM threads WHERE id = ${threadId}`.pipe(
              Effect.map(([row]) =>
                row === undefined
                  ? undefined
                  : { rev: Number(row.feed_rev), resetRev: Number(row.feed_reset_rev) },
              ),
            ),
          ),
        messagesSince: (threadId, afterRev, limit, fromId) =>
          tx(
            Effect.gen(function* () {
              let from = 0;
              if (fromId !== undefined) {
                const [row] = yield* sql<{ seq: number }>`SELECT seq FROM messages
                  WHERE thread_id = ${threadId} AND id = ${fromId}`;
                if (row === undefined) return undefined;
                from = Number(row.seq);
              }
              // Counted on the index first, so a resume too far behind reads no message bodies.
              const [count] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM messages
                WHERE thread_id = ${threadId} AND rev > ${afterRev} AND seq >= ${from}`;
              if (Number(count?.n ?? 0) > limit) return undefined;
              const rows = yield* sql<{ id: string; message: string }>`SELECT id, message
                FROM messages WHERE thread_id = ${threadId} AND rev > ${afterRev} AND seq >= ${from}
                ORDER BY seq`;
              return yield* messageRows("messages", threadId, rows);
            }),
          ),
        recentMessages: (threadId, turns, beforeId) =>
          tx(
            Effect.gen(function* () {
              let end = Number.MAX_SAFE_INTEGER;
              if (beforeId !== undefined) {
                const [row] = yield* sql<{ seq: number }>`SELECT seq FROM messages
                  WHERE thread_id = ${threadId} AND id = ${beforeId}`;
                if (row === undefined) return { messages: [], earlier: false };
                end = Number(row.seq);
              }
              const [first] = yield* sql<{ seq: number }>`SELECT seq FROM messages
                WHERE thread_id = ${threadId} AND role = 'user' AND seq < ${end}
                ORDER BY seq DESC LIMIT 1 OFFSET ${turns - 1}`;
              const start = first === undefined ? Number.MIN_SAFE_INTEGER : Number(first.seq);
              const rows = yield* sql<{ id: string; message: string }>`SELECT id, message
                FROM messages WHERE thread_id = ${threadId} AND seq >= ${start} AND seq < ${end}
                ORDER BY seq`;
              const [older] =
                first === undefined
                  ? []
                  : yield* sql<{ one: number }>`SELECT 1 AS one FROM messages
                      WHERE thread_id = ${threadId} AND seq < ${start} LIMIT 1`;
              return {
                messages: yield* messageRows("messages", threadId, rows),
                earlier: older !== undefined,
              };
            }),
          ),
        copyMessages: (from, to, upToMessageId) =>
          tx(
            Effect.gen(function* () {
              const [target] = yield* sql<{ seq: number }>`SELECT seq FROM messages
                WHERE thread_id = ${from} AND id = ${upToMessageId}`;
              if (target === undefined) return [];
              const rows = yield* sql<{ id: string; message: string }>`SELECT id, message
                FROM messages WHERE thread_id = ${from} AND seq <= ${target.seq} ORDER BY seq`;
              const copies = (yield* messageRows("messages", from, rows)).map(
                (message): GramUIMessage => ({ ...message, id: randomUUID() }),
              );
              const rev = yield* takeRev(to, true);
              for (const [index, message] of copies.entries()) {
                yield* sql`INSERT INTO messages (thread_id, id, seq, role, turn_id, message, rev)
                  VALUES (${to}, ${message.id}, ${index + 1}, ${message.role}, NULL,
                    ${JSON.stringify(message)}, ${rev})`;
              }
              return copies;
            }),
          ),

        startTurn: (threadId, turnId, startedAt) =>
          run(
            sql`INSERT INTO turns (id, thread_id, started_at)
              VALUES (${turnId}, ${threadId}, ${startedAt})`,
          ),
        endTurn: (turnId, { endedAt, reason, usage }) =>
          run(
            sql`UPDATE turns SET ended_at = ${endedAt}, reason = ${reason},
                usage = ${usage === undefined ? null : toJson(UsageSummary, usage)},
                cost_usd = ${usage?.costUsd ?? null}
              WHERE id = ${turnId} AND ended_at IS NULL`,
          ),
        closeOpenTurns: (endedAt) =>
          run(
            // A clock set back since the turn started mustn't end it before it began.
            sql<{
              id: string;
              thread_id: string;
              started_at: number;
              ended_at: number;
            }>`UPDATE turns
              SET ended_at = MAX(started_at, ${endedAt}), reason = 'interrupted'
              WHERE ended_at IS NULL
              RETURNING id, thread_id, started_at, ended_at`.pipe(
              Effect.map((rows) =>
                rows.map((r): TurnRecord => ({
                  id: r.id as TurnId,
                  threadId: r.thread_id as ThreadId,
                  startedAt: Number(r.started_at),
                  endedAt: Number(r.ended_at),
                  reason: "interrupted",
                })),
              ),
            ),
          ),
        lastTurnUsage: (threadId) =>
          run(
            sql<{ id: string; usage: string }>`SELECT id, usage FROM turns
              WHERE thread_id = ${threadId} AND ended_at IS NOT NULL AND usage IS NOT NULL
              ORDER BY ended_at DESC, rowid DESC LIMIT 1`.pipe(
              Effect.flatMap((rows) => {
                const row = rows[0];
                if (row === undefined) return Effect.succeed(undefined);
                return readableRow(
                  unreadable,
                  "turns.usage",
                  row.id,
                  decodeStored(UsageSummary, row.usage),
                );
              }),
            ),
          ),
        lastTurn: (threadId) =>
          run(
            sql<TurnRow>`SELECT id, thread_id, started_at, ended_at, reason FROM turns
              WHERE thread_id = ${threadId} ORDER BY rowid DESC LIMIT 1`.pipe(
              Effect.map((rows) => {
                const r = rows[0];
                if (r === undefined) return undefined;
                return {
                  id: r.id as TurnId,
                  threadId: r.thread_id as ThreadId,
                  startedAt: Number(r.started_at),
                  endedAt: r.ended_at === null ? undefined : Number(r.ended_at),
                  reason: (r.reason ?? undefined) as TurnEndReason | undefined,
                } satisfies TurnRecord;
              }),
            ),
          ),
        listTurns: (threadId) =>
          run(
            sql<TurnRow>`SELECT id, thread_id, started_at, ended_at, reason FROM turns
              WHERE thread_id = ${threadId} ORDER BY started_at, rowid`.pipe(
              Effect.map((rows) =>
                rows.map((r): TurnRecord => ({
                  id: r.id as TurnId,
                  threadId: r.thread_id as ThreadId,
                  startedAt: Number(r.started_at),
                  endedAt: r.ended_at === null ? undefined : Number(r.ended_at),
                  reason: (r.reason ?? undefined) as TurnEndReason | undefined,
                })),
              ),
            ),
          ),

        putRequest: (threadId, request, createdAt) =>
          run(
            sql`INSERT INTO requests (thread_id, id, created_at, request)
              VALUES (${threadId}, ${request.id}, ${createdAt}, ${toJson(PendingRequest, request)})
              ON CONFLICT (thread_id, id) DO UPDATE SET request = excluded.request`,
          ),
        removeRequest: (threadId, requestId) =>
          tx(
            Effect.gen(function* () {
              const rows = yield* sql<{ id: string }>`SELECT id FROM requests
                WHERE thread_id = ${threadId} AND id = ${requestId}`;
              if (rows.length === 0) return false;
              yield* sql`DELETE FROM requests WHERE thread_id = ${threadId} AND id = ${requestId}`;
              return true;
            }),
          ),
        listRequests: (threadId) =>
          run(
            sql<{ id: string; request: string }>`SELECT id, request FROM requests
              WHERE thread_id = ${threadId} ORDER BY created_at, rowid`.pipe(
              Effect.flatMap((rows) =>
                readableRows(
                  unreadable,
                  "requests",
                  rows,
                  (r) => `${threadId}/${r.id}`,
                  (r) => decodeStored(PendingRequest, r.request),
                ),
              ),
            ),
          ),
        clearRequests: (threadId) =>
          run(
            threadId === undefined
              ? sql`DELETE FROM requests`
              : sql`DELETE FROM requests WHERE thread_id = ${threadId}`,
          ),

        listThreadWakes: run(
          sql<WakeRow>`SELECT id, thread_id, at, set_at, note, pr FROM thread_wakes
            ORDER BY at, rowid`.pipe(Effect.flatMap((rows) => wakeRows(rows))),
        ),
        addThreadWake: (wake, max) =>
          tx(
            Effect.gen(function* () {
              const [row] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM thread_wakes
                WHERE thread_id = ${wake.threadId}`;
              if (Number(row?.n ?? 0) >= max) return false;
              const pr =
                wake.onPr === undefined
                  ? null
                  : toJson(ThreadWakePr, {
                      onPr: wake.onPr,
                      ...(wake.on === undefined ? {} : { on: wake.on }),
                      ...(wake.seen === undefined ? {} : { seen: wake.seen }),
                      ...(wake.fired === undefined ? {} : { fired: wake.fired }),
                    });
              yield* sql`INSERT INTO thread_wakes (id, thread_id, at, set_at, note, pr)
                VALUES (${wake.id}, ${wake.threadId}, ${wake.at}, ${wake.setAt}, ${wake.note}, ${pr})`;
              return true;
            }),
          ),
        updateThreadWakePr: (id, change) =>
          tx(
            Effect.gen(function* () {
              const [row] = yield* sql<WakeRow>`SELECT id, thread_id, at, set_at, note, pr
                FROM thread_wakes WHERE id = ${id}`;
              if (row === undefined) return;
              const [wake] = yield* wakeRows([row]);
              if (wake?.onPr === undefined) return;
              const seen = change.seen ?? wake.seen;
              // The first event kept stands: a concurrent look's later one doesn't replace it.
              const fired = wake.fired ?? change.fired;
              const pr = toJson(ThreadWakePr, {
                onPr: wake.onPr,
                ...(wake.on === undefined ? {} : { on: wake.on }),
                ...(seen === undefined ? {} : { seen }),
                ...(fired === undefined ? {} : { fired }),
              });
              yield* sql`UPDATE thread_wakes SET pr = ${pr} WHERE id = ${id}`;
            }),
          ),
        removeThreadWakes: (threadId, id) =>
          tx(
            Effect.gen(function* () {
              const rows =
                id === undefined
                  ? yield* sql<WakeRow>`SELECT id, thread_id, at, set_at, note, pr FROM thread_wakes
                      WHERE thread_id = ${threadId}`
                  : yield* sql<WakeRow>`SELECT id, thread_id, at, set_at, note, pr FROM thread_wakes
                      WHERE thread_id = ${threadId} AND id = ${id}`;
              for (const row of rows) yield* sql`DELETE FROM thread_wakes WHERE id = ${row.id}`;
              return yield* wakeRows(rows);
            }),
          ),
        getPlan: (threadId) => run(readPlan(threadId).pipe(Effect.map(({ record }) => record))),
        updatePlan: (threadId, f) =>
          tx(
            Effect.gen(function* () {
              const { record: current, unreadPlan, unreadTurnPlan } = yield* readPlan(threadId);
              const next = f(current);
              if (next === current) return current;
              // A column that didn't decode read as absent; left absent, it is kept as stored.
              const plan =
                next.plan === undefined ? (unreadPlan ?? null) : toJson(ThreadPlan, next.plan);
              const turnPlan =
                next.turnPlan === undefined
                  ? (unreadTurnPlan ?? null)
                  : toJson(TurnPlanJson, next.turnPlan);
              if (plan === null && turnPlan === null) {
                yield* sql`DELETE FROM thread_plans WHERE thread_id = ${threadId}`;
                return next;
              }
              yield* sql`INSERT INTO thread_plans (thread_id, plan, turn_plan, rev)
                VALUES (${threadId}, ${plan}, ${turnPlan}, 1)
                ON CONFLICT (thread_id) DO UPDATE
                SET plan = excluded.plan, turn_plan = excluded.turn_plan, rev = rev + 1`;
              return next;
            }),
          ),
        putTask: (threadId, messageId, task) =>
          run(
            sql`INSERT INTO tasks (thread_id, id, message_id, data)
              VALUES (${threadId}, ${task.id}, ${messageId}, ${toJson(TaskChipDataSchema, task)})
              ON CONFLICT (thread_id, id) DO UPDATE SET data = excluded.data`,
          ),
        getTask: (threadId, taskId) =>
          run(
            sql<{ message_id: string; data: string }>`SELECT message_id, data FROM tasks
              WHERE thread_id = ${threadId} AND id = ${taskId}`.pipe(
              Effect.flatMap((rows) =>
                rows[0] === undefined
                  ? Effect.succeed(undefined)
                  : readableRow(
                      unreadable,
                      "tasks",
                      `${threadId}/${taskId}`,
                      mapDecoded(
                        decodeStored(TaskChipDataSchema, rows[0].data),
                        (task): TaskRecord => ({ messageId: rows[0]!.message_id, task }),
                      ),
                    ),
              ),
              Effect.flatMap((record) =>
                record === undefined
                  ? Effect.fail(new NotFound({ entity: "task", id: taskId }))
                  : Effect.succeed(record),
              ),
            ),
          ),

        listWaits: (threadId, which = "open") =>
          run(
            (which === "open"
              ? sql<{ id: string; item: string }>`SELECT id, item FROM wait_items
                  WHERE thread_id = ${threadId} AND resolved_at IS NULL
                  ORDER BY created_at, rowid`
              : sql<{ id: string; item: string }>`SELECT id, item FROM wait_items
                  WHERE thread_id = ${threadId} ORDER BY created_at, rowid`
            ).pipe(
              Effect.flatMap((rows) =>
                readableRows(
                  unreadable,
                  "wait_items",
                  rows,
                  (r) => `${threadId}/${r.id}`,
                  (r) => decodeStored(WaitItem, r.item),
                ),
              ),
            ),
          ),
        listResolvedWaits: (threadId, since) =>
          run(
            sql<{ id: string; item: string }>`SELECT id, item FROM wait_items
              WHERE thread_id = ${threadId} AND resolved_at >= ${since}
              ORDER BY created_at, rowid`.pipe(
              Effect.flatMap((rows) =>
                readableRows(
                  unreadable,
                  "wait_items",
                  rows,
                  (r) => `${threadId}/${r.id}`,
                  (r) => decodeStored(WaitItem, r.item),
                ),
              ),
            ),
          ),
        getWait: (threadId, id) => run(readWait(threadId, id)),
        putWait: (threadId, item, toldAt) => run(writeWait(threadId, item, toldAt ?? null)),
        resolveWait: (threadId, id, resolution) =>
          tx(
            Effect.gen(function* () {
              const item = yield* readWait(threadId, id);
              if (resolution !== undefined && item.resolvedAt !== undefined) {
                // The agent resolving one the user got to first learns so from its answer.
                if (resolution.by === "agent") {
                  yield* sql`UPDATE wait_items SET told_at = ${resolution.at}
                    WHERE thread_id = ${threadId} AND id = ${id}`;
                }
                return item;
              }
              const { resolvedAt: _at, resolvedBy: _by, note: _note, ...rest } = item;
              // Done and Undo are changes too: an answer about the item as it was no longer holds.
              const open: WaitItem =
                item.resolvedAt === undefined && resolution === undefined
                  ? rest
                  : { ...rest, revision: (item.revision ?? 0) + 1 };
              const next: WaitItem =
                resolution === undefined
                  ? open
                  : {
                      ...open,
                      resolvedAt: resolution.at,
                      resolvedBy: resolution.by,
                      ...(resolution.note === undefined ? {} : { note: resolution.note }),
                    };
              const told = yield* toldAtOf(threadId, id);
              const toldAt =
                resolution?.by === "agent"
                  ? resolution.at
                  : resolution === undefined &&
                      item.resolvedAt !== undefined &&
                      told !== null &&
                      told >= item.resolvedAt
                    ? null
                    : undefined;
              yield* writeWait(threadId, next, toldAt);
              return next;
            }),
          ),
        listWaitNews: (threadId) =>
          run(
            sql<{ id: string; item: string }>`SELECT id, item FROM wait_items
              WHERE thread_id = ${threadId}
                AND (told_at IS NULL OR (resolved_at IS NOT NULL AND told_at < resolved_at))
              ORDER BY created_at, rowid`.pipe(
              Effect.flatMap((rows) =>
                readableRows(
                  unreadable,
                  "wait_items",
                  rows,
                  (r) => `${threadId}/${r.id}`,
                  (r) => decodeStored(WaitItem, r.item),
                ),
              ),
            ),
          ),
        markWaitsTold: (threadId, items, at) =>
          items.length === 0
            ? Effect.void
            : tx(
                Effect.forEach(
                  items,
                  (item) =>
                    // Never before the resolution it heard of, so a clock that steps back leaves it
                    // heard; a row that changed since is news again.
                    sql`UPDATE wait_items SET told_at = CASE
                        WHEN resolved_at IS ${item.resolvedAt ?? null}
                          THEN MAX(${at}, COALESCE(resolved_at, ${at}))
                        ELSE NULL END
                      WHERE thread_id = ${threadId} AND id = ${item.id}`,
                  { discard: true },
                ),
              ),

        getSettings: run(readSettings),
        putSettings: (settings) => tx(writeSettings(settings)),
        getSeenConnectors: run(readSeenConnectors),
        updateSeenConnectors: (f) =>
          tx(
            Effect.gen(function* () {
              const next = f(yield* readSeenConnectors);
              if (next === undefined) return;
              const json = JSON.stringify(Schema.encodeSync(Schema.Array(SeenConnector))(next));
              yield* sql`INSERT INTO settings (key, value) VALUES (${SEEN_CONNECTORS_KEY}, ${json})
                ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
            }),
          ),

        listWorkspaces: run(
          sql<{
            id: string;
            data: string;
          }>`SELECT id, data FROM workspaces ORDER BY created_at, rowid`.pipe(
            Effect.flatMap((rows) =>
              readableRows(
                unreadable,
                "workspaces",
                rows,
                (r) => r.id,
                (r) => decodeStored(WorkspaceState, r.data),
              ),
            ),
          ),
        ),
        getWorkspace: (id) => run(readWorkspace(id)),
        putWorkspace: (state) => tx(writeWorkspace(state)),
        updateWorkspace: (id, f) =>
          tx(
            Effect.gen(function* () {
              const next = f(yield* readWorkspace(id));
              if (next.workspace.id !== id) {
                return yield* Effect.die(new Error(`workspace ${id} cannot change its id`));
              }
              yield* writeWorkspace(next);
              return next;
            }),
          ),
        removeWorkspace: (id) =>
          tx(
            Effect.gen(function* () {
              const state = yield* readWorkspace(id);
              const [holder] = yield* sql<{ id: string }>`SELECT id FROM threads WHERE id IN (
                SELECT orchestrator_thread_id FROM workspaces WHERE id = ${id})`;
              if (holder !== undefined) {
                return yield* new InvalidState({
                  message: `Close the orchestrator of ${state.workspace.name} before removing the workspace.`,
                  threadId: holder.id as ThreadId,
                });
              }
              // Its row is about to go, whatever its status, and a dream thread left open would have
              // no review to end in.
              const [dreaming] = yield* sql<{ id: string }>`SELECT id FROM threads WHERE id IN (
                SELECT thread_id FROM dreams WHERE workspace_id = ${id})`;
              if (dreaming !== undefined) {
                return yield* new InvalidState({
                  message: `A dream thread of ${state.workspace.name} is still open. Try removing it again.`,
                  threadId: dreaming.id as ThreadId,
                });
              }
              for (const table of [
                "worker_reports",
                "orchestration_outbox",
                "orchestration_events",
                "feature_cards",
                "dreams",
                "automatic_dream",
                "dream_watermarks",
              ]) {
                yield* sql`DELETE FROM ${sql(table)} WHERE workspace_id = ${id}`;
              }
              yield* sql`DELETE FROM workspaces WHERE id = ${id}`;
            }),
          ),
        // One UPDATE decides the race: SQLite serialises writers, so the second claim's WHERE sees
        // the first one's slot. A read followed by a write would let both see it empty.
        claimOrchestratorSlot: (workspaceId, threadId) =>
          run(
            sql<{ id: string }>`UPDATE workspaces SET orchestrator_thread_id = ${threadId},
                data = CASE WHEN json_valid(data)
                  THEN json_set(data, '$.workspace.orchestratorThreadId', ${threadId})
                  ELSE data END
              WHERE id = ${workspaceId}
                AND ${threadId} IN (SELECT id FROM threads)
                AND (orchestrator_thread_id IS NULL
                  OR orchestrator_thread_id = ${threadId}
                  OR orchestrator_thread_id NOT IN (SELECT id FROM threads))
              RETURNING id`.pipe(Effect.map((rows) => rows.length > 0)),
          ),
        releaseOrchestratorSlot: (threadId) =>
          run(
            sql`UPDATE workspaces SET orchestrator_thread_id = NULL,
                data = CASE WHEN json_valid(data)
                  THEN json_remove(data, '$.workspace.orchestratorThreadId') ELSE data END
              WHERE orchestrator_thread_id = ${threadId}`.pipe(Effect.asVoid),
          ),

        addWorkerReport: (workspaceId, report) =>
          run(
            sql<{ seq: number }>`INSERT INTO worker_reports (thread_id, workspace_id, at, data)
              VALUES (${report.threadId}, ${workspaceId}, ${report.at},
                ${toJson(WorkerReport, report)})
              RETURNING seq`.pipe(Effect.map((rows) => Number(rows[0]!.seq))),
          ),
        listWorkerReports: (workspaceId, afterSeq) =>
          run(
            sql<{ seq: number; data: string }>`SELECT seq, data FROM worker_reports
              WHERE workspace_id = ${workspaceId} AND seq > ${afterSeq ?? 0}
              ORDER BY seq`.pipe(
              Effect.flatMap((rows) =>
                readableRows(
                  unreadable,
                  "worker_reports",
                  rows,
                  (r) => String(r.seq),
                  (r) =>
                    mapDecoded(
                      decodeStored(WorkerReport, r.data),
                      (report): WorkerReportRecord => ({ seq: Number(r.seq), report }),
                    ),
                ),
              ),
            ),
          ),
        // Each subquery is a seek on its own index, the second's holding only the reports that
        // state an interface, so a worker that never stated one costs no scan of its history.
        latestWorkerReports: (workspaceId, threadIds) =>
          run(
            sql<{ thread_id: string; data: string | null; stated: string | null }>`SELECT
                ids.value AS thread_id,
                (SELECT r.data FROM worker_reports r
                  WHERE r.workspace_id = ${workspaceId} AND r.thread_id = ids.value
                  ORDER BY r.seq DESC LIMIT 1) AS data,
                (SELECT json_extract(r.data, '$.interface') FROM worker_reports r
                  WHERE r.workspace_id = ${workspaceId} AND r.thread_id = ids.value
                    AND json_extract(r.data, '$.interface') IS NOT NULL
                  ORDER BY r.seq DESC LIMIT 1) AS stated
              FROM json_each(${JSON.stringify(threadIds)}) ids
              ORDER BY ids.key`.pipe(
              Effect.flatMap((rows) =>
                readableRows(
                  unreadable,
                  "worker_reports",
                  rows.flatMap((r) => (r.data === null ? [] : [{ ...r, data: r.data }])),
                  (r) => `latest of ${r.thread_id}`,
                  (r) =>
                    mapDecoded(
                      decodeStored(WorkerReport, r.data),
                      (report): LatestWorkerReport => ({
                        report,
                        ...(r.stated === null ? {} : { interface: r.stated }),
                      }),
                    ),
                ),
              ),
            ),
          ),
        latestWorkerReportSeq: (workspaceId) =>
          run(
            sql<{ seq: number | null }>`SELECT MAX(seq) AS seq FROM worker_reports
              WHERE workspace_id = ${workspaceId}`.pipe(
              Effect.map((rows) => Number(rows[0]?.seq ?? 0)),
            ),
          ),

        getAutomaticDreamState: (id) => run(readAutomaticDreamState(id)),
        updateAutomaticDreamState: (id, f) =>
          tx(
            Effect.gen(function* () {
              const state = yield* readAutomaticDreamState(id);
              if (state !== undefined) yield* writeAutomaticDreamState(id, f(state));
            }),
          ),
        withDreamFileCommit: (effect) => tx(Effect.uninterruptible(effect)),
        putDream: (dream) =>
          run(
            sql`INSERT INTO dreams (id, workspace_id, thread_id, created_at, data)
              VALUES (${dream.id}, ${dream.workspaceId}, ${dream.threadId ?? null},
                ${dream.createdAt}, ${toJson(Dream, dream)})
              ON CONFLICT (id) DO UPDATE SET
                thread_id = excluded.thread_id,
                data = excluded.data`.pipe(Effect.asVoid),
          ),
        getDream: (id) =>
          run(
            sql<{ data: string }>`SELECT data FROM dreams WHERE id = ${id}`.pipe(
              Effect.flatMap((rows) =>
                rows[0] === undefined
                  ? Effect.succeed(undefined)
                  : readableRow(unreadable, "dreams", id, decodeStored(Dream, rows[0].data)),
              ),
              Effect.flatMap((dream) =>
                dream === undefined
                  ? Effect.fail(
                      new NotFound({
                        entity: "dream",
                        id,
                        message: "That dream no longer exists.",
                      }),
                    )
                  : Effect.succeed(dream),
              ),
            ),
          ),
        listDreams: (workspaceId) =>
          run(
            sql<{ id: string; data: string }>`SELECT id, data FROM dreams
              WHERE workspace_id = ${workspaceId} ORDER BY created_at DESC, rowid DESC`.pipe(
              Effect.flatMap((rows) =>
                readableRows(
                  unreadable,
                  "dreams",
                  rows,
                  (r) => r.id,
                  (r) => decodeStored(Dream, r.data),
                ),
              ),
            ),
          ),
        listRunningDreams: run(
          sql<{ id: string; data: string }>`SELECT id, data FROM dreams
            WHERE CASE WHEN json_valid(data) THEN json_extract(data, '$.status') = 'running'
              ELSE 1 END
            ORDER BY created_at, rowid`.pipe(
            Effect.flatMap((rows) =>
              readableRows(
                unreadable,
                "dreams",
                rows,
                (r) => r.id,
                (r) => decodeStored(Dream, r.data),
              ),
            ),
          ),
        ),
        removeDream: (id) => run(sql`DELETE FROM dreams WHERE id = ${id}`.pipe(Effect.asVoid)),

        listDreamWatermarks: (workspaceId, version) =>
          run(
            sql<{ thread_id: string; data: string }>`SELECT thread_id, data FROM dream_watermarks
              WHERE workspace_id = ${workspaceId} AND memory_version = ${version}
              ORDER BY thread_id`.pipe(
              Effect.flatMap((rows) =>
                readableRows(
                  unreadable,
                  "dream_watermarks",
                  rows,
                  (r) => `${workspaceId}/${version}/${r.thread_id}`,
                  (r) => decodeStored(DreamWatermark, r.data),
                ),
              ),
            ),
          ),
        putDreamWatermarks: (workspaceId, version, marks) =>
          tx(
            Effect.gen(function* () {
              yield* sql`DELETE FROM dream_watermarks
                WHERE workspace_id = ${workspaceId} AND memory_version = ${version}`;
              for (const mark of marks) {
                yield* sql`INSERT OR REPLACE INTO dream_watermarks
                  (workspace_id, memory_version, thread_id, data)
                  VALUES (${workspaceId}, ${version}, ${mark.threadId},
                    ${toJson(DreamWatermark, mark)})`;
              }
            }),
          ),
        forgetDreamThreads: (workspaceId, threadIds) =>
          tx(
            Effect.gen(function* () {
              for (const threadId of threadIds) {
                yield* sql`DELETE FROM dream_watermarks
                  WHERE workspace_id = ${workspaceId} AND thread_id = ${threadId}`;
              }
            }),
          ),
        pruneDreamWatermarks: (workspaceId, keep) =>
          tx(
            Effect.gen(function* () {
              const versions = yield* sql<{ memory_version: string }>`SELECT DISTINCT
                memory_version FROM dream_watermarks WHERE workspace_id = ${workspaceId}`;
              for (const { memory_version: version } of versions) {
                if (keep.includes(version)) continue;
                yield* sql`DELETE FROM dream_watermarks
                  WHERE workspace_id = ${workspaceId} AND memory_version = ${version}`;
              }
            }),
          ),

        getOutbox: (workspaceId) =>
          run(
            sql<{ data: string }>`SELECT data FROM orchestration_outbox
              WHERE workspace_id = ${workspaceId}`.pipe(Effect.map((rows) => rows[0]?.data)),
          ),
        putOutbox: (workspaceId, json) =>
          run(
            sql`INSERT INTO orchestration_outbox (workspace_id, data)
              VALUES (${workspaceId}, ${json})
              ON CONFLICT (workspace_id) DO UPDATE SET data = excluded.data`.pipe(Effect.asVoid),
          ),

        appendOrchestrationEvent: (workspaceId, entry) =>
          run(
            sql<{ seq: number }>`INSERT INTO orchestration_events (workspace_id, at, kind, data)
              VALUES (${workspaceId}, ${entry.at}, ${entry.kind},
                ${JSON.stringify(entry.data ?? null)})
              RETURNING seq`.pipe(Effect.map((rows) => Number(rows[0]!.seq))),
          ),
        listFeatureCards: (workspaceId) =>
          run(
            sql<{ data: string }>`SELECT data FROM feature_cards
              WHERE workspace_id = ${workspaceId}
              ORDER BY created_at, feature`.pipe(
              Effect.map((rows) =>
                rows.flatMap((row) => {
                  const decoded = decodeStored(FeatureCard, row.data);
                  return decoded.ok ? [decoded.value] : [];
                }),
              ),
            ),
          ),
        putFeatureCard: (card) =>
          run(
            sql`INSERT INTO feature_cards (workspace_id, feature, version, created_at, data)
              VALUES (${card.workspaceId}, ${card.feature}, ${card.version}, ${card.createdAt},
                ${toJson(FeatureCard, card)})
              ON CONFLICT (workspace_id, feature) DO UPDATE SET
                version = excluded.version, data = excluded.data`.pipe(Effect.asVoid),
          ),
        renameFeature: ({ workspaceId, holder, from, to, workspace, cards, outbox }) =>
          tx(
            Effect.gen(function* () {
              const state = yield* readWorkspace(workspaceId);
              const next = workspace(state);
              if (next.workspace.id !== workspaceId) {
                return yield* Effect.die(
                  new Error(`workspace ${workspaceId} cannot change its id`),
                );
              }
              yield* writeWorkspace(next);
              const rows =
                holder === undefined
                  ? []
                  : yield* sql<{ id: string }>`SELECT id FROM threads
                      WHERE json_extract(data, '$.spawnedBy.threadId') = ${holder}
                        AND json_extract(data, '$.spawnedBy.feature') = ${from}`;
              const renamed: Array<Thread> = [];
              for (const row of rows) {
                const thread = yield* readThread(row.id as ThreadId).pipe(
                  Effect.catchTag("ThreadNotFound", () => Effect.succeed(undefined)),
                );
                if (thread?.spawnedBy?.feature !== from) continue;
                const after: Thread = {
                  ...thread,
                  spawnedBy: { ...thread.spawnedBy, feature: to },
                };
                yield* writeThread(after);
                renamed.push(after);
              }
              for (const card of cards) {
                yield* sql`INSERT INTO feature_cards (workspace_id, feature, version, created_at, data)
                  VALUES (${card.workspaceId}, ${card.feature}, ${card.version}, ${card.createdAt},
                    ${toJson(FeatureCard, card)})
                  ON CONFLICT (workspace_id, feature) DO UPDATE SET
                    version = excluded.version, data = excluded.data`;
              }
              if (outbox !== undefined) {
                yield* sql`INSERT INTO orchestration_outbox (workspace_id, data)
                  VALUES (${workspaceId}, ${outbox})
                  ON CONFLICT (workspace_id) DO UPDATE SET data = excluded.data`;
              }
              return renamed as ReadonlyArray<Thread>;
            }),
          ),
        putFeatureCardSummary: (workspaceId, feature, summary) =>
          run(
            sql<{ feature: string }>`UPDATE feature_cards
              SET data = json_set(data, '$.summary', json(${toJson(FeatureCardSummary, summary)}))
              WHERE workspace_id = ${workspaceId} AND feature = ${feature}
                AND version = ${summary.version}
              RETURNING feature`.pipe(Effect.map((rows) => rows.length > 0)),
          ),
        updateSettingsAudited: (f, touched, audit) =>
          tx(
            Effect.gen(function* () {
              const next = f(yield* readSettings);
              if (next === undefined) return undefined;
              yield* writeSettings(next, touched);
              const auditSeq = yield* insertSettingsAudit(audit);
              return { settings: yield* readSettings, auditSeq };
            }),
          ),
        updateWorkspaceAudited: (id, f, audit, holds) =>
          tx(
            Effect.gen(function* () {
              if (holds !== undefined && !holds(yield* readSettings)) return undefined;
              const next = f(yield* readWorkspace(id));
              if (next === undefined) return undefined;
              if (next.workspace.id !== id) {
                return yield* Effect.die(new Error(`workspace ${id} cannot change its id`));
              }
              yield* writeWorkspace(next);
              const auditSeq = yield* insertSettingsAudit({ ...audit, workspaceId: id });
              return { state: next, auditSeq };
            }),
          ),
        putWorkspaceAudited: (state, audit) =>
          tx(
            Effect.gen(function* () {
              yield* writeWorkspace(state);
              const auditSeq = yield* insertSettingsAudit({
                ...audit,
                workspaceId: state.workspace.id,
              });
              return { auditSeq };
            }),
          ),
        listSettingsAudit: (limit) =>
          run(
            sql<{
              seq: number;
              at: number;
              thread_id: string;
              proposer_role: string;
              scope: string;
              workspace_id: string | null;
              project_id: string | null;
              request_id: string | null;
              approved_by: string;
              approved_at: number;
              changes: string;
              shown: string;
              reason: string | null;
            }>`SELECT * FROM settings_audit ORDER BY seq DESC LIMIT ${limit}`.pipe(
              Effect.map((rows) =>
                rows.map((r): SettingsAuditRecord => ({
                  seq: Number(r.seq),
                  at: Number(r.at),
                  threadId: r.thread_id as ThreadId,
                  proposerRole: r.proposer_role,
                  scope:
                    r.scope === "project"
                      ? "project"
                      : r.scope === "workspace"
                        ? "workspace"
                        : "app",
                  ...(r.project_id == null ? {} : { projectId: r.project_id as ProjectId }),
                  ...(r.workspace_id === null
                    ? {}
                    : { workspaceId: r.workspace_id as WorkspaceId }),
                  ...(r.request_id === null ? {} : { requestId: r.request_id }),
                  approvedBy: "user",
                  approvedAt: Number(r.approved_at),
                  changes: JSON.parse(r.changes) as SettingsAuditEntry["changes"],
                  shown: JSON.parse(r.shown) as SettingsAuditEntry["shown"],
                  ...(r.reason === null ? {} : { reason: r.reason }),
                })),
              ),
            ),
          ),
        listOrchestrationEvents: (workspaceId, since) =>
          run(
            sql<{ seq: number; at: number; kind: string; data: string }>`SELECT seq, at, kind, data
              FROM orchestration_events
              WHERE workspace_id = ${workspaceId} AND at >= ${since}
              ORDER BY seq`.pipe(
              Effect.map((rows) =>
                rows.map((r): OrchestrationEventRecord => ({
                  seq: Number(r.seq),
                  workspaceId,
                  at: Number(r.at),
                  kind: r.kind,
                  data: JSON.parse(r.data) as unknown,
                })),
              ),
            ),
          ),

        listStashes: (threadId) =>
          run(
            sql<{ id: string; data: string }>`SELECT id, data FROM draft_stashes
              WHERE thread_id = ${threadId} ORDER BY created_at DESC, rowid DESC`.pipe(
              Effect.flatMap((rows) =>
                readableRows(
                  unreadable,
                  "draft_stashes",
                  rows,
                  (r) => r.id,
                  (r) => decodeStored(DraftStash, r.data),
                ),
              ),
            ),
          ),
        putStash: (stash) =>
          tx(
            Effect.gen(function* () {
              // A retried add carries the same id: the first stored row wins.
              yield* sql`INSERT INTO draft_stashes (id, thread_id, created_at, data)
                VALUES (${stash.id}, ${stash.threadId}, ${stash.createdAt}, ${toJson(DraftStash, stash)})
                ON CONFLICT (id) DO NOTHING`;
              const dropped = yield* sql<{ id: string; data: string }>`SELECT id, data
                FROM draft_stashes WHERE thread_id = ${stash.threadId}
                ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ${DRAFT_STASH_LIMIT}`;
              // One that doesn't decode stays: the caller couldn't clear up its attachments.
              const gone = yield* readableRows(
                unreadable,
                "draft_stashes",
                dropped,
                (row) => row.id,
                (row) => decodeStored(DraftStash, row.data),
              );
              for (const { id } of gone) yield* sql`DELETE FROM draft_stashes WHERE id = ${id}`;
              return gone;
            }),
          ),
        takeStash: (threadId, stashId) =>
          tx(
            Effect.gen(function* () {
              const rows = yield* sql<{ data: string }>`SELECT data FROM draft_stashes
                WHERE id = ${stashId} AND thread_id = ${threadId}`;
              const stash =
                rows[0] === undefined
                  ? undefined
                  : yield* readableRow(
                      unreadable,
                      "draft_stashes",
                      stashId,
                      decodeStored(DraftStash, rows[0].data),
                    );
              if (stash === undefined) {
                return yield* new NotFound({ entity: "stash", id: stashId });
              }
              yield* sql`DELETE FROM draft_stashes WHERE id = ${stashId}`;
              return stash;
            }),
          ),

        listLabels: labels.list,
        upsertLabel: labels.upsert,
        removeLabel: labels.remove,
        listPalettes: palettes.list,
        upsertPalette: palettes.upsert,
        removePalette: palettes.remove,
        listProfiles: profiles.list,
        upsertProfile: profiles.upsert,
        removeProfile: profiles.remove,
      });
    }),
  );

  /**
   * A migrated SQLite database at `filename` (`:memory:` in tests). The server's database checkpoints its
   * WAL on a worker (`wal-checkpointer.ts`); the tests' leave that to SQLite, on the event loop.
   */
  static readonly layerSqlite = (
    filename: string,
    options: { readonly checkpointOffLoop?: boolean | undefined } = {},
  ): Layer.Layer<ThreadStore | SqlClient.SqlClient, unknown> => {
    // The server's own file only: an update seals it before main kills the rest (`update-seal.ts`).
    const seal = options.checkpointOffLoop === true ? UpdateSeal.layers(filename) : undefined;
    return ThreadStore.layerNoDeps.pipe(
      Layer.provideMerge(SearchCatchUp),
      Layer.provideMerge(MigrationsLayer),
      Layer.provideMerge(NormalSync),
      Layer.provideMerge(PageCache),
      Layer.provideMerge(
        options.checkpointOffLoop === true ? WalCheckpointer.layer(filename) : Layer.empty,
      ),
      Layer.provideMerge(seal?.over ?? Layer.empty),
      Layer.provideMerge(SqliteClient.layer({ filename })),
      Layer.provideMerge(seal?.under ?? Layer.empty),
    );
  };
}
