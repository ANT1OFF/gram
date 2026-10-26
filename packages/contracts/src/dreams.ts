// Dreams and history import: the reviewed job that
// rewrites an orchestrator's memory from past transcripts. A leaf beside `workspaces.ts`: it names
// `ModelRef`, `AgentKind` and `UsageSummary` from `domain.ts`, so `domain.ts` and what it imports
// can't import it without closing a cycle; `rpc.ts` and `ui-message.ts`, which sit above, do.

import * as Schema from "effect/Schema";
import { AgentKind, ModelRef, UsageSummary } from "./domain.ts";
import { ProjectId, ThreadId, WorkspaceId } from "./ids.ts";

/** One dream. It becomes a folder name under the workspace's memory, hence the narrow alphabet. */
export const DreamId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]{8,64}$/)).pipe(
  Schema.brand("DreamId"),
);
export type DreamId = typeof DreamId.Type;

/** Where a dream is; the names are Claude Managed Agents', so the concepts map. */
export const DreamStatus = Schema.Literals([
  "pending",
  "running",
  "completed",
  "failed",
  "canceled",
]);
export type DreamStatus = typeof DreamStatus.Type;

/**
 * Why a dream can't be adopted. `input_tampered`: an input file no longer matches the manifest the
 * server kept outside the dream folder. `over_caps`: the output breaks memory's path rules or caps.
 */
export const DreamFailure = Schema.Literals([
  "input_tampered",
  "agent_error",
  "canceled",
  "no_output",
  "missing_report",
  "over_caps",
]);
export type DreamFailure = typeof DreamFailure.Type;

/** A past conversation in an agent's own history, which outlives a closed thread. */
export const DreamAgentSession = Schema.Struct({
  agent: AgentKind,
  /** The folder the history is keyed by: a project root or one of its worktrees. */
  cwd: Schema.String,
  agentSessionId: Schema.String,
});
export type DreamAgentSession = typeof DreamAgentSession.Type;

/**
 * What a dream is for. `dream` consolidates the memory there is; `import` is the first dream, which
 * drafts memory from the user's past sessions in the workspace's repos.
 */
export const DreamKind = Schema.Literals(["dream", "import"]);
export type DreamKind = typeof DreamKind.Type;

/** Adoption policy for this run only. Omitted: review. */
export const DreamMode = Schema.Literals(["review", "auto"]);
export type DreamMode = typeof DreamMode.Type;

/** Automatic adoption stopped; the candidate stays available for inspection. */
export const DreamAdoptionFailure = Schema.Literals([
  "refused",
  "persistence_error",
  "interrupted",
]);
export type DreamAdoptionFailure = typeof DreamAdoptionFailure.Type;

/**
 * How far a dream read one Gram thread, open or archived: what its adoption moves that
 * thread's watermark to. `throughSeq` is the last `messages.seq` read; `throughId` and
 * `throughRev` are that message's id and the newest feed revision read, which tell a thread
 * rewound below the watermark (an edit and resend reuses seqs) from one that only grew.
 */
export const DreamRead = Schema.Struct({
  threadId: ThreadId,
  /** Where the text came from: the live thread, or the archive of a closed one. */
  source: Schema.Literals(["thread", "archive"]),
  /** The first seq read as new; the messages before it were context, already consolidated. */
  fromSeq: Schema.Int,
  throughSeq: Schema.Int,
  throughId: Schema.optionalKey(Schema.String),
  throughRev: Schema.optionalKey(Schema.Int),
  /** New messages read. */
  messages: Schema.Int,
  /** Characters over four of what was written for it. */
  estimatedTokens: Schema.Int,
  /** Its file under `input/sessions/`. */
  file: Schema.optionalKey(Schema.String),
  /** The thread was rewound below its mark, so the digest kept with it no longer holds. */
  rewound: Schema.optionalKey(Schema.Boolean),
});
export type DreamRead = typeof DreamRead.Type;

/** What a dream read: the memory version it started from and the transcripts beside it. */
export const DreamInputs = Schema.Struct({
  /** The adopted version the review diffs against, e.g. `0007`; `""` for an import into no memory. */
  memoryVersion: Schema.String,
  /** Server-owned source snapshot; auto adoption refuses any newer disk content. */
  memoryDigest: Schema.optionalKey(Schema.String),
  threadIds: Schema.Array(ThreadId),
  agentSessions: Schema.Array(DreamAgentSession),
  /** How far each Gram thread was read; absent reads none. */
  reads: Schema.optionalKey(Schema.Array(DreamRead)),
});
export type DreamInputs = typeof DreamInputs.Type;

/** The longest `Dream.instructions`, the hosted API's limit. */
export const DREAM_INSTRUCTIONS_MAX = 4096;
/** The most transcripts one dream reads; the rest wait for the next. */
export const DREAM_SESSIONS_MAX = 100;
/**
 * What one dream reads by default, in tokens by `estimateTokens`: about a busy day of a workspace,
 * an orchestrator thread and a handful of workers. What doesn't fit waits for the next dream.
 */
export const DREAM_BUDGET_TOKENS_DEFAULT = 200_000;
/** The longest rolling digest kept per thread with its watermark. */
export const DREAM_DIGEST_MAX_CHARS = 2000;
/** The smallest budget a dream may be given: room for a few of its longest messages. */
export const DREAM_BUDGET_TOKENS_MIN = 20_000;
/** The largest budget a dream may be given. */
export const DREAM_BUDGET_TOKENS_MAX = 2_000_000;

/** A dream's budget, as a payload carries it. */
export const DreamBudgetTokens = Schema.Int.check(
  Schema.isBetween({ minimum: DREAM_BUDGET_TOKENS_MIN, maximum: DREAM_BUDGET_TOKENS_MAX }),
);

/** What waits for the next dream: threads with new messages past this one's budget. */
export const DreamBacklog = Schema.Struct({
  threads: Schema.Int,
  messages: Schema.Int,
  /** Characters over four. */
  estimatedTokens: Schema.Int,
});
export type DreamBacklog = typeof DreamBacklog.Type;

/** What a `dream` would read now, counted before anything runs. */
export const DreamPlan = Schema.Struct({
  /** The adopted version it starts from, whose watermarks it reads past; `""` with no memory. */
  memoryVersion: Schema.String,
  /** Whether no thread has a watermark yet, so it reads every thread from its start. */
  fromStart: Schema.Boolean,
  /** Threads it reads, open or archived. */
  threads: Schema.Int,
  /** New messages it reads. */
  messages: Schema.Int,
  /** Characters over four of what it reads. */
  estimatedTokens: Schema.Int,
  budgetTokens: Schema.Int,
  backlog: DreamBacklog,
});
export type DreamPlan = typeof DreamPlan.Type;

/** A consolidation of one workspace's memory, run as a visible thread. */
export const Dream = Schema.Struct({
  id: DreamId,
  workspaceId: WorkspaceId,
  kind: DreamKind,
  mode: DreamMode,
  /** Completed output that auto mode could not persist safely; never a successful adoption. */
  adoptionFailure: Schema.optionalKey(DreamAdoptionFailure),
  status: DreamStatus,
  /** Present on a `failed` or `canceled` dream, which keeps its partial output for inspection. */
  failure: Schema.optionalKey(DreamFailure),
  inputs: DreamInputs,
  /** Synthesis guidance for the whole pass, not a line editor. */
  instructions: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(DREAM_INSTRUCTIONS_MAX))),
  model: ModelRef,
  /** The thread the dream runs as; absent until it starts. */
  threadId: Schema.optionalKey(ThreadId),
  /** The dream's own folder, which is its thread's cwd. */
  outputDir: Schema.String,
  usage: Schema.optionalKey(UsageSummary),
  /** Epoch ms. */
  createdAt: Schema.Number,
  /** Epoch ms when bridge access closed for final validation; absent until then. Server-owned. */
  filesClosedAt: Schema.optionalKey(Schema.Number),
  /** Epoch ms. */
  endedAt: Schema.optionalKey(Schema.Number),
  /** The memory version reviewed or automatic adoption made; an adopted dream is spent. */
  adoptedVersion: Schema.optionalKey(Schema.String),
  /** What the dream was started without, as sentences to show: sessions past the cap, agents that can't be read. */
  notes: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The tokens it was given to read; absent on an import. */
  budgetTokens: Schema.optionalKey(Schema.Int),
  /** What was past its budget when it started, left for the next dream. */
  backlog: Schema.optionalKey(DreamBacklog),
});
export type Dream = typeof Dream.Type;

/**
 * How much of one thread a memory version has consolidated. Stored per
 * version, so a discard never moves it and a Restore brings back the
 * one that version had. Not on the wire.
 */
export const DreamWatermark = Schema.Struct({
  threadId: ThreadId,
  /** The last `messages.seq` consolidated; 0 for none. */
  throughSeq: Schema.Int,
  /** That message's id; a different one there now means the thread was rewound below it. */
  throughId: Schema.optionalKey(Schema.String),
  /** The newest feed revision read: what a rewound thread's rewritten messages are told by. */
  throughRev: Schema.optionalKey(Schema.Int),
  /**
   * Epoch ms of the read: the start of the dream that made it.
   * Of two marks for one thread, the later read wins, and an archive written before it holds
   * nothing new.
   */
  readAt: Schema.Number,
  /**
   * A rolling summary of the thread through `throughSeq`, from the pass-1 notes of the dream that
   * read it: what the next dream gets instead of the old messages. Scrubbed, at most
   * `DREAM_DIGEST_MAX_CHARS`. Transcript-derived, so it is never logged and goes with its thread.
   */
  digest: Schema.optionalKey(Schema.String),
});
export type DreamWatermark = typeof DreamWatermark.Type;

/** One kept version of a workspace's memory, for the Memory tab's Restore. */
export const MemoryVersionInfo = Schema.Struct({
  /** `0007`. */
  version: Schema.String,
  /** Epoch ms. */
  adoptedAt: Schema.Number,
  files: Schema.Int,
  /** Whether it is the adopted one. */
  current: Schema.Boolean,
});
export type MemoryVersionInfo = typeof MemoryVersionInfo.Type;

/** One file of the adopted memory version. */
export const MemoryFileInfo = Schema.Struct({
  /** POSIX path relative to the version. */
  path: Schema.String,
  bytes: Schema.Int,
  /** Epoch ms. */
  modifiedAt: Schema.Number,
});
export type MemoryFileInfo = typeof MemoryFileInfo.Type;

/**
 * How a dream's output treats one memory file. `conflict`: the orchestrator wrote the file after
 * the dream copied it and the dream changes it too, so adopting would lose the live write.
 */
export const DreamFileStatus = Schema.Literals([
  "added",
  "changed",
  "removed",
  "unchanged",
  "conflict",
]);
export type DreamFileStatus = typeof DreamFileStatus.Type;

/** Where a model's merge of one `conflict` file stands. */
export const DreamMergeStatus = Schema.Literals(["running", "done", "failed"]);
export type DreamMergeStatus = typeof DreamMergeStatus.Type;

/**
 * A model's merge of both sides of a `conflict`: the dream's output and memory as it is now, read
 * against what the dream started from. The server keeps it with the review it was asked for, so an
 * adoption's `merged` takes this text and never one the client sends.
 */
export const DreamMerge = Schema.Struct({
  status: DreamMergeStatus,
  /** What it runs on: the dream's own agent and model. */
  model: ModelRef,
  /** Epoch ms. */
  startedAt: Schema.Number,
  /** Epoch ms. */
  endedAt: Schema.optionalKey(Schema.Number),
  /** On `done`: the merged file, scrubbed and within memory's caps. */
  merged: Schema.optionalKey(Schema.String),
  /** On `failed`: why, as a sentence to show. */
  error: Schema.optionalKey(Schema.String),
});
export type DreamMerge = typeof DreamMerge.Type;

/** One file of the review, against the memory version the dream started from. */
export const DreamFileDiff = Schema.Struct({
  /** POSIX path relative to the memory version. */
  path: Schema.String,
  status: DreamFileStatus,
  /** The file in the version the dream started from; absent when it wasn't there. */
  before: Schema.optionalKey(Schema.String),
  /** The file in the dream's output; absent when the dream removes it. */
  after: Schema.optionalKey(Schema.String),
  /** On a `conflict` only: the file as memory holds it now. */
  current: Schema.optionalKey(Schema.String),
  /** On a `conflict` only: the merge last asked for, while all three sides are what it read. */
  merge: Schema.optionalKey(DreamMerge),
});
export type DreamFileDiff = typeof DreamFileDiff.Type;

/** What the user reads before Adopt or Discard. */
export const DreamReview = Schema.Struct({
  dream: Dream,
  /** The adopted version `files` were compared with; pass it back as `dream.adopt`'s `basedOn`. */
  memoryVersion: Schema.optionalKey(Schema.String),
  /** Fingerprint of current memory shown in this review, including same-version live writes. */
  memoryDigest: Schema.optionalKey(Schema.String),
  /**
   * A fingerprint of the output `files` were computed from; pass it back as `dream.adopt`'s
   * `outputDigest`, so an output rewritten after this review isn't adopted unseen.
   */
  outputDigest: Schema.optionalKey(Schema.String),
  files: Schema.Array(DreamFileDiff),
  /** `output/REPORT.md`: merged, dropped and why, new with sources, unresolved. Never memory. */
  report: Schema.optionalKey(Schema.String),
});
export type DreamReview = typeof DreamReview.Type;

/** How a finished dream's card in its own thread sums one file up; the texts are in `dream.review`. */
export const DreamReportFile = Schema.Struct({ path: Schema.String, status: DreamFileStatus });
export type DreamReportFile = typeof DreamReportFile.Type;

/** The longest `DreamReport.reportExcerpt`. */
export const DREAM_REPORT_EXCERPT_MAX = 2000;

/** The `data-dream-report` part: where a dream ended, in the thread it ran as. */
export const DreamReport = Schema.Struct({
  dreamId: DreamId,
  status: DreamStatus,
  mode: Schema.optionalKey(DreamMode),
  adoptedVersion: Schema.optionalKey(Schema.String),
  adoptionFailure: Schema.optionalKey(DreamAdoptionFailure),
  failure: Schema.optionalKey(DreamFailure),
  files: Schema.Array(DreamReportFile),
  /** The start of `output/REPORT.md`. */
  reportExcerpt: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(DREAM_REPORT_EXCERPT_MAX)),
  ),
});
export type DreamReport = typeof DreamReport.Type;

/**
 * Which side of a `conflict` an adoption takes: the dream's `output`, memory as it is `current`ly,
 * or the finished `merged` text of both that `dream.merge` made.
 */
export const DreamResolution = Schema.Literals(["output", "current", "merged"]);
export type DreamResolution = typeof DreamResolution.Type;

/** What an import found for one project, agent and folder, counted before anything runs. */
export const ImportSourcePreview = Schema.Struct({
  projectId: ProjectId,
  /** The project's name. */
  project: Schema.String,
  agent: AgentKind,
  cwd: Schema.String,
  sessions: Schema.Int,
  /** Epoch ms of the oldest session found. */
  oldest: Schema.optionalKey(Schema.Number),
  /** Epoch ms of the newest session found. */
  newest: Schema.optionalKey(Schema.Number),
  /** Characters over four: enough to show the order of magnitude of the cost. */
  estimatedTokens: Schema.Int,
});
export type ImportSourcePreview = typeof ImportSourcePreview.Type;

/** The import preview: what is really there, so a thin result shows before tokens are spent. */
export const ImportPreview = Schema.Struct({
  sources: Schema.Array(ImportSourcePreview),
  /** Existing worktrees whose history was asked for, of `worktreesTotal`; removed ones aren't reachable. */
  worktreesCovered: Schema.Int,
  worktreesTotal: Schema.Int,
  /** Closed Gram threads still in the closed-thread stack, which keeps only the newest few. */
  closedThreadsKept: Schema.Int,
  /** Closed threads of this workspace whose transcripts the archive holds, which outlives that stack. */
  archivedThreads: Schema.optionalKey(Schema.Int),
  /** Claude Code memory files found for those folders, read only when the import asks for them. */
  seedFiles: Schema.optionalKey(Schema.Int),
  /** Caveats to show as they are, e.g. that the text goes through the gateway. */
  notes: Schema.Array(Schema.String),
  /** On a `dream`'s preview: what it would read past the watermarks, and what waits. */
  dream: Schema.optionalKey(DreamPlan),
});
export type ImportPreview = typeof ImportPreview.Type;

/** Who spoke in a past conversation. */
export const SessionTranscriptRole = Schema.Literals(["user", "assistant", "system"]);
export type SessionTranscriptRole = typeof SessionTranscriptRole.Type;

/** One tool call of a past conversation, with both sides already cut to a readable size. */
export const SessionTranscriptTool = Schema.Struct({
  name: Schema.String,
  input: Schema.optionalKey(Schema.String),
  output: Schema.optionalKey(Schema.String),
});
export type SessionTranscriptTool = typeof SessionTranscriptTool.Type;

/** One message of a past conversation, agent-neutral: visible text and the tools it called. */
export const SessionTranscriptMessage = Schema.Struct({
  role: SessionTranscriptRole,
  text: Schema.String,
  tools: Schema.optionalKey(Schema.Array(SessionTranscriptTool)),
  /** Epoch ms; absent where the agent's history doesn't say. */
  at: Schema.optionalKey(Schema.Number),
});
export type SessionTranscriptMessage = typeof SessionTranscriptMessage.Type;

/** A whole past conversation from an agent's own history, what `AgentHost.readSession` returns. */
export const SessionTranscript = Schema.Struct({
  agentSessionId: Schema.String,
  cwd: Schema.String,
  /** The main conversation only; subagent turns are left out. */
  messages: Schema.Array(SessionTranscriptMessage),
});
export type SessionTranscript = typeof SessionTranscript.Type;

/** Automatic launch progress, separate from a run's adoption mode. */
export const AutomaticDreamStatus = Schema.Struct({
  threshold: Schema.optionalKey(Schema.Int),
  completed: Schema.Int,
  detail: Schema.String,
});
export type AutomaticDreamStatus = typeof AutomaticDreamStatus.Type;
