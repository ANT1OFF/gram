import * as Schema from "effect/Schema";

import { CompletedReason } from "./domain.ts";
import { ThreadId, WorkspaceId } from "./ids.ts";
import { fileEditsOf } from "./file-edit.ts";
import { WorkerReport } from "./orchestration.ts";
import { UIMessageSchema, type GramUIMessage } from "./ui-message.ts";

// Reaching workers that are finished or stalled: a worker whose worktree the sweep cleaned up stays
// readable from what Gram already keeps of it, and one that hasn't moved in a while gets a "Why is it
// stuck?" line with a nudge the user picks.

/** A PR a finished worker followed, from its closed record. */
export const FinishedWorkerPr = Schema.Struct({
  /** `owner/repo`. */
  repo: Schema.String,
  number: Schema.Int,
  url: Schema.String,
  /** The thread was completed by this PR's merge. */
  merged: Schema.optionalKey(Schema.Literal(true)),
});
export type FinishedWorkerPr = typeof FinishedWorkerPr.Type;

/** A file a finished worker changed, summed over the edits in its transcript. */
export const FinishedWorkerFile = Schema.Struct({
  path: Schema.String,
  additions: Schema.Int,
  deletions: Schema.Int,
});
export type FinishedWorkerFile = typeof FinishedWorkerFile.Type;

/**
 * A worker the sweep (or the user) closed with its worktree, as ⌘J lists it. `kept` is how much of
 * it Gram still has: `closed` while it is on the reopen list, with its record, reports and
 * conversation; `archived` once only the workspace's transcript archive has it.
 */
export const FinishedWorker = Schema.Struct({
  threadId: ThreadId,
  workspaceId: WorkspaceId,
  title: Schema.String,
  feature: Schema.String,
  /** The orchestrator it reported to, while the record says. */
  orchestratorThreadId: Schema.optionalKey(ThreadId),
  /** Epoch ms it was closed (or archived). */
  closedAt: Schema.Number,
  completedReason: Schema.optionalKey(CompletedReason),
  lastReport: Schema.optionalKey(WorkerReport),
  prs: Schema.Array(FinishedWorkerPr),
  kept: Schema.Literals(["closed", "archived"]),
});
export type FinishedWorker = typeof FinishedWorker.Type;

/** The most messages `orchestrator.finishedWorker` returns, newest kept. */
export const FINISHED_WORKER_MESSAGES_MAX = 400;
/** The most characters of the brief the finished view quotes. */
export const FINISHED_WORKER_BRIEF_MAX = 600;

/** One finished worker, read-only: what it was asked, said, changed and opened. */
export const FinishedWorkerDetail = Schema.Struct({
  worker: FinishedWorker,
  /** The first words it was given, from its orchestrator. */
  brief: Schema.optionalKey(Schema.String),
  /** Its reports, oldest first. */
  reports: Schema.Array(WorkerReport),
  files: Schema.Array(FinishedWorkerFile),
  /** Its conversation as it was closed, the last `FINISHED_WORKER_MESSAGES_MAX`; empty if archived. */
  messages: Schema.Array(UIMessageSchema),
  /** Messages left out before `messages`. */
  earlierOmitted: Schema.Int,
  /** The archived transcript (markdown), when the conversation itself is no longer kept. */
  archived: Schema.optionalKey(Schema.String),
});
export type FinishedWorkerDetail = typeof FinishedWorkerDetail.Type;

/**
 * How long a worker has to sit without moving before "Why is it stuck?" offers itself: no turn, no
 * tool call, no report for this long, while it is neither finished nor waiting on the user.
 */
export const STUCK_AFTER_MS = 45 * 60_000;

/** The facts "Why is it stuck?" stands on, which the view shows as they are when helpers are off. */
export const StuckFacts = Schema.Struct({
  /** Epoch ms it last moved. */
  idleSince: Schema.Number,
  /** Its latest report, if any. */
  lastReport: Schema.optionalKey(WorkerReport),
  /** How its last turn ended, when it failed. */
  lastError: Schema.optionalKey(Schema.String),
  /** The last tool it ran, in a few words ("Bash uv run pytest"). */
  lastTool: Schema.optionalKey(Schema.String),
  /** Its PRs as the ledger reads them: `api#212 checks failing`. */
  prs: Schema.Array(Schema.String),
});
export type StuckFacts = typeof StuckFacts.Type;

/** The most characters the helper's sentence may have. */
export const STUCK_MAX_CHARS = 200;

/** What the helper said holds the worker up, one sentence. */
export const WorkerStuck = Schema.Struct({ stuck: Schema.String });
export type WorkerStuck = typeof WorkerStuck.Type;

/**
 * `thread.whyStuck`'s answer: the facts, and the helper's one sentence on them when it is on,
 * allowed the conversation and answered within its rules. It never acts on the worker.
 */
export const StuckView = Schema.Struct({
  threadId: ThreadId,
  facts: StuckFacts,
  text: Schema.optionalKey(Schema.String),
});
export type StuckView = typeof StuckView.Type;

/** Whether a worker idle since `idleSince` has sat long enough at `now` to ask why. */
export const stuckDue = (idleSince: number, now: number): boolean =>
  now - idleSince >= STUCK_AFTER_MS;

/** The files the conversation's edits changed, in the order first touched, with lines summed. */
export const changedFilesOf = (
  messages: ReadonlyArray<GramUIMessage>,
): ReadonlyArray<FinishedWorkerFile> => {
  const files = new Map<string, { additions: number; deletions: number }>();
  for (const message of messages) {
    for (const part of message.parts) {
      const name =
        part.type === "dynamic-tool"
          ? part.toolName
          : part.type.startsWith("tool-")
            ? part.type.slice("tool-".length)
            : undefined;
      if (name === undefined || !("input" in part)) continue;
      const output = part.state === "output-available" ? part.output : undefined;
      for (const edit of fileEditsOf(name, part.input, output)) {
        const path = edit.movedTo ?? edit.path;
        const seen = files.get(path) ?? { additions: 0, deletions: 0 };
        files.set(path, {
          additions: seen.additions + edit.additions,
          deletions: seen.deletions + edit.deletions,
        });
      }
    }
  }
  return [...files].map(([path, counts]) => ({ path, ...counts }));
};

/** The first words the worker was given: its first user message's text, capped. */
export const briefOf = (messages: ReadonlyArray<GramUIMessage>): string | undefined => {
  const first = messages.find((message) => message.role === "user");
  const text = first?.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
  if (text === undefined || text === "") return undefined;
  return text.length <= FINISHED_WORKER_BRIEF_MAX
    ? text
    : `${text.slice(0, FINISHED_WORKER_BRIEF_MAX - 1).trimEnd()}…`;
};
