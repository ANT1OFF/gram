// Condition wakes: what a `schedule_wake` may wait on beside a time, as a closed union of kinds.
//
// A leaf like `orchestration.ts`, which imports it. Each kind is a member of `WakeCondition`, has its
// words in `wakeConditionWhen`, and a source on the server (`packages/server/src/wakes/conditions.ts`)
// that takes its baseline when the wake is set and looks whether it is met. Adding a kind is adding
// those three; see docs/AGENTS_AND_FEATURES.md#condition-wakes.

import * as Schema from "effect/Schema";
import { ThreadId } from "./ids.ts";

/**
 * The version of the stored condition shapes. A wake keeps it beside its condition
 * (`StoredWakeCondition.v`), so a build that reads a version it doesn't know leaves the row
 * unread rather than misreading it. New kinds and new optional fields keep the version; a change to
 * what an existing field means bumps it.
 */
export const WAKE_CONDITION_VERSION = 1;

/** `owner/repo`. */
export const RepoName = Schema.String.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/));

/** A branch name, as git allows it, without `..` or a leading dash. */
export const BranchName = Schema.String.check(Schema.isPattern(/^(?!-)(?!.*\.\.)[\w./-]{1,200}$/));

/** A new commit lands at the head of a repo's branch; without `branch`, its default branch. */
export const BranchMovedCondition = Schema.Struct({
  kind: Schema.Literal("branchMoved"),
  repo: RepoName,
  /** Filled in with the repo's default branch when the wake is set without one. */
  branch: Schema.optionalKey(BranchName),
});
export type BranchMovedCondition = typeof BranchMovedCondition.Type;

/**
 * Another thread is finished: it reports `done` or is marked completed, or it is at rest after
 * reporting; or it is archived or closed, which also ends the wait.
 */
export const ThreadFinishedCondition = Schema.Struct({
  kind: Schema.Literal("threadFinished"),
  threadId: ThreadId,
});
export type ThreadFinishedCondition = typeof ThreadFinishedCondition.Type;

/** Everything a wake can wait on beside its time. Closed: an unknown kind doesn't decode. */
export const WakeCondition = Schema.Union([BranchMovedCondition, ThreadFinishedCondition]);
export type WakeCondition = typeof WakeCondition.Type;
export type WakeConditionKind = WakeCondition["kind"];

/**
 * What a condition's source last saw, which its next look is measured from: a head, a report
 * time. Its own small record of strings; nothing else reads it.
 */
export const WakeConditionSeen = Schema.Record(Schema.String, Schema.String);
export type WakeConditionSeen = typeof WakeConditionSeen.Type;

/**
 * The look that found a condition met, kept from then until the wake is delivered: a parked
 * thread, a paused workspace or a restart still delivers it as it was found. `facts` are server
 * words (a head, an outcome), shown to the thread in a fenced block.
 */
export const WakeConditionFired = Schema.Struct({
  kind: Schema.String,
  /** Epoch ms it was found met. */
  at: Schema.Number,
  facts: Schema.Record(Schema.String, Schema.String),
});
export type WakeConditionFired = typeof WakeConditionFired.Type;

/** A condition as a pending wake stores it, with its version and what it has seen and found. */
export const StoredWakeCondition = Schema.Struct({
  v: Schema.Literal(WAKE_CONDITION_VERSION),
  spec: WakeCondition,
  seen: Schema.optionalKey(WakeConditionSeen),
  fired: Schema.optionalKey(WakeConditionFired),
});
export type StoredWakeCondition = typeof StoredWakeCondition.Type;

/**
 * "acme/web main moves": what a condition waits for, in words, for the ledger, the chips and the
 * notices. `name` is how the waiting side names another thread, when it knows its title.
 */
export const wakeConditionWhen = (condition: WakeCondition, name?: string): string => {
  switch (condition.kind) {
    case "branchMoved":
      return `${condition.repo} ${condition.branch ?? "default branch"} gets a new head`;
    case "threadFinished":
      return `${name === undefined ? `thread ${condition.threadId}` : `"${name}"`} finishes`;
  }
};

/** A chip's short label for a condition: the branch, or the thread. */
export const wakeConditionLabel = (condition: WakeCondition): string => {
  switch (condition.kind) {
    case "branchMoved":
      return condition.branch ?? condition.repo;
    case "threadFinished":
      return "thread";
  }
};
