import type { StoredActor } from "../host/ownership.ts";
import {
  advanceDreamCursor,
  type DreamCursor,
  eventsAfter,
  readDreamCursor,
} from "./dream-cursor.ts";
import {
  applyProjectSettingsWrites,
  applySettingsPatch,
  CLOSED_THREADS_LIMIT,
  type ClosedThread,
  type CompletedReason,
  DEFAULT_SETTINGS,
  DRAFT_STASH_LIMIT,
  DraftStash,
  Dream,
  type DreamId,
  DreamWatermark,
  embeddingOn,
  FeatureCard,
  FeatureCardSummary,
  fieldsOf,
  GatewayProfile,
  type GitError,
  type GramUIMessage,
  hostOf,
  InvalidState,
  Label,
  type LabelId,
  normalizeThreadPrs,
  NotFound,
  Palette,
  type PaletteId,
  PendingRequest,
  PERSONAL_SETTINGS,
  personalSettingKey,
  PlanItem,
  type ProfileId,
  Project,
  ProjectId,
  ProjectLocalCheck,
  type PrWakeFired,
  type PrWatchSeen,
  type QueuedInput,
  type QueueItemId,
  type RequestId,
  SeenConnector,
  Settings,
  SettingsPatch,
  settingsPatchPaths,
  type SettingsWrite,
  splitSettingsPatch,
  type StashId,
  type TaskChipData,
  TaskChipDataSchema,
  type TaskId,
  Thread,
  ThreadId,
  ThreadNotFound,
  ThreadPlan,
  ThreadWake,
  TurnEndReason,
  TurnId,
  UIMessageSchema,
  type UsageOverview,
  type UsageOverviewQuery,
  UsageSummary,
  UserInput,
  type WaitId,
  WaitItem,
  type WakeConditionFired,
  type WakeConditionSeen,
  withoutPersonalSettings,
  WorkerReport,
  WorkspaceId,
  WorkspaceState,
} from "@gram/contracts";
import { projectRoot, projectRootKey } from "@gram/git";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { createHash, randomUUID } from "node:crypto";
import { SqlClient, SqlError } from "../platform/unstable.ts";
import { MigrationsLayer } from "./migrations.ts";
import { noteForeignCheckouts } from "../host/foreign-paths.ts";
import { pruneHistory } from "./history-prune.ts";
import { backfillProjectOrigins, originOfRow, originToRecord } from "./project-origins.ts";
import { notePrivacy, noteReaders } from "../embedding/readable-by.ts";
import { unlinkOrchestrationIn } from "./orchestration-links.ts";
import {
  type ClosedHolder,
  holderMachinesIn,
  notePrivateThreads,
  rememberHolderIn,
  rememberPrivateIn,
} from "./private-readers.ts";
import { isLockWait, SearchCatchUp } from "../search/catch-up.ts";
import { resolvedWait, waitRowsOf, type WaitResolution, type WaitRows } from "./wait-resolution.ts";
import * as UpdateSeal from "./update-seal.ts";
import * as WalCheckpointer from "./wal-checkpointer.ts";
import { captureReadWorker, layer as readWorkerLayer, withReadWorker } from "./read-worker.ts";
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
import { durableCommit, durableSqliteLayer } from "./durable-commit.ts";
import { makeMessageReceipts } from "./message-receipts.ts";
import { MergeFence, type PendingMerge } from "./merge-fence.ts";
import { DAY_MS } from "../zone-time.ts";
import * as Predicate from "effect/Predicate";

/**
 * `next` with `parkedAt` kept in step with `parked`: stamped `now` when an edit archives the thread,
 * kept while it stays archived, and dropped when it is unarchived. The worktree sweep counts an
 * archived worker's grace from it.
 */
export const stampParked = (before: Thread, next: Thread, now: number): Thread => {
  if (!next.parked) {
    if (next.parkedAt === undefined) return next;
    const { parkedAt: _, ...unparked } = next;
    return unparked;
  }
  if (!before.parked) return { ...next, parkedAt: now };
  return before.parkedAt === undefined || next.parkedAt !== undefined
    ? next
    : { ...next, parkedAt: before.parkedAt };
};

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

interface WorkerReportRecord {
  readonly seq: number;
  readonly report: WorkerReport;
}

/** One turn of a conversation that moves between two Grams; its file checkpoint stays behind. */
export interface MovedTurn {
  readonly id: TurnId;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly reason?: TurnEndReason;
  readonly usage?: UsageSummary;
}

/** A thread's conversation as it moves between two Grams. */
export interface MovedHistory {
  readonly messages: ReadonlyArray<{
    readonly message: GramUIMessage;
    readonly turnId?: TurnId;
  }>;
  readonly turns: ReadonlyArray<MovedTurn>;
}

/** A thread moved here from another Gram, with its conversation, as a closed thread to reopen. */
export interface MovedThread extends MovedHistory {
  /** The closed record a reopen opens: this server's project, checkout and mode. */
  readonly thread: Thread;
  readonly closedAt: number;
  readonly plan?: ThreadPlan | undefined;
  readonly turnPlan?: ReadonlyArray<PlanItem> | undefined;
}

/** What `stageMovedWorkspace` writes. */
export interface MovedWorkspace {
  /** As it is stored here: this server's project ids, and no orchestrator in the slot. */
  readonly state: WorkspaceState;
  readonly orchestrator?: MovedThread | undefined;
  readonly featureCards: ReadonlyArray<FeatureCard>;
  readonly events: ReadonlyArray<OrchestrationEventEntry>;
  /** The encoded outbox its first digest here is built from. */
  readonly outbox: string;
}

interface LatestWorkerReport {
  readonly report: WorkerReport;
  readonly interface?: string | undefined;
}

interface OrchestrationEventEntry {
  readonly at: number;
  readonly kind: string;
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

interface FeedRevision {
  readonly rev: number;
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

/** A message with what its row says of it: its place in the thread, revision, role and turn. */
export interface StoredMessage extends SeqMessage {
  readonly rev: number;
  readonly role: string;
  readonly turnId?: string;
}

/** Which page of a thread's user messages `userMessagePage` reads. */
export interface UserMessagePage {
  readonly from: "newest" | "oldest";
  readonly limit: number;
  /** The `next` of the page before; the first page leaves it out. */
  readonly after?: number | undefined;
}

/** One page of a thread's user messages, in the order read. */
export interface UserMessagesRead {
  readonly messages: ReadonlyArray<SeqMessage>;
  /** Where the next page starts; `undefined` when this one reached the end. */
  readonly next: number | undefined;
}

/** What `findUserMessages` looks for. */
export interface UserMessageQuery {
  /** Which end it reads from. */
  readonly from: "newest" | "oldest";
  /** How many it wants; it stops reading once it has them. */
  readonly count: number;
  /** Which count, called in reading order; every message when left out. */
  readonly keep?: ((message: GramUIMessage) => boolean) | undefined;
  /** Where to stop short of `count`, called in reading order: that message and the rest are left. */
  readonly until?: ((message: GramUIMessage) => boolean) | undefined;
}

const USER_PAGE_FIRST = 16;
const USER_PAGE_FIRST_MAX = 64;
const USER_PAGE_MAX = 512;

/**
 * The first `count` of a thread's user messages that `keep` takes, read from its newest or its
 * oldest, in seq order. It reads pages of growing size and stops once it has them, so the newest of
 * a long orchestrator's thousands is found without decoding the rest.
 */
export const findUserMessages = (
  store: Pick<ThreadStoreShape, "userMessagePage">,
  threadId: ThreadId,
  query: UserMessageQuery,
): Effect.Effect<ReadonlyArray<GramUIMessage>> =>
  Effect.gen(function* () {
    const found: Array<GramUIMessage> = [];
    let after: number | undefined;
    let limit = Math.min(Math.max(query.count, USER_PAGE_FIRST), USER_PAGE_FIRST_MAX);
    let done = false;
    while (!done && found.length < query.count) {
      const page = yield* store.userMessagePage(threadId, { from: query.from, limit, after });
      for (const { message } of page.messages) {
        if (query.until !== undefined && query.until(message)) {
          done = true;
          break;
        }
        if (query.keep !== undefined && !query.keep(message)) continue;
        found.push(message);
        if (found.length >= query.count) break;
      }
      if (page.next === undefined) break;
      after = page.next;
      limit = Math.min(limit * 2, USER_PAGE_MAX);
    }
    return query.from === "newest" ? found.toReversed() : found;
  });

/** One thing a signed-in person did (`actor_events`). */
export interface ActorEventEntry {
  readonly at: number;
  readonly actor: {
    readonly id: string;
    readonly name: string;
    readonly role: string;
  };
  /** The call that did it, by its RPC tag (`thread.send`, `settings.set`). */
  readonly action: string;
  readonly threadId?: string | undefined;
  readonly workspaceId?: string | undefined;
  /** What else identifies it: ids and names of what changed, never what was typed. */
  readonly data: Readonly<Record<string, unknown>>;
}

export interface ActorEventRecord extends ActorEventEntry {
  readonly seq: number;
}

const RESOLVED_WAITS_KEPT_MS = 30 * DAY_MS;

/** A thread's plan and the agent's latest todo list, as `thread_plans` keeps them. */
export interface ThreadPlanRecord {
  readonly plan: ThreadPlan | undefined;
  readonly turnPlan: ReadonlyArray<PlanItem> | undefined;
}

const TurnPlanJson = Schema.Array(PlanItem);

const samePrRef = (
  a: { readonly repo: string; readonly number: number },
  b: { readonly repo: string; readonly number: number },
) => a.number === b.number && a.repo.toLowerCase() === b.repo.toLowerCase();

const recordClaims = (thread: Thread, pending: PendingMerge) =>
  (thread.boundPr !== undefined && samePrRef(thread.boundPr, pending.pr)) ||
  (pending.branch !== undefined &&
    ([thread.checkout, ...(thread.extraCheckouts ?? [])].some(
      (checkout) => checkout.branch === pending.branch,
    ) ||
      (thread.ownedBranches ?? []).some((owned) => owned.branch === pending.branch)));

/** Authority facts read in the same transaction as a guarded thread edit. */
export interface ThreadUpdateContext {
  readonly caller: Thread | undefined;
  readonly workspace: WorkspaceState | undefined;
  readonly settings: Settings;
  /**
   * Whether another unparked thread binds the PR `updateThread`'s `claimScan` named, read in the
   * write's own transaction; absent when no `claimScan` was asked. The autonomy arm reads it to
   * refuse an autonomous intent when a sibling's `pr_bind` committed since its ownership check.
   */
  readonly prClaimedByOther?: boolean;
}

/** Trusted server plan; mutation revalidates its stored target and checkout. */
export interface HistoryRewind {
  readonly messageId: string;
  readonly role: GramUIMessage["role"];
  readonly turnId: TurnId | undefined;
  readonly cwd: string;
  readonly resumeAt: string | undefined;
}

/**
 * A queued input as the store keeps it: with who it was written for (`host/ownership.ts`), which
 * stays on the server; clients see the `QueuedInput` alone. Absent in rows written before.
 */
export type StoredQueuedInput = QueuedInput & { readonly actor?: StoredActor };

const StoredActorJson = Schema.Union([
  Schema.Literal("server"),
  Schema.Struct({ person: Schema.optionalKey(Schema.String) }),
]);

export interface ThreadStoreShape {
  readonly messageReceipt: ReturnType<typeof makeMessageReceipts>;
  usageOverview(
    query: UsageOverviewQuery,
    history?: UsageHistoryInput,
  ): Effect.Effect<UsageOverview, InvalidState>;
  ensureProject(input: { root: string; name: string; repoRoot?: string }): Effect.Effect<Project>;
  /** `ensureProject`, saying whether this call inserted the row: one transaction decides both. */
  /** Records the identity of the folder's `origin` as it is now (`Project.originIdentity`). */
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
  /** Records the user's answer about the project's own agent settings and scripts. */
  setProjectFolderTrust(id: ProjectId, trusted: boolean): Effect.Effect<Project, NotFound>;
  /** Removes a project from the recents; refused while any thread belongs to it. */
  forgetProject(id: ProjectId): Effect.Effect<void, NotFound | InvalidState>;

  /**
   * Stores a new thread; returns it as stamped, which is the one to publish. One that would claim a
   * PR another thread's launch has reserved is stored archived until it settles
   * (`holdForReservations`).
   */
  insertThread(thread: Thread): Effect.Effect<Thread>;
  /**
   * Sets who else may read each of `ids`, open or closed, beside its person (`Thread.readers`):
   * the embedding host's change, the only write that changes them. Empty clears them. A thread
   * that isn't there, or has no `readableBy`, is left as it is; the answer is the ids changed.
   */
  setThreadReaders(
    ids: ReadonlyArray<ThreadId>,
    readers: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<ThreadId>>;
  getThread(id: ThreadId): Effect.Effect<Thread, ThreadNotFound>;
  /** Read-only authority snapshot from one transaction, for the final check after provider I/O. */
  getThreadWithAuthority(
    id: ThreadId,
    callerId: ThreadId,
  ): Effect.Effect<
    { readonly thread: Thread; readonly context: ThreadUpdateContext },
    ThreadNotFound
  >;
  listMergeFences: Effect.Effect<ReadonlyArray<MergeFence>>;
  putMergeFence(fence: MergeFence): Effect.Effect<void>;
  /**
   * Writes the launch-reservation `fence` only while no thread other than `excluding` binds `pr`,
   * scanned in the same transaction; `false` (nothing written) when one does. Closes the bind race
   * at the launch fence: a competing `pr_bind` committed since the launch's last conflict scan is
   * seen here, where a separate final scan would still race the commit.
   */
  reserveMergeFence(
    fence: MergeFence,
    pr: { readonly repo: string; readonly number: number },
    excluding: ThreadId,
    authorized?: (thread: Thread | undefined, context: ThreadUpdateContext | undefined) => boolean,
    authorityCaller?: ThreadId,
  ): Effect.Effect<boolean>;
  /** Re-check authority and exact pending attempt atomically with its FULL commit. */
  reconcileMergeFence(
    fence: MergeFence,
    expected: PendingMerge,
    caller: ThreadId,
    authorized: (thread: Thread | undefined, context: ThreadUpdateContext | undefined) => boolean,
  ): Effect.Effect<boolean>;
  listThreads: Effect.Effect<ReadonlyArray<Thread>>;
  /**
   * Every thread as a claim check reads them, failing closed: the rows that decode, and the ids of
   * unparked rows that don't (`unknown`), which a conflict check must count as a claim. Parked rows
   * that don't decode are `unknownParked`, for a check that archived threads count for too.
   */
  listThreadsForClaims: Effect.Effect<{
    readonly threads: ReadonlyArray<Thread>;
    readonly unknown: ReadonlyArray<ThreadId>;
    readonly unknownParked: ReadonlyArray<ThreadId>;
  }>;
  updateThread(
    id: ThreadId,
    f: (thread: Thread, context?: ThreadUpdateContext) => Thread,
    authorityCaller?: ThreadId,
    claimScan?: { readonly pr: { readonly repo: string; readonly number: number } },
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

  listQueue(threadId: ThreadId): Effect.Effect<ReadonlyArray<StoredQueuedInput>>;
  /** Replaces the thread's persisted queue, in order. */
  putQueue(threadId: ThreadId, queue: ReadonlyArray<StoredQueuedInput>): Effect.Effect<void>;
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
  /** Where a workspace's last closed orchestrator ran (`private-readers.ts` `holderMachinesIn`). */
  closedHolderOf(workspaceId: WorkspaceId): Effect.Effect<ClosedHolder>;
  /**
   * Takes the newest closed thread that reads off the list, with `closedWorkers`, in one
   * transaction, so two reopens at once take two entries, never the same one twice.
   */
  takeNewestClosed: Effect.Effect<
    { readonly closed: ClosedThread; readonly workers: ReadonlyArray<ClosedWorker> } | undefined
  >;
  /** `takeNewestClosed` of one thread by its id; `undefined` when it isn't on the list or can't be read. */
  takeClosed(
    threadId: ThreadId,
  ): Effect.Effect<
    { readonly closed: ClosedThread; readonly workers: ReadonlyArray<ClosedWorker> } | undefined
  >;

  listMessages(threadId: ThreadId): Effect.Effect<ReadonlyArray<GramUIMessage>>;
  /**
   * Up to `limit` of the thread's user messages from its newest or its oldest, past `after` (the
   * `next` of the page before), with their seqs, in the order read. None of the replies between
   * them is read. `next` is `undefined` once nothing is left; `findUserMessages` walks the pages.
   */
  userMessagePage(threadId: ThreadId, page: UserMessagePage): Effect.Effect<UserMessagesRead>;
  /**
   * The thread's messages whose stored form holds any of `needles`, in order; only those messages
   * are decoded, and with `role` only those in it are read. For checking that a path, or a text Gram
   * sent, is in the conversation.
   */
  messagesWith(
    threadId: ThreadId,
    needles: ReadonlyArray<string>,
    role?: "user",
  ): Effect.Effect<ReadonlyArray<GramUIMessage>>;
  /**
   * The thread's messages with a part of one of `types`, in order; only those messages are read and
   * decoded. A reply that is streaming now can be missing its newest parts for a few seconds (see
   * `message_parts` in migration 0006), so callers add the open replies themselves.
   */
  messagesWithParts(
    threadId: ThreadId,
    types: ReadonlyArray<GramUIMessage["parts"][number]["type"]>,
  ): Effect.Effect<ReadonlyArray<GramUIMessage>>;
  /** The thread's first `count` messages, in order, reading none after them. */
  firstMessages(threadId: ThreadId, count: number): Effect.Effect<ReadonlyArray<GramUIMessage>>;
  /** The thread's last `count` messages, in order, reading none before them. */
  lastMessages(threadId: ThreadId, count: number): Effect.Effect<ReadonlyArray<GramUIMessage>>;
  /** Every message stored for one turn, its input and its whole reply, in order. */
  turnMessages(threadId: ThreadId, turnId: TurnId): Effect.Effect<ReadonlyArray<GramUIMessage>>;
  /** How many messages the thread has, reading none of them. */
  messageCount(threadId: ThreadId): Effect.Effect<number>;
  /** Whether the thread has a message, or one in `role`, reading and decoding none of them. */
  hasMessages(threadId: ThreadId, role?: GramUIMessage["role"]): Effect.Effect<boolean>;
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
  /**
   * The thread's stored messages with their rows' own columns, in thread order: the one
   * `messageId` names, or else up to `limit` of those after place `afterSeq`.
   */
  storedMessages(
    threadId: ThreadId,
    select: { readonly messageId: string } | { readonly afterSeq: number; readonly limit: number },
  ): Effect.Effect<ReadonlyArray<StoredMessage>>;
  getMessageTurn(
    threadId: ThreadId,
    messageId: string,
  ): Effect.Effect<
    { readonly role: GramUIMessage["role"]; readonly turnId: TurnId | undefined } | undefined
  >;
  /**
   * Who typed the thread's latest message a person typed (`metadata.sentBy`): `undefined` where
   * nobody was signed in to say, or no person has written in the thread.
   */
  lastSender(threadId: ThreadId): Effect.Effect<string | undefined>;
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
   * revision the write took. A `streaming` save leaves the message's search index row and its part
   * types (`messagesWithParts`) as they were, for a later save, `refreshSearch` or the startup sweep
   * to refresh (`messageSearchPending`).
   */
  upsertMessage(
    threadId: ThreadId,
    message: GramUIMessage,
    turnId?: TurnId,
    options?: { readonly streaming?: boolean },
  ): Effect.Effect<number>;
  /**
   * Brings the message's search index row and part types up to its stored text, if a `streaming`
   * save left them behind. Writes nothing else, so the feed revision doesn't move. `false` when another
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
   * A live thread's conversation as stored, for a move to another Gram: its messages in order, each
   * with the turn it was written in, and its turns with what each used.
   */
  exportHistory(threadId: ThreadId): Effect.Effect<MovedHistory>;
  /**
   * Ends every turn still open as `interrupted` at `endedAt` (or its start, if later) and returns
   * them. Only for boot, when no agent process is left to own one, but those of the threads in
   * `except`, whose agent a host kept running after Gram quit still runs.
   */
  closeOpenTurns(
    endedAt: number,
    except?: ReadonlySet<ThreadId>,
  ): Effect.Effect<ReadonlyArray<TurnRecord>>;
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
  /**
   * Keeps what a pending wake's condition last saw, or the look that found it met; answers whether
   * it did, which it doesn't for a wake that is gone, on no condition, or found met already.
   */
  updateThreadWakeCondition(
    id: string,
    change: { readonly seen?: WakeConditionSeen; readonly fired?: WakeConditionFired },
  ): Effect.Effect<boolean>;
  /** Removes the thread's wake `id`, or with no `id` all of them, and answers those removed. */
  removeThreadWakes(
    threadId: ThreadId,
    id: string | undefined,
  ): Effect.Effect<ReadonlyArray<ThreadWake>>;

  putTask(threadId: ThreadId, messageId: string, task: TaskChipData): Effect.Effect<void>;
  getTask(threadId: ThreadId, taskId: TaskId): Effect.Effect<TaskRecord, NotFound>;

  /**
   * The thread's Waiting on you items, oldest first: the open ones, or with `all` the resolved ones
   * kept too, or with `deleted` only those deleted (`WaitItem.deletedAt`), which neither of the
   * others answers. A row that doesn't decode is left out.
   */
  listWaits(threadId: ThreadId, which?: WaitRows): Effect.Effect<ReadonlyArray<WaitItem>>;
  /** The thread's items resolved at or after `since` (epoch ms), oldest first, deleted ones aside. */
  listResolvedWaits(threadId: ThreadId, since: number): Effect.Effect<ReadonlyArray<WaitItem>>;
  getWait(threadId: ThreadId, id: WaitId): Effect.Effect<WaitItem, NotFound>;
  /**
   * Adds an item, or replaces the one with its id. `toldAt` is when the agent learned of it as it
   * now is, the agent having written it; absent, the agent hasn't, and it is news (`listWaitNews`).
   */
  putWait(threadId: ThreadId, item: WaitItem, toldAt?: number): Effect.Effect<void>;
  /** Replaces an item as stored, leaving when the agent last heard of it as it was. */
  replaceWait(threadId: ThreadId, item: WaitItem): Effect.Effect<void>;
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
  /**
   * The settings an embedding deployment supplies (`settings/supplied.ts`), kept beside the
   * settings under their own key. While the hosted features are on they are applied over every
   * read and every write of the settings, so nothing inside can change what they set.
   */
  getSuppliedSettings: Effect.Effect<SettingsPatch | undefined>;
  /** Replaces what is supplied, `undefined` for nothing; answers the settings as they now read. */
  putSuppliedSettings(patch: SettingsPatch | undefined): Effect.Effect<Settings>;
  /**
   * The settings as `person` reads them: the shared settings, their own view laid over them
   * (`PERSONAL_SETTINGS`, kept per person in `person_settings`), and what is supplied over both.
   * A personal setting is read from the person's own rows only, never from the shared row.
   */
  getSettingsFor(person: string): Effect.Effect<Settings>;
  /**
   * Writes the personal settings `patch` names for `person`, `null` clearing one, and nothing
   * else of it; answers the settings as that person now reads them.
   */
  putPersonSettings(person: string, patch: SettingsPatch): Effect.Effect<Settings>;
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
   * A workspace moved here from another Gram, written in one transaction or not at all: its row
   * with nobody holding the slot, its feature cards, audit and outbox, and its orchestrator as a
   * closed thread with its conversation, for a reopen to open. `InvalidState` when the workspace,
   * the thread or one of its turns is already here: nothing of this server's is ever replaced.
   */
  stageMovedWorkspace(moved: MovedWorkspace): Effect.Effect<void, InvalidState>;
  /**
   * One thread moved here from another Gram (`thread.transfer.import`), written in one
   * transaction or not at all, as a closed thread with its conversation for a reopen to open.
   * `InvalidState` when the thread or one of its turns is already here.
   */
  stageMovedThread(moved: MovedThread): Effect.Effect<void, InvalidState>;
  /**
   * A thread coming back here (`thread.transfer.import` of a thread that moved from here): it takes
   * the place of its read-only copy, which must be on the closed list, in one transaction or not
   * at all. The copy's messages and turns the bundle no longer carries stay, ahead of the bundle's,
   * so nothing the copy held is lost. `InvalidState` when the copy isn't there, the thread is open
   * here, or one of the bundle's turns is another thread's.
   */
  returnMovedThread(moved: MovedThread): Effect.Effect<void, InvalidState>;
  /** Why `stageMovedThread` would refuse these ids, read without writing; `undefined` when none is here. */
  movedThreadConflict(
    threadId: string,
    turnIds: ReadonlyArray<string>,
  ): Effect.Effect<string | undefined>;
  /**
   * Why `stageMovedWorkspace` would refuse these ids, read without writing anything, so a move
   * can be refused before its files are written; `undefined` when none of them is here.
   */
  movedConflict(
    workspaceId: string,
    threadId: string | undefined,
    turnIds: ReadonlyArray<string>,
  ): Effect.Effect<string | undefined>;
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

  /**
   * Appends what a signed-in person did, in the order given and in one transaction, and returns
   * the last entry's sequence number (0 for none).
   */
  appendActorEvents(entries: ReadonlyArray<ActorEventEntry>): Effect.Effect<number>;
  /** What signed-in people did after `afterSeq`, oldest first, at most `limit` (1,000 at most). */
  listActorEvents(options?: {
    readonly afterSeq?: number;
    readonly limit?: number;
  }): Effect.Effect<ReadonlyArray<ActorEventRecord>>;
  /**
   * The name each of `ids` last signed in under (`actor_events`), for those who ever have. A
   * person known only by an embedder's start has no name here.
   */
  personNames(ids: ReadonlyArray<string>): Effect.Effect<ReadonlyMap<string, string>>;
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
    holds?: (settings: Settings) => boolean,
  ): Effect.Effect<
    { readonly state: WorkspaceState; readonly auditSeq: number } | undefined,
    NotFound
  >;
  /**
   * A workspace made or changed by chat, all of it or nothing, in one transaction: the
   * repositories it takes in registered as projects where Gram doesn't know them, the workspace
   * as `next` makes it, and its audit with the workspace's own `settings` event. `unchanged` reads
   * what is stored now (absent for a new workspace); when it answers `false`, or `holds` does,
   * nothing is written, the projects included, and the answer is `undefined`.
   */
  commitWorkspaceAudited(change: {
    readonly id: WorkspaceId;
    readonly unchanged: (current: WorkspaceState | undefined) => boolean;
    /** At their canonical roots, in the order `next` receives their projects. */
    readonly register: ReadonlyArray<{ readonly root: string; readonly name: string }>;
    /** The root each known project had when its folder was checked; it must still have it. */
    readonly roots?: Readonly<Record<string, string>>;
    readonly next: (
      current: WorkspaceState | undefined,
      projects: ReadonlyArray<Project>,
    ) => WorkspaceState;
    readonly audit: (state: WorkspaceState) => SettingsAuditEntry;
    /** Read against the app settings in the same transaction; `false` writes nothing. */
    readonly holds?: (settings: Settings) => boolean;
  }): Effect.Effect<
    | {
        readonly state: WorkspaceState;
        readonly auditSeq: number;
        readonly projects: ReadonlyArray<Project>;
      }
    | undefined,
    NotFound
  >;
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

  /** The workspace's orchestration events past `afterSeq` of the `kinds` given, oldest first. */
  listOrchestrationEventsAfter(
    workspaceId: WorkspaceId,
    afterSeq: number,
    kinds: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<OrchestrationEventRecord>>;
  /** Where the workspace's next memory update reads on from; absent: from its start. */
  getDreamCursor(workspaceId: WorkspaceId): Effect.Effect<DreamCursor | undefined>;
  /** Moves the cursor on to `cursor`, field by field; it never moves back. */
  advanceDreamCursor(workspaceId: WorkspaceId, cursor: DreamCursor): Effect.Effect<void>;

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

const ThreadWakePr = Schema.Struct({
  onPr: ThreadWake.fields.onPr,
  on: ThreadWake.fields.on,
  seen: ThreadWake.fields.seen,
  fired: ThreadWake.fields.fired,
  conditionState: ThreadWake.fields.conditionState,
});

const threadWakePrJson = (wake: ThreadWake): string | null =>
  wake.onPr === undefined && wake.conditionState === undefined
    ? null
    : toJson(ThreadWakePr, {
        ...(wake.onPr === undefined ? {} : { onPr: wake.onPr }),
        ...(wake.on === undefined ? {} : { on: wake.on }),
        ...(wake.seen === undefined ? {} : { seen: wake.seen }),
        ...(wake.fired === undefined ? {} : { fired: wake.fired }),
        ...(wake.conditionState === undefined ? {} : { conditionState: wake.conditionState }),
      });

const alreadyHere = (message: string) => new InvalidState({ message });

const roleOf = (role: string): GramUIMessage["role"] =>
  role === "user" || role === "system" ? role : "assistant";
const isCompletedReason = Schema.is(CompletedReason);
const completedReasonOf = (reason: string | null | undefined) =>
  isCompletedReason(reason) ? reason : undefined;
const isTurnEndReason = Schema.is(TurnEndReason);
const turnEndReasonOf = (reason: string | null | undefined) =>
  isTurnEndReason(reason) ? reason : undefined;

const toJson = <S extends Schema.Top>(schema: S, value: S["Type"]): string =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- stored values are JSON, so any stored schema encodes to unknown
  JSON.stringify(Schema.encodeSync(schema as unknown as Schema.Codec<S["Type"], unknown>)(value));

const ENCODED_DEFAULT_SETTINGS = Schema.encodeSync(Settings)(DEFAULT_SETTINGS);

const bool = (n: number | bigint | null | undefined) => Number(n ?? 0) !== 0;

const CACHE_SIZE_KIB = 16_384;

const MMAP_SIZE_BYTES = 64 * 1024 * 1024;

const configurePageCache = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql.unsafe(`PRAGMA cache_size = -${CACHE_SIZE_KIB}`);
    yield* sql.unsafe(`PRAGMA mmap_size = ${MMAP_SIZE_BYTES}`);
  });

const WORKSPACE_MOVED = { _tag: "WorkspaceMoved" } as const;

const keepReader = (before: Thread, next: Thread): Thread =>
  keepReaders(before, keepPerson(before, keepReaderOnly(before, next)));

const keepReaders = (before: Thread, next: Thread): Thread => {
  if (next.readers === before.readers) return next;
  if (before.readers === undefined) {
    const { readers: _, ...rest } = next;
    return rest;
  }
  return { ...next, readers: before.readers };
};

const keepReaderOnly = (before: Thread, next: Thread): Thread => {
  if (next.readableBy === before.readableBy) return next;
  if (before.readableBy === undefined) {
    const { readableBy: _, ...rest } = next;
    return rest;
  }
  return { ...next, readableBy: before.readableBy };
};

const keepPerson = (before: Thread, next: Thread): Thread => {
  if (next.startedBy === before.startedBy) return next;
  if (before.startedBy === undefined) {
    const { startedBy: _, ...rest } = next;
    return rest;
  }
  return { ...next, startedBy: before.startedBy };
};

/** The most people one `personNames` call looks up. */
export const PERSON_NAMES_MAX = 200;

const run = <A, E, R>(
  effect: Effect.Effect<A, E | SqlError, R>,
): Effect.Effect<A, Exclude<E, SqlError>, R> =>
  effect.pipe(
    Effect.catch((e) =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- TypeScript can't narrow a generic E by instanceof
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
      const reads = withReadWorker(yield* captureReadWorker);
      const unreadable = makeUnreadableLog();
      yield* notePrivateThreads(sql);
      yield* run(backfillProjectOrigins(sql));
      const receiptScope = yield* Effect.scope;
      const tx = <A, E, R>(effect: Effect.Effect<A, E, R>) => run(sql.withTransaction(effect));
      const commitReservation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        durableCommit(sql, effect);

      const durableFence = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        run(durableCommit(sql, effect));
      const writeMergeFence = (fence: MergeFence) =>
        sql`INSERT INTO merge_fences (key, data)
        VALUES (${fence.key}, ${toJson(MergeFence, fence)})
        ON CONFLICT (key) DO UPDATE SET data = excluded.data`.pipe(Effect.asVoid);

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

      const purgeHistory = (id: string) =>
        Effect.gen(function* () {
          yield* sql`DELETE FROM closed_messages WHERE thread_id = ${id}`;
          yield* sql`DELETE FROM closed_turns WHERE thread_id = ${id}`;
          yield* sql`DELETE FROM message_receipts WHERE thread_id = ${id}
            AND thread_id NOT IN (SELECT id FROM threads)
            AND thread_id NOT IN (SELECT thread_id FROM closed_threads)`;
          yield* sql`DELETE FROM worker_reports WHERE thread_id = ${id}
            AND thread_id NOT IN (SELECT id FROM threads)`;
          yield* sql`DELETE FROM thread_plans WHERE thread_id = ${id}
            AND thread_id NOT IN (SELECT id FROM threads)`;
        });

      const movedThreadConflictOf = (
        threadId: string,
        turnIds: ReadonlyArray<string>,
        whose: string,
      ) =>
        Effect.gen(function* () {
          const [taken] = yield* sql<{ id: string }>`SELECT id FROM threads WHERE id = ${threadId}
            UNION ALL SELECT thread_id FROM closed_threads WHERE thread_id = ${threadId}
            UNION ALL SELECT thread_id FROM closed_messages WHERE thread_id = ${threadId}
            UNION ALL SELECT thread_id FROM messages WHERE thread_id = ${threadId}
            UNION ALL SELECT thread_id FROM thread_plans WHERE thread_id = ${threadId}
            LIMIT 1`;
          if (taken !== undefined) return `${whose} is already on this server.`;
          for (const turnId of turnIds) {
            const [known] = yield* sql<{ id: string }>`SELECT id FROM turns WHERE id = ${turnId}
              UNION ALL SELECT id FROM closed_turns WHERE id = ${turnId} LIMIT 1`;
            if (known !== undefined) {
              return `A turn of ${whose.charAt(0).toLowerCase()}${whose.slice(1)} is already on this server.`;
            }
          }
          return undefined;
        });

      const movedConflictOf = (
        workspaceId: string,
        threadId: string | undefined,
        turnIds: ReadonlyArray<string>,
      ) =>
        Effect.gen(function* () {
          const [workspace] = yield* sql<{
            id: string;
          }>`SELECT id FROM workspaces WHERE id = ${workspaceId}`;
          if (workspace !== undefined) return "This workspace is already on this server.";
          if (threadId === undefined) return undefined;
          return yield* movedThreadConflictOf(threadId, turnIds, "This workspace's orchestrator");
        });

      const writeMovedClosed = (moved: MovedThread) =>
        Effect.gen(function* () {
          const threadId = moved.thread.id;
          yield* sql`INSERT INTO closed_threads (thread_id, closed_at, data, workers)
            VALUES (${threadId}, ${moved.closedAt}, ${toJson(Thread, moved.thread)}, NULL)`;
          for (const [index, { message, turnId }] of moved.messages.entries()) {
            yield* sql`INSERT INTO closed_messages
                (thread_id, id, seq, role, turn_id, message)
              VALUES (${threadId}, ${message.id}, ${index + 1}, ${message.role},
                ${turnId ?? null}, ${JSON.stringify(message)})`;
          }
          for (const turn of moved.turns) {
            yield* sql`INSERT INTO closed_turns
                (id, thread_id, started_at, ended_at, reason, usage, cost_usd)
              VALUES (${turn.id}, ${threadId}, ${turn.startedAt}, ${turn.endedAt ?? null},
                ${turn.reason ?? null},
                ${turn.usage === undefined ? null : toJson(UsageSummary, turn.usage)},
                ${turn.usage?.costUsd ?? null})`;
          }
          const plan = moved.plan === undefined ? null : toJson(ThreadPlan, moved.plan);
          const turnPlan =
            moved.turnPlan === undefined ? null : toJson(TurnPlanJson, moved.turnPlan);
          if (plan !== null || turnPlan !== null) {
            yield* sql`INSERT INTO thread_plans (thread_id, plan, turn_plan, rev)
              VALUES (${threadId}, ${plan}, ${turnPlan}, 1)`;
          }
        });

      const rememberPrivate = (table: "threads" | "closed_threads", ids: ReadonlyArray<string>) =>
        rememberPrivateIn(sql, table, ids);

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
            yield* rememberPrivate("closed_threads", [evictedId]);
            yield* sql`DELETE FROM closed_threads WHERE thread_id = ${evictedId}`;
            yield* purgeHistory(evictedId);
          }
        });

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
          yield* sql`DELETE FROM message_receipts
            WHERE thread_id NOT IN (SELECT id FROM threads)
              AND thread_id NOT IN (SELECT thread_id FROM closed_threads)`;
          yield* sql`DELETE FROM wait_items
            WHERE resolved_at < ${Date.now() - RESOLVED_WAITS_KEPT_MS}`;
        }),
      );
      yield* pruneHistory(sql, Date.now());

      interface StoredMessageRow {
        readonly id: string;
        readonly seq: number;
        readonly rev: number;
        readonly role: string;
        readonly turn_id: string | null;
        readonly message: string;
      }

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

      const writeWait = (threadId: ThreadId, item: WaitItem, toldAt: number | null | undefined) =>
        (toldAt === undefined
          ? sql`INSERT INTO wait_items
                (thread_id, id, message_id, created_at, resolved_at, person, item)
              VALUES (${threadId}, ${item.id}, ${item.messageId ?? null}, ${item.createdAt},
                ${item.resolvedAt ?? null}, ${item.person ?? null}, ${toJson(WaitItem, item)})
              ON CONFLICT (thread_id, id) DO UPDATE SET message_id = excluded.message_id,
                resolved_at = excluded.resolved_at, item = excluded.item`
          : sql`INSERT INTO wait_items
                (thread_id, id, message_id, created_at, resolved_at, told_at, person, item)
              VALUES (${threadId}, ${item.id}, ${item.messageId ?? null}, ${item.createdAt},
                ${item.resolvedAt ?? null}, ${toldAt}, ${item.person ?? null},
                ${toJson(WaitItem, item)})
              ON CONFLICT (thread_id, id) DO UPDATE SET message_id = excluded.message_id,
                resolved_at = excluded.resolved_at, told_at = excluded.told_at,
                item = excluded.item`
        ).pipe(Effect.asVoid);

      const toldAtOf = (threadId: ThreadId, id: WaitId) =>
        sql<{ told_at: number | null }>`SELECT told_at FROM wait_items
          WHERE thread_id = ${threadId} AND id = ${id}`.pipe(
          Effect.map((rows) => rows[0]?.told_at ?? null),
        );

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
                ...(pr?.value.conditionState === undefined
                  ? {}
                  : { condition: pr.value.conditionState.spec }),
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
        folder_trust?: string | null;
        origin_identity?: string | null;
      }
      const toProject = (r: ProjectRow): Project => {
        const decoded =
          r.local_check == null
            ? undefined
            : decodeStored(ProjectLocalCheck, r.local_check, { onExcessProperty: "error" });
        return Schema.decodeUnknownSync(Project)({
          id: r.id,
          root: r.root,
          name: r.name,
          ...(r.repo_root === null ? {} : { repoRoot: r.repo_root }),
          ...originOfRow(r.origin_identity),
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
          ...(r.folder_trust === "trusted" || r.folder_trust === "untrusted"
            ? { folderTrust: r.folder_trust }
            : {}),
          ...(r.last_opened_at === null ? {} : { lastOpenedAt: Number(r.last_opened_at) }),
        });
      };

      const projectAt = (root: string) =>
        sql<ProjectRow>`SELECT * FROM projects`.pipe(
          Effect.map((rows) => {
            const key = projectRootKey(root);
            return rows.find((row) => projectRootKey(row.root) === key);
          }),
        );

      type Registering = Parameters<ThreadStoreShape["registerProject"]>[0];
      const originFor = (input: Registering) =>
        run(projectAt(projectRoot(input.root))).pipe(
          Effect.flatMap((row) =>
            run(originToRecord(sql, row, projectRoot(input.repoRoot ?? input.root))),
          ),
        );

      const registerIn = (input: Registering, originIdentity: string | null) =>
        Effect.gen(function* () {
          const root = projectRoot(input.root);
          const { name } = input;
          const repoRoot = input.repoRoot === undefined ? undefined : projectRoot(input.repoRoot);
          const row = yield* projectAt(root);
          if (row !== undefined) return { project: toProject(row), created: false };
          const id = Schema.decodeSync(ProjectId)(randomUUID());
          yield* sql`INSERT INTO projects (id, root, name, repo_root, bookmarked, origin_identity)
              VALUES (${id}, ${root}, ${name}, ${repoRoot ?? null}, 0, ${originIdentity})`;
          const project = toProject({
            id,
            root,
            name,
            repo_root: repoRoot ?? null,
            bookmarked: 0,
            last_opened_at: null,
            origin_identity: originIdentity,
          });
          return { project, created: true };
        });

      const registerProject: ThreadStoreShape["registerProject"] = (input) =>
        originFor(input).pipe(Effect.flatMap((origin) => tx(registerIn(input, origin))));

      const ensureProject: ThreadStoreShape["ensureProject"] = (input) =>
        registerProject(input).pipe(Effect.map(({ project }) => project));

      const listProjects = run(
        sql<ProjectRow>`SELECT * FROM projects ORDER BY name`.pipe(
          Effect.map((rows) => rows.map(toProject)),
        ),
      );

      const setProjectFolderTrust: ThreadStoreShape["setProjectFolderTrust"] = (id, trusted) =>
        tx(
          Effect.gen(function* () {
            const value = trusted ? "trusted" : "untrusted";
            yield* sql`UPDATE projects SET folder_trust = ${value} WHERE id = ${id}`;
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

      const nextRevision = sql<{ rev: number }>`UPDATE feed_revision SET rev = rev + 1
        WHERE id = 0 RETURNING rev`.pipe(Effect.map(([row]) => Number(row!.rev)));

      const writeThread = (unstamped: Thread) =>
        Effect.gen(function* () {
          if (unstamped.labels.length > 1)
            return yield* Effect.die(new Error(`thread ${unstamped.id} has more than one label`));
          const thread: Thread = { ...unstamped, revision: yield* nextRevision };
          noteForeignCheckouts(thread);
          notePrivacy(thread);
          noteReaders(thread);
          yield* sql`INSERT INTO threads
            (id, project_id, agent_session_id, pinned, parked, created_at, last_activity_at, data,
              host_id)
          VALUES (${thread.id}, ${thread.projectId}, ${thread.agentSessionId ?? null},
            ${thread.pinned ? 1 : 0}, ${thread.parked ? 1 : 0}, ${thread.createdAt},
            ${thread.lastActivityAt}, ${toJson(Thread, thread)}, ${hostOf(thread.checkout)})
          ON CONFLICT (id) DO UPDATE SET
            agent_session_id = excluded.agent_session_id,
            host_id = excluded.host_id,
            pinned = excluded.pinned,
            parked = excluded.parked,
            last_activity_at = excluded.last_activity_at,
            data = excluded.data`;
          return thread;
        });

      let listedThreads: { token: string; threads: ReadonlyArray<Thread> } | undefined;

      const readThread = (id: ThreadId) =>
        sql<{ data: string }>`SELECT data FROM threads WHERE id = ${id}`.pipe(
          Effect.flatMap((rows) =>
            rows[0] === undefined
              ? Effect.succeed(undefined)
              : readableRow(unreadable, "threads", id, decodeStored(Thread, rows[0].data)),
          ),
          Effect.map((thread) => {
            if (thread !== undefined) {
              noteForeignCheckouts(thread);
              notePrivacy(thread);
            }
            return thread;
          }),
          Effect.flatMap((thread) =>
            thread === undefined
              ? Effect.fail(new ThreadNotFound({ threadId: id }))
              : Effect.succeed(thread),
          ),
        );

      const updateThread: ThreadStoreShape["updateThread"] = (id, f, authorityCaller, claimScan) =>
        tx(
          Effect.gen(function* () {
            const thread = yield* readThread(id);
            const base =
              authorityCaller === undefined && claimScan === undefined
                ? undefined
                : yield* readThreadAuthority(thread, authorityCaller ?? id);
            const context =
              claimScan === undefined
                ? base
                : { ...base!, prClaimedByOther: yield* otherThreadBindsPr(id, claimScan.pr) };
            const next = yield* holdForReservations(
              thread,
              keepReader(thread, normalizeThreadPrs(f(thread, context))),
            );
            return yield* writeThread(stampParked(thread, next, Date.now()));
          }),
        );

      const takeRev = (threadId: string, reset = false) =>
        Effect.gen(function* () {
          const rev = yield* nextRevision;
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
      const SUPPLIED_KEY = "supplied";
      let supplied: { readonly patch: SettingsPatch | undefined } | undefined;
      const readSupplied = Effect.gen(function* () {
        if (supplied !== undefined) return supplied.patch;
        const rows = yield* sql<{
          value: string;
        }>`SELECT value FROM settings WHERE key = ${SUPPLIED_KEY}`;
        let patch: SettingsPatch | undefined;
        try {
          patch =
            rows[0] === undefined
              ? undefined
              : Schema.decodeUnknownSync(SettingsPatch)(JSON.parse(rows[0].value));
        } catch {
          yield* Effect.logWarning("supplied settings unreadable; ignored");
          patch = undefined;
        }
        supplied ??= { patch };
        return supplied.patch;
      });
      const withSupplied = (settings: Settings) =>
        Effect.map(readSupplied, (patch) =>
          patch === undefined || !embeddingOn(settings)
            ? settings
            : applySettingsPatch(settings, patch),
        );
      const readSettings = Effect.gen(function* () {
        return yield* withSupplied(yield* readStoredSettings);
      });
      const readPersonPatches = (person: string) =>
        Effect.gen(function* () {
          const rows = yield* sql<{
            key: string;
            value: string;
          }>`SELECT key, value FROM person_settings WHERE person = ${person}`;
          const held = new Map(rows.map((row) => [row.key, row.value]));
          const patches: Array<SettingsPatch> = [];
          for (const path of PERSONAL_SETTINGS) {
            const stored = held.get(personalSettingKey(path));
            if (stored === undefined) continue;
            try {
              const value: unknown = JSON.parse(stored);
              patches.push(
                Schema.decodeUnknownSync(SettingsPatch)({ [path[0]]: { [path[1]]: value } }),
              );
            } catch {
              yield* Effect.logWarning("a person's setting is unreadable; ignored").pipe(
                Effect.annotateLogs({ key: personalSettingKey(path) }),
              );
            }
          }
          return patches;
        });
      const readSettingsFor = (person: string) =>
        Effect.gen(function* () {
          const shared = withoutPersonalSettings(yield* readStoredSettings);
          return yield* withSupplied(
            (yield* readPersonPatches(person)).reduce(applySettingsPatch, shared),
          );
        });
      const readStoredSettings = Effect.gen(function* () {
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
      const writeSettings = (given: Settings, givenTouched?: ReadonlyArray<FieldPath>) =>
        Effect.gen(function* () {
          const settings = yield* withSupplied(given);
          const patch = yield* readSupplied;
          const touched =
            givenTouched === undefined || patch === undefined || settings === given
              ? givenTouched
              : [...givenTouched, ...settingsPatchPaths(patch)];
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
            const stored = yield* writeThread(next);
            yield* sql`UPDATE threads SET completed_reason = ${next.completedReason ?? null}
              WHERE id = ${id}`;
            return { thread: stored, changed: true };
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

      const unlinkOrchestration = (id: ThreadId, keepReports = false) =>
        unlinkOrchestrationIn(sql, id, keepReports);

      const writeWorkspace = (state: WorkspaceState) =>
        Effect.gen(function* () {
          const id = state.workspace.id;
          yield* sql`INSERT INTO workspaces (id, orchestrator_thread_id, created_at, data)
          VALUES (${id}, ${state.workspace.orchestratorThreadId ?? null},
            ${state.workspace.createdAt}, ${toJson(WorkspaceState, state)})
          ON CONFLICT (id) DO UPDATE SET
            orchestrator_thread_id = excluded.orchestrator_thread_id,
            data = excluded.data`;
        });

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

      const claimRows = sql<{
        id: string;
        data: string;
        parked: number;
      }>`SELECT id, data, parked FROM threads`.pipe(
        Effect.flatMap((rows) =>
          Effect.gen(function* () {
            const threads: Array<Thread> = [];
            const [unknown, unknownParked]: [Array<ThreadId>, Array<ThreadId>] = [[], []];
            for (const row of rows) {
              const decoded = decodeStored(Thread, row.data);
              if (decoded.ok) {
                threads.push(decoded.value);
                continue;
              }
              yield* unreadable("threads", row.id, decoded.paths);
              (row.parked === 1 ? unknownParked : unknown).push(ThreadId.make(row.id));
            }
            return { threads, unknown, unknownParked } as const;
          }),
        ),
      );

      const otherThreadBindsPr = (
        excludeId: ThreadId,
        pr: { readonly repo: string; readonly number: number },
      ) =>
        claimRows.pipe(
          Effect.map(
            ({ threads, unknown }) =>
              unknown.some((id) => id !== excludeId) ||
              threads.some(
                (thread) =>
                  thread.id !== excludeId &&
                  !thread.parked &&
                  thread.boundPr !== undefined &&
                  samePrRef(thread.boundPr, pr),
              ),
          ),
        );

      const reservationsOfOthers = (excludeId: ThreadId) =>
        sql<{ data: string }>`SELECT data FROM merge_fences`.pipe(
          Effect.map((rows) =>
            rows.flatMap((row) => {
              const pending = Schema.decodeUnknownSync(MergeFence)(JSON.parse(row.data)).pending;
              return pending === undefined || pending.threadId === excludeId ? [] : [pending];
            }),
          ),
        );

      const holdForReservations = (before: Thread | undefined, next: Thread) =>
        Effect.gen(function* () {
          if (next.parked) return next;
          const reserved = yield* reservationsOfOthers(next.id);
          if (reserved.length === 0) return next;
          if (before === undefined || before.parked) {
            for (const pending of reserved) {
              const sameProject =
                before !== undefined &&
                (yield* readThread(pending.threadId).pipe(Effect.option)).pipe(
                  Option.match({
                    onNone: () => true,
                    onSome: (owner) => owner.projectId === next.projectId,
                  }),
                );
              if (recordClaims(next, pending) || sameProject) {
                yield* Effect.logWarning("restoration deferred by a reserved merge").pipe(
                  Effect.annotateLogs({
                    threadId: next.id,
                    pr: `${pending.pr.repo}#${pending.pr.number}`,
                    reservedBy: pending.threadId,
                  }),
                );
                return { ...next, parked: true };
              }
            }
            return next;
          }
          const bound = next.boundPr;
          if (bound === undefined) return next;
          if (before.boundPr !== undefined && samePrRef(before.boundPr, bound)) return next;
          const pending = reserved.find((each) => samePrRef(each.pr, bound));
          if (pending === undefined) return next;
          yield* Effect.logWarning("binding of a reserved PR refused").pipe(
            Effect.annotateLogs({
              threadId: next.id,
              pr: `${bound.repo}#${bound.number}`,
              reservedBy: pending.threadId,
            }),
          );
          const { boundPr: _, extraPrs: __, ...rest } = next;
          return {
            ...rest,
            ...(before.boundPr === undefined ? {} : { boundPr: before.boundPr }),
            ...(before.extraPrs === undefined ? {} : { extraPrs: before.extraPrs }),
          };
        });

      const messagesHolding = (
        threadId: ThreadId,
        needles: ReadonlyArray<string>,
        role: "user" | undefined,
      ) =>
        needles.length === 0
          ? Effect.succeed([])
          : run(
              sql<{ id: string; message: string }>`SELECT id, message FROM messages
                WHERE thread_id = ${threadId}
                  AND ${role === undefined ? sql`1` : sql`role = 'user'`}
                  AND ${sql.or(
                    [...new Set(needles)].map((needle) => sql`instr(message, ${needle}) > 0`),
                  )}
                ORDER BY seq`.pipe(
                Effect.flatMap((rows) => messageRows("messages", threadId, rows)),
              ),
            );
      const messagesWith: ThreadStoreShape["messagesWith"] = (threadId, needles, role) =>
        messagesHolding(
          threadId,
          needles.map((needle) => JSON.stringify(needle).slice(1, -1)),
          role,
        );

      return ThreadStore.of({
        messageReceipt: makeMessageReceipts(sql, receiptScope, commitReservation),
        setCompletion,
        updateCompletion,
        listQueue: (threadId) =>
          run(
            sql<{
              id: string;
              input: string;
              notice_key: string | null;
              turn_id: string | null;
              actor: string | null;
            }>`SELECT id, input, notice_key, turn_id, actor FROM queue_items
              WHERE thread_id = ${threadId} ORDER BY position`.pipe(
              Effect.flatMap((rows) =>
                readableRows(
                  unreadable,
                  "queue_items",
                  rows,
                  (r) => `${threadId}/${r.id}`,
                  (r) =>
                    mapDecoded(decodeStored(UserInput, r.input), (input): StoredQueuedInput => {
                      const actor =
                        r.actor === null ? undefined : decodeStored(StoredActorJson, r.actor);
                      return {
                        id: QueueItemId.make(r.id),
                        input,
                        ...(r.notice_key === null ? {} : { noticeKey: r.notice_key }),
                        ...(r.turn_id === null ? {} : { turnId: TurnId.make(r.turn_id) }),
                        ...(actor === undefined ? {} : { actor: actor.ok ? actor.value : {} }),
                      };
                    }),
                ),
              ),
            ),
          ),
        putQueue: (threadId, queue) =>
          tx(
            Effect.gen(function* () {
              const stored = yield* sql<{ id: string; input: string }>`SELECT id, input
                FROM queue_items WHERE thread_id = ${threadId}`;
              for (const row of stored) {
                if (!decodeStored(UserInput, row.input).ok) continue;
                yield* sql`DELETE FROM queue_items WHERE thread_id = ${threadId} AND id = ${row.id}`;
              }
              for (const [position, item] of queue.entries()) {
                yield* sql`INSERT OR REPLACE INTO queue_items
                  (thread_id, id, position, input, notice_key, turn_id, actor)
                  VALUES (${threadId}, ${item.id}, ${position}, ${toJson(UserInput, item.input)},
                    ${item.noticeKey ?? null}, ${item.turnId ?? null},
                    ${item.actor === undefined ? null : toJson(StoredActorJson, item.actor)})`;
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
                      role: roleOf(rows[0].role),
                      turnId: rows[0].turn_id === null ? undefined : TurnId.make(rows[0].turn_id),
                    },
              ),
            ),
          ),
        lastSender: (threadId) =>
          run(
            sql<{
              person: string | null;
            }>`SELECT json_extract(message, '$.metadata.sentBy') AS person
              FROM messages
              WHERE thread_id = ${threadId} AND role = 'user' AND json_valid(message)
                AND json_extract(message, '$.metadata.author') = 'user'
              ORDER BY seq DESC LIMIT 1`.pipe(
              Effect.map((rows) =>
                typeof rows[0]?.person === "string" ? rows[0].person : undefined,
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
              Effect.map((rows) => completedReasonOf(rows[0]?.completed_reason)),
            ),
          ),
        updateSettings: (f, touched) =>
          tx(
            Effect.gen(function* () {
              yield* writeSettings(f(yield* readSettings), touched);
              return yield* readSettings;
            }),
          ),
        usageOverview: (query, history) =>
          run(
            readUsageOverview(query, history).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
              reads,
            ),
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
        setProjectFolderTrust,
        forgetProject,

        insertThread: (thread) =>
          tx(
            Effect.gen(function* () {
              const before = Option.getOrUndefined(
                yield* readThread(thread.id).pipe(Effect.option),
              );
              return yield* writeThread(
                yield* holdForReservations(
                  before,
                  before === undefined ? thread : keepReader(before, thread),
                ),
              );
            }),
          ),
        setThreadReaders: (ids, readers) =>
          tx(
            Effect.gen(function* () {
              const changed: Array<ThreadId> = [];
              for (const id of ids) {
                const open = yield* readThread(id).pipe(Effect.option);
                if (Option.isSome(open)) {
                  if (open.value.readableBy === undefined) continue;
                  const { readers: _, ...rest } = open.value;
                  yield* writeThread(
                    readers.length === 0 ? rest : { ...rest, readers: [...readers] },
                  );
                  changed.push(id);
                  continue;
                }
                const rows = yield* sql<{ data: string }>`SELECT data FROM closed_threads
                  WHERE thread_id = ${id}`;
                for (const row of rows) {
                  const closed = decodeStored(Thread, row.data);
                  if (!closed.ok || closed.value.readableBy === undefined) continue;
                  const { readers: _, ...rest } = closed.value;
                  const next: Thread =
                    readers.length === 0 ? rest : { ...rest, readers: [...readers] };
                  yield* sql`UPDATE closed_threads SET data = ${toJson(Thread, next)}
                    WHERE thread_id = ${id}`;
                  noteReaders(next);
                  changed.push(id);
                }
              }
              return changed;
            }),
          ),
        getThread: (id) => run(readThread(id)),
        getThreadWithAuthority: (id, callerId) =>
          tx(
            Effect.gen(function* () {
              const thread = yield* readThread(id);
              return { thread, context: yield* readThreadAuthority(thread, callerId) };
            }),
          ),
        listMergeFences: run(
          sql<{ data: string }>`SELECT data FROM merge_fences`.pipe(
            Effect.map((rows) =>
              rows.map((row) => Schema.decodeUnknownSync(MergeFence)(JSON.parse(row.data))),
            ),
          ),
        ),
        putMergeFence: (fence) => durableFence(writeMergeFence(fence)),
        reserveMergeFence: (fence, pr, excluding, authorized, authorityCaller) =>
          durableFence(
            Effect.gen(function* () {
              if (yield* otherThreadBindsPr(excluding, pr)) return false;
              if (authorized !== undefined) {
                const owner = Option.getOrUndefined(
                  yield* readThread(excluding).pipe(Effect.option),
                );
                const context =
                  owner === undefined
                    ? undefined
                    : yield* readThreadAuthority(owner, authorityCaller ?? excluding);
                if (!authorized(owner, context)) return false;
              }
              yield* writeMergeFence(fence);
              return true;
            }),
          ),
        reconcileMergeFence: (fence, expected, caller, authorized) =>
          durableFence(
            Effect.gen(function* () {
              const rows = yield* sql<{
                data: string;
              }>`SELECT data FROM merge_fences WHERE key = ${fence.key}`;
              const current =
                rows[0] === undefined
                  ? undefined
                  : Schema.decodeUnknownSync(MergeFence)(JSON.parse(rows[0].data));
              if (JSON.stringify(current?.pending) !== JSON.stringify(expected)) return false;
              const owner = yield* readThread(expected.threadId).pipe(Effect.option);
              const thread = Option.getOrUndefined(owner);
              const context =
                thread === undefined ? undefined : yield* readThreadAuthority(thread, caller);
              if (!authorized(thread, context)) return false;
              yield* writeMergeFence(fence);
              return true;
            }),
          ),
        listThreads: run(
          Effect.gen(function* () {
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
            for (const thread of threads) {
              noteForeignCheckouts(thread);
              notePrivacy(thread);
            }
            listedThreads = version === undefined ? undefined : { token: version.token, threads };
            return threads;
          }),
        ),
        listThreadsForClaims: run(claimRows),
        updateThread,
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
              yield* rememberPrivate("threads", [id]);
              yield* rememberHolderIn(sql, id);
              yield* sql`DELETE FROM threads WHERE id = ${id}`;
              yield* sql`DELETE FROM message_receipts WHERE thread_id = ${id}
                AND thread_id NOT IN (SELECT thread_id FROM closed_threads)`;
              yield* unlinkOrchestration(id);
            }),
          ),
        closeThread: (id, closedAt) =>
          tx(
            Effect.gen(function* () {
              const live = yield* sql<{ data: string }>`SELECT data FROM threads WHERE id = ${id}`;
              if (live.length === 0) return;
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
              yield* rememberHolderIn(sql, id);
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
                  mapDecoded(decodeStored(Thread, r.data), (thread) => {
                    notePrivacy(thread);
                    return { thread, closedAt: Number(r.closed_at) };
                  }),
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
        takeClosed: (threadId) =>
          tx(
            Effect.gen(function* () {
              const [row] = yield* sql<{
                data: string;
                closed_at: number;
                workers: string | null;
              }>`SELECT data, closed_at, workers FROM closed_threads WHERE thread_id = ${threadId}`;
              if (row === undefined) return undefined;
              const decoded = decodeStored(Thread, row.data);
              if (!decoded.ok) return undefined;
              yield* sql`DELETE FROM closed_threads WHERE thread_id = ${threadId}`;
              const workers =
                row.workers === null ? undefined : decodeStored(ClosedWorkers, row.workers);
              return {
                closed: { thread: decoded.value, closedAt: Number(row.closed_at) },
                workers: workers?.ok === true ? workers.value : [],
              };
            }),
          ),
        closedHolderOf: (workspaceId) => run(holderMachinesIn(sql, workspaceId)),
        forgetClosed: (threadId) =>
          tx(
            Effect.gen(function* () {
              yield* rememberPrivate("closed_threads", [threadId]);
              yield* sql`DELETE FROM closed_threads WHERE thread_id = ${threadId}`;
              yield* sql`DELETE FROM message_receipts WHERE thread_id = ${threadId}
                AND thread_id NOT IN (SELECT id FROM threads)`;
            }),
          ),

        listMessages: (threadId) =>
          run(
            sql<{ id: string; message: string }>`SELECT id, message FROM messages
              WHERE thread_id = ${threadId} ORDER BY seq`.pipe(
              Effect.flatMap((rows) => messageRows("messages", threadId, rows)),
            ),
          ),
        userMessagePage: (threadId, { from, limit, after }) => {
          const take = Math.max(1, Math.floor(Math.min(limit, Number.MAX_SAFE_INTEGER)));
          const rows =
            from === "newest"
              ? after === undefined
                ? sql<{ id: string; seq: number; message: string }>`SELECT id, seq, message
                    FROM messages WHERE thread_id = ${threadId} AND role = 'user'
                    ORDER BY seq DESC LIMIT ${take}`
                : sql<{ id: string; seq: number; message: string }>`SELECT id, seq, message
                    FROM messages WHERE thread_id = ${threadId} AND role = 'user' AND seq < ${after}
                    ORDER BY seq DESC LIMIT ${take}`
              : after === undefined
                ? sql<{ id: string; seq: number; message: string }>`SELECT id, seq, message
                    FROM messages WHERE thread_id = ${threadId} AND role = 'user'
                    ORDER BY seq LIMIT ${take}`
                : sql<{ id: string; seq: number; message: string }>`SELECT id, seq, message
                    FROM messages WHERE thread_id = ${threadId} AND role = 'user' AND seq > ${after}
                    ORDER BY seq LIMIT ${take}`;
          return run(
            rows.pipe(
              Effect.flatMap((page) =>
                readableRows(
                  unreadable,
                  "messages",
                  page,
                  (r) => `${threadId}/${r.id}`,
                  (r) =>
                    mapDecoded(decodeStored(UIMessageSchema, r.message), (message): SeqMessage => ({
                      seq: Number(r.seq),
                      message,
                    })),
                ).pipe(
                  Effect.map((messages): UserMessagesRead => ({
                    messages,
                    next: page.length < take ? undefined : Number(page.at(-1)!.seq),
                  })),
                ),
              ),
            ),
          );
        },
        messagesWith,
        messagesWithParts: (threadId, types) =>
          types.length === 0
            ? Effect.succeed([])
            : run(
                sql<{ id: string; message: string }>`SELECT id, message FROM messages
                  WHERE rowid IN (SELECT message_rowid FROM message_parts
                    WHERE thread_id = ${threadId} AND ${sql.or(
                      [...new Set(types)].map((type) => sql`type = ${type}`),
                    )})
                  ORDER BY seq`.pipe(
                  Effect.flatMap((rows) => messageRows("messages", threadId, rows)),
                  Effect.map((messages) =>
                    messages.filter((message) =>
                      message.parts.some((part) => types.includes(part.type)),
                    ),
                  ),
                ),
              ),
        firstMessages: (threadId, count) =>
          run(
            sql<{ id: string; message: string }>`SELECT id, message FROM messages
              WHERE thread_id = ${threadId} ORDER BY seq
              LIMIT ${Math.max(0, Math.floor(Math.min(count, Number.MAX_SAFE_INTEGER)))}`.pipe(
              Effect.flatMap((rows) => messageRows("messages", threadId, rows)),
            ),
          ),
        lastMessages: (threadId, count) =>
          run(
            sql<{ id: string; message: string }>`SELECT id, message FROM (
                SELECT seq, id, message FROM messages WHERE thread_id = ${threadId}
                ORDER BY seq DESC LIMIT ${Math.max(0, Math.floor(count))}
              ) ORDER BY seq`.pipe(
              Effect.flatMap((rows) => messageRows("messages", threadId, rows)),
            ),
          ),
        turnMessages: (threadId, turnId) =>
          run(
            sql<{ id: string; message: string }>`SELECT id, message FROM messages
              WHERE turn_id = ${turnId} AND thread_id = ${threadId} ORDER BY seq`.pipe(
              Effect.flatMap((rows) => messageRows("messages", threadId, rows)),
            ),
          ),
        messageCount: (threadId) =>
          run(
            sql<{ count: number }>`SELECT count(*) AS count FROM messages
              WHERE thread_id = ${threadId}`.pipe(Effect.map(([row]) => Number(row?.count ?? 0))),
          ),
        hasMessages: (threadId, role) =>
          run(
            (role === undefined
              ? sql<{ found: number }>`SELECT EXISTS (SELECT 1 FROM messages
                  WHERE thread_id = ${threadId}) AS found`
              : sql<{ found: number }>`SELECT EXISTS (SELECT 1 FROM messages
                  WHERE thread_id = ${threadId} AND role = ${role}) AS found`
            ).pipe(Effect.map(([row]) => Number(row?.found) === 1)),
          ),
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
        storedMessages: (threadId, select) =>
          run(
            ("messageId" in select
              ? sql<StoredMessageRow>`SELECT id, seq, rev, role, turn_id, message FROM messages
                  WHERE thread_id = ${threadId} AND id = ${select.messageId}`
              : sql<StoredMessageRow>`SELECT id, seq, rev, role, turn_id, message FROM messages
                  WHERE thread_id = ${threadId} AND seq > ${select.afterSeq}
                  ORDER BY seq LIMIT ${select.limit}`
            ).pipe(
              Effect.flatMap((rows) =>
                readableRows(
                  unreadable,
                  "messages",
                  rows,
                  (r) => `${threadId}/${r.id}`,
                  (r) =>
                    mapDecoded(
                      decodeStored(UIMessageSchema, r.message),
                      (message): StoredMessage => ({
                        seq: Number(r.seq),
                        rev: Number(r.rev),
                        role: r.role,
                        ...(r.turn_id === null ? {} : { turnId: r.turn_id }),
                        message,
                      }),
                    ),
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
              const [count] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM messages
                WHERE thread_id = ${threadId} AND rev > ${afterRev} AND seq >= ${from}`;
              if (Number(count?.n ?? 0) > limit) return undefined;
              const rows = yield* sql<{ id: string; message: string }>`SELECT id, message
                FROM messages INDEXED BY messages_thread_rev
                WHERE thread_id = ${threadId} AND rev > ${afterRev} AND seq >= ${from}
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
        exportHistory: (threadId) =>
          tx(
            Effect.gen(function* () {
              const storedMessages = yield* sql<{
                id: string;
                turn_id: string | null;
                message: string;
              }>`SELECT id, turn_id, message FROM messages WHERE thread_id = ${threadId}
                ORDER BY seq`;
              const messages = (yield* readableRows(
                unreadable,
                "messages",
                storedMessages,
                (r) => `${threadId}/${r.id}`,
                (r) =>
                  mapDecoded(decodeStored(UIMessageSchema, r.message), (message) => ({
                    message,
                    ...(r.turn_id === null ? {} : { turnId: TurnId.make(r.turn_id) }),
                  })),
              )) satisfies MovedHistory["messages"];
              const turnRows = yield* sql<{
                id: string;
                started_at: number;
                ended_at: number | null;
                reason: string | null;
                usage: string | null;
              }>`SELECT id, started_at, ended_at, reason, usage FROM turns
                WHERE thread_id = ${threadId} ORDER BY started_at, rowid`;
              const turns = turnRows.map((r): MovedTurn => {
                const reason =
                  r.reason === null
                    ? undefined
                    : Schema.decodeUnknownOption(TurnEndReason)(r.reason);
                const usage = r.usage === null ? undefined : decodeStored(UsageSummary, r.usage);
                return {
                  id: TurnId.make(r.id),
                  startedAt: Number(r.started_at),
                  ...(r.ended_at === null ? {} : { endedAt: Number(r.ended_at) }),
                  ...(reason === undefined || Option.isNone(reason)
                    ? {}
                    : { reason: reason.value }),
                  ...(usage?.ok === true ? { usage: usage.value } : {}),
                };
              });
              return { messages, turns };
            }),
          ),
        closeOpenTurns: (endedAt, except) =>
          run(
            sql<{
              id: string;
              thread_id: string;
              started_at: number;
              ended_at: number;
            }>`UPDATE turns
              SET ended_at = MAX(started_at, ${endedAt}), reason = 'interrupted'
              WHERE ended_at IS NULL
                AND thread_id NOT IN (SELECT value FROM json_each(${JSON.stringify([...(except ?? [])])}))
              RETURNING id, thread_id, started_at, ended_at`.pipe(
              Effect.map((rows) =>
                rows.map((r): TurnRecord => ({
                  id: TurnId.make(r.id),
                  threadId: ThreadId.make(r.thread_id),
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
                  id: TurnId.make(r.id),
                  threadId: ThreadId.make(r.thread_id),
                  startedAt: Number(r.started_at),
                  endedAt: r.ended_at === null ? undefined : Number(r.ended_at),
                  reason: turnEndReasonOf(r.reason),
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
                  id: TurnId.make(r.id),
                  threadId: ThreadId.make(r.thread_id),
                  startedAt: Number(r.started_at),
                  endedAt: r.ended_at === null ? undefined : Number(r.ended_at),
                  reason: turnEndReasonOf(r.reason),
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
              const pr = threadWakePrJson(wake);
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
              const fired = wake.fired ?? change.fired;
              const pr = threadWakePrJson({
                ...wake,
                ...(seen === undefined ? {} : { seen }),
                ...(fired === undefined ? {} : { fired }),
              });
              yield* sql`UPDATE thread_wakes SET pr = ${pr} WHERE id = ${id}`;
            }),
          ),
        updateThreadWakeCondition: (id, change) =>
          tx(
            Effect.gen(function* () {
              const [row] = yield* sql<WakeRow>`SELECT id, thread_id, at, set_at, note, pr
                FROM thread_wakes WHERE id = ${id}`;
              if (row === undefined) return false;
              const [wake] = yield* wakeRows([row]);
              const state = wake?.conditionState;
              if (wake === undefined || state === undefined || state.fired !== undefined)
                return false;
              const pr = threadWakePrJson({
                ...wake,
                conditionState: {
                  ...state,
                  ...(change.seen === undefined ? {} : { seen: change.seen }),
                  ...(change.fired === undefined ? {} : { fired: change.fired }),
                },
              });
              yield* sql`UPDATE thread_wakes SET pr = ${pr} WHERE id = ${id}`;
              return true;
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
              Effect.map(waitRowsOf(which)),
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
              Effect.map(waitRowsOf("all")),
            ),
          ),
        getWait: (threadId, id) => run(readWait(threadId, id)),
        putWait: (threadId, item, toldAt) => run(writeWait(threadId, item, toldAt ?? null)),
        replaceWait: (threadId, item) => run(writeWait(threadId, item, undefined)),
        resolveWait: (threadId, id, resolution) =>
          tx(
            Effect.gen(function* () {
              const item = yield* readWait(threadId, id);
              const ownAgent = resolution?.by === "agent" && resolution.thread === undefined;
              if (resolution !== undefined && item.resolvedAt !== undefined) {
                if (ownAgent) {
                  yield* sql`UPDATE wait_items SET told_at = ${resolution.at}
                    WHERE thread_id = ${threadId} AND id = ${id}`;
                }
                return item;
              }
              const { next, toldAt } = resolvedWait(
                item,
                resolution,
                yield* toldAtOf(threadId, id),
              );
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
        getSettingsFor: (person) => run(readSettingsFor(person)),
        putPersonSettings: (person, patch) =>
          tx(
            Effect.gen(function* () {
              const encoded = Schema.encodeSync(SettingsPatch)(splitSettingsPatch(patch).personal);
              for (const path of PERSONAL_SETTINGS) {
                const section = fieldsOf(encoded).get(path[0]);
                if (!Predicate.isObject(section) || !(path[1] in section)) continue;
                const value = section[path[1]];
                const key = personalSettingKey(path);
                if (value === null || value === undefined) {
                  yield* sql`DELETE FROM person_settings WHERE person = ${person} AND key = ${key}`;
                } else {
                  yield* sql`INSERT INTO person_settings (person, key, value)
                    VALUES (${person}, ${key}, ${JSON.stringify(value)})
                    ON CONFLICT (person, key) DO UPDATE SET value = excluded.value`;
                }
              }
              return yield* readSettingsFor(person);
            }),
          ),
        getSuppliedSettings: run(readSupplied),
        putSuppliedSettings: (patch) =>
          tx(
            Effect.gen(function* () {
              if (patch === undefined) {
                yield* sql`DELETE FROM settings WHERE key = ${SUPPLIED_KEY}`;
              } else {
                const json = JSON.stringify(Schema.encodeSync(SettingsPatch)(patch));
                yield* sql`INSERT INTO settings (key, value) VALUES (${SUPPLIED_KEY}, ${json})
                  ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
              }
              supplied = { patch };
              const stored = yield* readStoredSettings;
              yield* writeSettings(stored, patch === undefined ? [] : settingsPatchPaths(patch));
              return yield* readSettings;
            }),
          ).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (exit._tag === "Failure") supplied = undefined;
              }),
            ),
          ),
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
                  threadId: ThreadId.make(holder.id),
                });
              }
              const [dreaming] = yield* sql<{ id: string }>`SELECT id FROM threads WHERE id IN (
                SELECT thread_id FROM dreams WHERE workspace_id = ${id})`;
              if (dreaming !== undefined) {
                return yield* new InvalidState({
                  message: `A memory update thread of ${state.workspace.name} is still open. Try removing it again.`,
                  threadId: ThreadId.make(dreaming.id),
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
                "dream_cursors",
              ]) {
                yield* sql`DELETE FROM ${sql(table)} WHERE workspace_id = ${id}`;
              }
              yield* sql`DELETE FROM workspaces WHERE id = ${id}`;
            }),
          ),
        movedConflict: (workspaceId, threadId, turnIds) =>
          tx(movedConflictOf(workspaceId, threadId, turnIds)),
        stageMovedWorkspace: (moved) =>
          run(
            sql
              .withTransaction(
                Effect.gen(function* () {
                  const id = moved.state.workspace.id;
                  const conflict = yield* movedConflictOf(
                    id,
                    moved.orchestrator?.thread.id,
                    moved.orchestrator?.turns.map((turn) => turn.id) ?? [],
                  );
                  if (conflict !== undefined) return yield* alreadyHere(conflict);
                  yield* writeWorkspace(moved.state);
                  for (const card of moved.featureCards) {
                    yield* sql`INSERT INTO feature_cards
                        (workspace_id, feature, version, created_at, data)
                      VALUES (${id}, ${card.feature}, ${card.version}, ${card.createdAt},
                        ${toJson(FeatureCard, { ...card, workspaceId: id })})`;
                  }
                  for (const event of moved.events) {
                    yield* sql`INSERT INTO orchestration_events (workspace_id, at, kind, data)
                      VALUES (${id}, ${event.at}, ${event.kind},
                        ${JSON.stringify(event.data ?? null)})`;
                  }
                  yield* sql`INSERT INTO orchestration_outbox (workspace_id, data)
                    VALUES (${id}, ${moved.outbox})`;
                  const orchestrator = moved.orchestrator;
                  if (orchestrator === undefined) return;
                  yield* writeMovedClosed(orchestrator);
                }),
              )
              .pipe(
                Effect.catch((e) =>
                  e instanceof SqlError
                    ? Effect.fail(
                        new InvalidState({
                          message:
                            "The workspace couldn't be stored here, and nothing of it was kept. Part of it may already be on this server.",
                        }),
                      )
                    : Effect.fail(e),
                ),
              ),
          ),
        movedThreadConflict: (threadId, turnIds) =>
          tx(movedThreadConflictOf(threadId, turnIds, "This thread")),
        stageMovedThread: (moved) =>
          run(
            sql
              .withTransaction(
                Effect.gen(function* () {
                  const conflict = yield* movedThreadConflictOf(
                    moved.thread.id,
                    moved.turns.map((turn) => turn.id),
                    "This thread",
                  );
                  if (conflict !== undefined) return yield* alreadyHere(conflict);
                  yield* writeMovedClosed(moved);
                }),
              )
              .pipe(
                Effect.catch((e) =>
                  e instanceof SqlError
                    ? Effect.fail(
                        new InvalidState({
                          message:
                            "The thread couldn't be stored here, and nothing of it was kept. Part of it may already be on this server.",
                        }),
                      )
                    : Effect.fail(e),
                ),
              ),
          ),
        returnMovedThread: (moved) =>
          run(
            sql
              .withTransaction(
                Effect.gen(function* () {
                  const threadId = moved.thread.id;
                  const [open] = yield* sql<{ id: string }>`SELECT id FROM threads
                    WHERE id = ${threadId}`;
                  if (open !== undefined) return yield* alreadyHere("This thread is open here.");
                  const [kept] = yield* sql<{ data: string }>`SELECT data FROM closed_threads
                    WHERE thread_id = ${threadId}`;
                  const copy = kept === undefined ? undefined : decodeStored(Thread, kept.data);
                  if (copy === undefined || !copy.ok || copy.value.transferredTo === undefined)
                    return yield* alreadyHere(
                      "This thread's copy here isn't there to come back to.",
                    );
                  for (const turn of moved.turns) {
                    const [other] = yield* sql<{ thread_id: string }>`SELECT thread_id FROM turns
                      WHERE id = ${turn.id} AND thread_id != ${threadId}
                      UNION ALL SELECT thread_id FROM closed_turns
                      WHERE id = ${turn.id} AND thread_id != ${threadId} LIMIT 1`;
                    if (other !== undefined)
                      return yield* alreadyHere("A turn of this thread is already on this server.");
                  }
                  const before = yield* sql<{ id: string }>`SELECT id FROM closed_messages
                    WHERE thread_id = ${threadId}`;
                  const [last] = yield* sql<{ seq: number | null }>`SELECT MAX(seq) AS seq
                    FROM closed_messages WHERE thread_id = ${threadId}`;
                  const onCopy = new Set(before.map((row) => row.id));
                  const added = moved.messages.filter(({ message }) => !onCopy.has(message.id));
                  const from = last?.seq ?? 0;
                  for (const [index, { message, turnId }] of added.entries()) {
                    yield* sql`INSERT INTO closed_messages
                        (thread_id, id, seq, role, turn_id, message)
                      VALUES (${threadId}, ${message.id}, ${from + index + 1},
                        ${message.role}, ${turnId ?? null}, ${JSON.stringify(message)})`;
                  }
                  for (const turn of moved.turns) {
                    yield* sql`DELETE FROM closed_turns WHERE id = ${turn.id}`;
                    yield* sql`INSERT INTO closed_turns
                        (id, thread_id, started_at, ended_at, reason, usage, cost_usd)
                      VALUES (${turn.id}, ${threadId}, ${turn.startedAt}, ${turn.endedAt ?? null},
                        ${turn.reason ?? null},
                        ${turn.usage === undefined ? null : toJson(UsageSummary, turn.usage)},
                        ${turn.usage?.costUsd ?? null})`;
                  }
                  yield* sql`DELETE FROM thread_plans WHERE thread_id = ${threadId}`;
                  const plan = moved.plan === undefined ? null : toJson(ThreadPlan, moved.plan);
                  const turnPlan =
                    moved.turnPlan === undefined ? null : toJson(TurnPlanJson, moved.turnPlan);
                  if (plan !== null || turnPlan !== null) {
                    yield* sql`INSERT INTO thread_plans (thread_id, plan, turn_plan, rev)
                      VALUES (${threadId}, ${plan}, ${turnPlan}, 1)`;
                  }
                  yield* sql`UPDATE closed_threads SET closed_at = ${moved.closedAt},
                      data = ${toJson(Thread, moved.thread)}
                    WHERE thread_id = ${threadId}`;
                }),
              )
              .pipe(
                Effect.catch((e) =>
                  e instanceof SqlError
                    ? Effect.fail(
                        new InvalidState({
                          message:
                            "The thread couldn't be stored here, and its copy here was kept as it was.",
                        }),
                      )
                    : Effect.fail(e),
                ),
              ),
          ),
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

        listOrchestrationEventsAfter: (workspaceId, afterSeq, kinds) =>
          run(eventsAfter(sql, workspaceId, afterSeq, kinds)),
        getDreamCursor: (id) => run(readDreamCursor(sql, id)),
        advanceDreamCursor: (id, cursor) => tx(advanceDreamCursor(sql, id, cursor)),
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
                        message: "That memory update no longer exists.",
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

        appendActorEvents: (entries) =>
          entries.length === 0
            ? Effect.succeed(0)
            : run(
                sql.withTransaction(
                  Effect.forEach(entries, (entry) =>
                    sql<{ seq: number }>`INSERT INTO actor_events
                        (at, actor_id, actor_name, actor_role, action, thread_id, workspace_id, data)
                        VALUES (${entry.at}, ${entry.actor.id}, ${entry.actor.name},
                          ${entry.actor.role}, ${entry.action}, ${entry.threadId ?? null},
                          ${entry.workspaceId ?? null}, ${JSON.stringify(entry.data)})
                        RETURNING seq`.pipe(Effect.map((rows) => Number(rows[0]!.seq))),
                  ).pipe(Effect.map((seqs) => seqs.at(-1) ?? 0)),
                ),
              ),
        listActorEvents: (options = {}) =>
          run(
            sql<{
              seq: number;
              at: number;
              actor_id: string;
              actor_name: string;
              actor_role: string;
              action: string;
              thread_id: string | null;
              workspace_id: string | null;
              data: string;
            }>`SELECT * FROM actor_events WHERE seq > ${options.afterSeq ?? 0}
              ORDER BY seq LIMIT ${Math.max(1, Math.min(options.limit ?? 200, 1_000))}`.pipe(
              Effect.map((rows) =>
                rows.map((r): ActorEventRecord => {
                  let data: Record<string, unknown> = {};
                  try {
                    const parsed: unknown = JSON.parse(r.data);
                    if (Predicate.isObject(parsed)) data = parsed;
                  } catch (_aRowWhoseDetailDoesntParseStillSaysWho) {}
                  return {
                    seq: Number(r.seq),
                    at: Number(r.at),
                    actor: { id: r.actor_id, name: r.actor_name, role: r.actor_role },
                    action: r.action,
                    ...(r.thread_id === null ? {} : { threadId: r.thread_id }),
                    ...(r.workspace_id === null ? {} : { workspaceId: r.workspace_id }),
                    data,
                  };
                }),
              ),
            ),
          ),

        personNames: (ids) =>
          run(
            Effect.forEach([...new Set(ids)].slice(0, PERSON_NAMES_MAX), (id) =>
              sql<{ actor_name: string }>`SELECT actor_name FROM actor_events
                  WHERE actor_id = ${id} ORDER BY seq DESC LIMIT 1`.pipe(
                Effect.map((rows) =>
                  rows[0] === undefined ? [] : [[id, rows[0].actor_name] as const],
                ),
              ),
            ).pipe(Effect.map((found) => new Map(found.flat()))),
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
                const thread = yield* readThread(ThreadId.make(row.id)).pipe(
                  Effect.catchTag("ThreadNotFound", () => Effect.succeed(undefined)),
                );
                if (thread?.spawnedBy?.feature !== from) continue;
                const after: Thread = {
                  ...thread,
                  spawnedBy: { ...thread.spawnedBy, feature: to },
                };
                renamed.push(yield* writeThread(after));
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
              return renamed;
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
        commitWorkspaceAudited: (change) =>
          Effect.forEach(change.register, (repo) =>
            originFor({ ...repo, repoRoot: repo.root }),
          ).pipe(
            Effect.flatMap((origins) =>
              tx(
                Effect.gen(function* () {
                  if (change.holds !== undefined && !change.holds(yield* readSettings)) {
                    return yield* Effect.fail(WORKSPACE_MOVED);
                  }
                  const current = yield* readWorkspace(change.id).pipe(
                    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
                  );
                  if (!change.unchanged(current)) return yield* Effect.fail(WORKSPACE_MOVED);
                  const projects: Array<Project> = [];
                  for (const [i, repo] of change.register.entries()) {
                    const registering = { ...repo, repoRoot: repo.root };
                    projects.push((yield* registerIn(registering, origins[i] ?? null)).project);
                  }
                  const next = change.next(current, projects);
                  if (next.workspace.id !== change.id) {
                    return yield* Effect.die(
                      new Error(`workspace ${change.id} cannot change its id`),
                    );
                  }
                  for (const id of next.workspace.projectIds) {
                    const [row] = yield* sql<{
                      root: string;
                    }>`SELECT root FROM projects WHERE id = ${id}`;
                    const checked = change.roots?.[id];
                    if (row === undefined || (checked !== undefined && row.root !== checked)) {
                      return yield* new NotFound({
                        entity: "project",
                        id,
                        message: "A project on the card no longer exists in Gram.",
                      });
                    }
                  }
                  yield* writeWorkspace(next);
                  const auditSeq = yield* insertSettingsAudit({
                    ...change.audit(next),
                    workspaceId: change.id,
                  });
                  return { state: next, auditSeq, projects };
                }),
              ).pipe(
                Effect.catchIf(
                  (e): e is typeof WORKSPACE_MOVED => e === WORKSPACE_MOVED,
                  () => Effect.succeed(undefined),
                ),
              ),
            ),
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
                  threadId: ThreadId.make(r.thread_id),
                  proposerRole: r.proposer_role,
                  scope:
                    r.scope === "project"
                      ? "project"
                      : r.scope === "workspace"
                        ? "workspace"
                        : "app",
                  ...(r.project_id == null ? {} : { projectId: ProjectId.make(r.project_id) }),
                  ...(r.workspace_id === null
                    ? {}
                    : { workspaceId: WorkspaceId.make(r.workspace_id) }),
                  ...(r.request_id === null ? {} : { requestId: r.request_id }),
                  approvedBy: "user",
                  approvedAt: Number(r.approved_at),
                  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the audit row holds the changes this store wrote as JSON
                  changes: JSON.parse(r.changes) as SettingsAuditEntry["changes"],
                  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the audit row holds the rows this store wrote as JSON
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
              yield* sql`INSERT INTO draft_stashes (id, thread_id, created_at, data)
                VALUES (${stash.id}, ${stash.threadId}, ${stash.createdAt}, ${toJson(DraftStash, stash)})
                ON CONFLICT (id) DO NOTHING`;
              const dropped = yield* sql<{ id: string; data: string }>`SELECT id, data
                FROM draft_stashes WHERE thread_id = ${stash.threadId}
                ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ${DRAFT_STASH_LIMIT}`;
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
   * Ordinary commits use NORMAL (no sync per streamed update); safety reservations use FULL.
   * The owned client replaces a connection whose durable-transaction cleanup failed. With
   * `writerOffLoop`, that connection runs on its own worker thread (`writer-worker.ts`), so no
   * statement on it holds the event loop.
   */
  static readonly layerSqlite = (
    filename: string,
    options: {
      readonly checkpointOffLoop?: boolean | undefined;
      readonly writerOffLoop?: boolean | undefined;
      readonly checkpointer?:
        | Omit<WalCheckpointer.CheckpointerOptions, "connectionPolicy">
        | undefined;
    } = {},
  ): Layer.Layer<ThreadStore | SqlClient.SqlClient, unknown> => {
    const seal = options.checkpointOffLoop === true ? UpdateSeal.layers(filename) : undefined;
    return Layer.suspend(() => {
      const policy = WalCheckpointer.makeConnectionPolicy();
      const initialize = (sql: SqlClient.SqlClient) =>
        configurePageCache(sql).pipe(Effect.andThen(policy.apply(sql)));
      return ThreadStore.layerNoDeps.pipe(
        Layer.provideMerge(
          options.checkpointOffLoop === true ? readWorkerLayer(filename) : Layer.empty,
        ),
        Layer.provideMerge(SearchCatchUp),
        Layer.provideMerge(MigrationsLayer),
        Layer.provideMerge(
          options.checkpointOffLoop === true
            ? WalCheckpointer.layer(filename, { ...options.checkpointer, connectionPolicy: policy })
            : Layer.empty,
        ),
        Layer.provideMerge(seal?.over ?? Layer.empty),
        Layer.provideMerge(
          durableSqliteLayer(
            options.writerOffLoop === true ? { filename, offLoop: true } : { filename },
            initialize,
          ),
        ),
        Layer.provideMerge(seal?.under ?? Layer.empty),
      );
    });
  };
}
