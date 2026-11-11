// Moving a workspace to another Gram: the bundle one server exports and another imports, and what
// an import is told and answers. Behind the hosted features setting (`embeddingOn`).
//
// A bundle is everything of a workspace that can live somewhere else: its charter and stages, its
// orchestrator's conversation, its memory, its feature cards and audit, and what its workers did.
// What is tied to the machine it came from stays there: agent sessions, worktrees, folder grants,
// approvals in flight and credentials are never in one.

import * as Schema from "effect/Schema";
import { PlanItem, Thread, UsageSummary } from "./domain.ts";
import { FeatureCard } from "./feature-cards.ts";
import { ProjectId, ThreadId, TurnId, WorkspaceId } from "./ids.ts";
import { WorkerReportState } from "./orchestration.ts";
import { ReviewBot } from "./review.ts";
import { WorkspaceSettings } from "./settings.ts";
import { ThreadPlan } from "./thread-plan.ts";
import { TurnEndReason, UIMessageSchema } from "./ui-message.ts";
import { WorkspaceState } from "./workspaces.ts";

/** The bundle's shape. A server reads only the format it writes. */
export const WORKSPACE_BUNDLE_FORMAT = 1;

/** The most workers one bundle tells of, live and archived each. */
export const BUNDLE_WORKERS_MAX = 500;
/** The most audit events one bundle carries; the newest are kept. */
export const BUNDLE_EVENTS_MAX = 50_000;
/** The most messages of the orchestrator's conversation one bundle carries. */
export const BUNDLE_MESSAGES_MAX = 200_000;
/** The largest bundle an import reads, in bytes. */
export const BUNDLE_MAX_BYTES = 256 * 1024 * 1024;

/** A repository of the workspace as its first server knew it. */
export const BundleProject = Schema.Struct({
  id: ProjectId,
  name: Schema.String,
  /** Where it was on the machine the bundle came from; only said, never opened by an import. */
  root: Schema.String,
  /** Its `origin`, without credentials, so whoever imports can find or clone the same repository. */
  remote: Schema.optionalKey(Schema.String),
});
export type BundleProject = typeof BundleProject.Type;

/** One stored message of the orchestrator's conversation, in order. */
export const BundleMessage = Schema.Struct({
  message: UIMessageSchema,
  turnId: Schema.optionalKey(TurnId),
});
export type BundleMessage = typeof BundleMessage.Type;

/** One turn of the orchestrator's conversation. Its file checkpoint stays with the checkout. */
export const BundleTurn = Schema.Struct({
  id: TurnId,
  startedAt: Schema.Number,
  endedAt: Schema.optionalKey(Schema.Number),
  reason: Schema.optionalKey(TurnEndReason),
  usage: Schema.optionalKey(UsageSummary),
});
export type BundleTurn = typeof BundleTurn.Type;

/** The orchestrator's thread: its record as it was, and its conversation. */
export const BundleOrchestrator = Schema.Struct({
  thread: Thread,
  messages: Schema.Array(BundleMessage).check(Schema.isMaxLength(BUNDLE_MESSAGES_MAX)),
  turns: Schema.Array(BundleTurn).check(Schema.isMaxLength(BUNDLE_MESSAGES_MAX)),
  plan: Schema.optionalKey(ThreadPlan),
  turnPlan: Schema.optionalKey(Schema.Array(PlanItem)),
});
export type BundleOrchestrator = typeof BundleOrchestrator.Type;

const Line = Schema.String.check(Schema.isMaxLength(2_000));

/**
 * A worker that was open when the workspace was exported. Its session and worktree stay behind,
 * so it arrives as a finished worker: what it was doing, where its work is, and its transcript.
 */
export const BundleWorker = Schema.Struct({
  threadId: ThreadId,
  title: Line,
  /** Absent for a thread that had joined the workspace without an orchestrator's brief. */
  feature: Schema.optionalKey(Line),
  projectId: ProjectId,
  branch: Schema.optionalKey(Line),
  base: Schema.optionalKey(Line),
  /** Its pull requests, as `owner/repo#N`. */
  prs: Schema.Array(Line).check(Schema.isMaxLength(50)),
  /** What it last reported, if it reported. */
  lastReport: Schema.optionalKey(
    Schema.Struct({ state: WorkerReportState, summary: Schema.String, at: Schema.Number }),
  ),
  /** Epoch ms it was marked completed, if it was. */
  completedAt: Schema.optionalKey(Schema.Number),
  /** Files changed in its worktree and not committed, which did not move. */
  uncommittedFiles: Schema.optionalKey(Schema.Int),
  /** Its conversation, rendered and scrubbed as the transcript archive keeps one. */
  transcript: Schema.optionalKey(Schema.String),
});
export type BundleWorker = typeof BundleWorker.Type;

/** A transcript the workspace's archive already held, of a thread closed before the move. */
export const BundleArchived = Schema.Struct({
  threadId: ThreadId,
  text: Schema.String,
  /** Epoch ms. */
  archivedAt: Schema.Number,
});
export type BundleArchived = typeof BundleArchived.Type;

/** One file of the orchestrator's adopted memory, by its path in the version. */
export const BundleMemoryFile = Schema.Struct({ path: Schema.String, content: Schema.String });
export type BundleMemoryFile = typeof BundleMemoryFile.Type;

/** One entry of the workspace's orchestration audit, which its budgets are counted from. */
export const BundleEvent = Schema.Struct({
  at: Schema.Number,
  kind: Schema.String.check(Schema.isMaxLength(200)),
  data: Schema.Unknown,
});
export type BundleEvent = typeof BundleEvent.Type;

/** A wake the orchestrator had set. It is told of them where it lands, and sets them again. */
export const BundleWake = Schema.Struct({ at: Schema.Number, note: Line });
export type BundleWake = typeof BundleWake.Type;

/**
 * The app settings that shape how any workspace runs, and nothing of the machine: no folder, no
 * login, no gateway and never the hosted features setting itself. An import applies them only
 * when asked to.
 */
export const BundleSettings = Schema.Struct({
  workspaces: Schema.optionalKey(WorkspaceSettings),
  reviewBots: Schema.optionalKey(Schema.Array(ReviewBot)),
});
export type BundleSettings = typeof BundleSettings.Type;

/** A workspace as one Gram exports it for another to import. */
export const WorkspaceBundle = Schema.Struct({
  format: Schema.Literal(WORKSPACE_BUNDLE_FORMAT),
  /** The Gram that wrote it: its version, and how many schema migrations its database had run. */
  app: Schema.Struct({ version: Schema.String, schema: Schema.Int }),
  /** Epoch ms. */
  exportedAt: Schema.Number,
  /** The workspace as stored, without a pause: it starts running where it lands. */
  workspace: WorkspaceState,
  projects: Schema.NonEmptyArray(BundleProject),
  /** Absent when no orchestrator was open. */
  orchestrator: Schema.optionalKey(BundleOrchestrator),
  workers: Schema.Array(BundleWorker).check(Schema.isMaxLength(BUNDLE_WORKERS_MAX)),
  archive: Schema.Array(BundleArchived).check(Schema.isMaxLength(BUNDLE_WORKERS_MAX)),
  memory: Schema.Array(BundleMemoryFile),
  featureCards: Schema.Array(FeatureCard).check(Schema.isMaxLength(5_000)),
  events: Schema.Array(BundleEvent).check(Schema.isMaxLength(BUNDLE_EVENTS_MAX)),
  /** How many digests the orchestrator had been sent, so their numbering carries on. */
  generation: Schema.Int,
  wakes: Schema.Array(BundleWake).check(Schema.isMaxLength(200)),
  settings: BundleSettings,
  /** What the export left behind or could not read, for whoever moves it to see. */
  notes: Schema.Array(Schema.String),
});
export type WorkspaceBundle = typeof WorkspaceBundle.Type;

/** `POST /workspaces/export`: the workspace to export. */
export const ExportWorkspaceInput = Schema.Struct({
  workspaceId: WorkspaceId,
  /**
   * Pauses the workspace here first, as the user's own pause, so it does not keep working on
   * what is moving. On unless `false`; a workspace exported only as a copy keeps running.
   */
  pause: Schema.optionalKey(Schema.Boolean),
});
export type ExportWorkspaceInput = typeof ExportWorkspaceInput.Type;

/** `POST /workspaces/import`: a bundle, and where each of its repositories is on this server. */
export const ImportWorkspaceInput = Schema.Struct({
  bundle: WorkspaceBundle,
  /**
   * By the bundle's project id: the top folder of that repository's main checkout here. Every
   * project of the workspace needs one; nothing is cloned or guessed.
   */
  projects: Schema.Record(Schema.String, Schema.Struct({ root: Schema.NonEmptyString })),
  /** Also takes the bundle's `settings`, over this server's own. Off unless `true`. */
  adoptSettings: Schema.optionalKey(Schema.Boolean),
});
export type ImportWorkspaceInput = typeof ImportWorkspaceInput.Type;

/**
 * What came of the orchestrator. `restored`: its thread is open again under its own id, with its
 * conversation, and has been sent what it needs to carry on. `none`: the bundle had no
 * orchestrator. `notOpened`: the workspace is here, and its orchestrator could not be opened;
 * `problem` says why.
 */
export const ImportedOrchestrator = Schema.Literals(["restored", "none", "notOpened"]);
export type ImportedOrchestrator = typeof ImportedOrchestrator.Type;

/** What an import made. */
export const ImportWorkspaceResult = Schema.Struct({
  workspace: WorkspaceState,
  orchestrator: ImportedOrchestrator,
  orchestratorThreadId: Schema.optionalKey(ThreadId),
  problem: Schema.optionalKey(Schema.String),
  /** How many transcripts of workers and closed threads are in the archive here now. */
  transcripts: Schema.Int,
  notes: Schema.Array(Schema.String),
});
export type ImportWorkspaceResult = typeof ImportWorkspaceResult.Type;

/** How many schema migrations a bundle may have run for this server, at `migrations`, to read it. */
export const bundleReadable = (bundle: Pick<WorkspaceBundle, "app">, migrations: number): boolean =>
  bundle.app.schema <= migrations;
