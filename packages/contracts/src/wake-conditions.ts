// Condition wakes: what a `schedule_wake` may wait on beside a time, as a closed union of kinds.
//
// A leaf like `orchestration.ts`, which imports it. Each kind is a member of `WakeCondition`, has its
// words in `wakeConditionWhen`, and a source on the server (`packages/server/src/wakes/conditions.ts`)
// that takes its baseline when the wake is set and looks whether it is met. Adding a kind is adding
// those three; see docs/AGENTS_AND_FEATURES.md#condition-wakes.

import * as Schema from "effect/Schema";
import { ThreadId, WorkspaceId } from "./ids.ts";

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

/** The minutes a `ciStuck` wake lets a job sit queued when it names none. */
export const CI_STUCK_DEFAULT_MINUTES = 15;

/**
 * A hosted CI job sits queued, with no runner, for `queuedMinutes` (filled in with
 * `CI_STUCK_DEFAULT_MINUTES`); or a run waits for a maintainer to approve it, as a fork's does. Of a
 * PR's checks, or of one Actions run; without either, the waiting thread's bound PR.
 */
export const CiStuckCondition = Schema.Struct({
  kind: Schema.Literal("ciStuck"),
  repo: RepoName,
  // Finite rather than Int: a tool's input schema is read at every session's start, and an Int's
  // bounds cost twice its words there. The source refuses a fraction.
  pr: Schema.optionalKey(Schema.Finite),
  runId: Schema.optionalKey(Schema.Finite),
  queuedMinutes: Schema.optionalKey(Schema.Finite),
});
export type CiStuckCondition = typeof CiStuckCondition.Type;

/** The minutes a `machine` load wake wants the load to stay low when it names none. */
export const MACHINE_LOAD_DEFAULT_MINUTES = 5;

/**
 * This machine's 1-minute load average, absolute as `uptime` shows it (not divided by its CPUs),
 * stays below `below` for `forMinutes` (filled in with `MACHINE_LOAD_DEFAULT_MINUTES`).
 */
export const MachineLoadCondition = Schema.Struct({
  kind: Schema.Literal("machine"),
  metric: Schema.Literal("load"),
  below: Schema.Finite,
  forMinutes: Schema.optionalKey(Schema.Finite),
});
export type MachineLoadCondition = typeof MachineLoadCondition.Type;

/**
 * Free space on the volume holding `path` (filled in with the waiting thread's repo) drops below
 * `belowGB`, in GB of 10^9 bytes as Finder and `df -H` count them.
 */
export const DiskFreeCondition = Schema.Struct({
  kind: Schema.Literal("machine"),
  metric: Schema.Literal("diskFree"),
  belowGB: Schema.Finite,
  path: Schema.optionalKey(Schema.String),
});
export type DiskFreeCondition = typeof DiskFreeCondition.Type;

/**
 * A merge freeze on a repo's branch (`merge_freeze`) is lifted or expires; without `branch`, the
 * freeze on the repo there is when the wake is set.
 */
export const FreezeLiftedCondition = Schema.Struct({
  kind: Schema.Literal("freezeLifted"),
  repo: RepoName,
  /** Filled in with the frozen branch when the wake is set without one. */
  branch: Schema.optionalKey(BranchName),
});
export type FreezeLiftedCondition = typeof FreezeLiftedCondition.Type;

/** `1.2.3`, `v1.2.3` or `1.2.3-beta.1`: a release's version, as `after` and `from` name one. */
export const ReleaseVersion = Schema.String.check(
  Schema.isPattern(/^v?\d+\.\d+\.\d+(-[\w.-]{1,40})?$/),
);

/** An npm package (`@scope/name`) or a GitHub repo (`owner/repo`), never starting with a dash. */
export const ReleaseName = Schema.String.check(Schema.isPattern(/^@?[\w.~][\w.~-]*(\/[\w.~-]+)?$/));

/** How old a release must be before it wakes anyone, by default: Gram's own Dependabot cooldown. */
export const RELEASE_MIN_AGE_DAYS = 7;

/**
 * A package or tool publishes a version newer than `after`, at least `minAgeDays` old, from the npm
 * registry or a GitHub repo's releases. Prereleases (and GitHub's drafts) don't count unless
 * `includePrerelease`.
 */
export const ReleasePublishedCondition = Schema.Struct({
  kind: Schema.Literal("releasePublished"),
  source: Schema.Literals(["npm", "github"]),
  name: ReleaseName,
  /** Filled in with the latest release when the wake is set without one. */
  after: Schema.optionalKey(ReleaseVersion),
  /**
   * Filled in with `RELEASE_MIN_AGE_DAYS` when the wake is set without one; 0 for none. Finite, as
   * `ciStuck`'s numbers are, to keep the tool's schema short; the source refuses one outside 0..90.
   */
  minAgeDays: Schema.optionalKey(Schema.Finite),
  includePrerelease: Schema.optionalKey(Schema.Boolean),
});
export type ReleasePublishedCondition = typeof ReleasePublishedCondition.Type;

/** What `versionChanged` can watch: Gram itself, or a CLI the launch checks probe. */
export const VersionTarget = Schema.Literals(["gram", "claude", "codex", "gh"]);
export type VersionTarget = typeof VersionTarget.Type;

/**
 * The installed version of Gram or a CLI changes from `from`: Gram's is seen at the start after an
 * update, a CLI's whenever Gram's launch checks run again.
 */
export const VersionChangedCondition = Schema.Struct({
  kind: Schema.Literal("versionChanged"),
  target: VersionTarget,
  /** Filled in with the installed version when the wake is set without one. */
  from: Schema.optionalKey(ReleaseVersion),
});
export type VersionChangedCondition = typeof VersionChangedCondition.Type;

/** Everything a wake can wait on beside its time. Closed: an unknown kind doesn't decode. */
export const WakeCondition = Schema.Union([
  BranchMovedCondition,
  ThreadFinishedCondition,
  CiStuckCondition,
  MachineLoadCondition,
  DiskFreeCondition,
  FreezeLiftedCondition,
  ReleasePublishedCondition,
  VersionChangedCondition,
]);
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

const VERSION_TARGET_NAMES: Readonly<Record<VersionTarget, string>> = {
  gram: "Gram",
  claude: "Claude Code",
  codex: "Codex",
  gh: "gh",
};

/** `codex` for `@openai/codex` or `openai/codex`: a release's name, short. */
const shortName = (name: string): string => name.slice(name.lastIndexOf("/") + 1);

/** How old a release must be, in words: ", at least 7 days old"; nothing for no age. */
const ageWords = (condition: ReleasePublishedCondition, least = "at least "): string => {
  const days = condition.minAgeDays ?? RELEASE_MIN_AGE_DAYS;
  return days === 0 ? "" : `, ${least}${days} ${days === 1 ? "day" : "days"} old`;
};

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
    case "ciStuck":
      return `a CI job of ${ciTarget(condition)} sits queued ${ciMinutes(condition)}+ min, or a run awaits approval`;
    case "machine":
      return condition.metric === "load"
        ? `this machine's load stays below ${condition.below} for ${condition.forMinutes ?? MACHINE_LOAD_DEFAULT_MINUTES} min`
        : `free disk space${condition.path === undefined ? "" : ` at ${condition.path}`} drops below ${condition.belowGB} GB`;
    case "freezeLifted":
      return `${condition.repo} ${condition.branch ?? "default branch"} is no longer frozen`;
    case "releasePublished": {
      const what = condition.includePrerelease === true ? "release or prerelease" : "release";
      const newer =
        condition.after === undefined ? `a new ${what}` : `a ${what} newer than ${condition.after}`;
      const where = condition.source === "npm" ? "npm" : "GitHub";
      return `${condition.name} on ${where} has ${newer}${ageWords(condition)}`;
    }
    case "versionChanged": {
      const target = VERSION_TARGET_NAMES[condition.target];
      const from = condition.from === undefined ? "" : ` from ${condition.from}`;
      return condition.target === "gram"
        ? `Gram is updated${from}`
        : `the installed ${target} changes${from}`;
    }
  }
};

const ciTarget = (condition: CiStuckCondition) =>
  condition.runId !== undefined
    ? `${condition.repo} run ${condition.runId}`
    : `${condition.repo}${condition.pr === undefined ? "" : `#${condition.pr}`}`;

const ciMinutes = (condition: CiStuckCondition) =>
  condition.queuedMinutes ?? CI_STUCK_DEFAULT_MINUTES;

/** A chip's short label for a condition: the branch, the thread, the CI, the load or the disk. */
export const wakeConditionLabel = (condition: WakeCondition): string => {
  switch (condition.kind) {
    case "branchMoved":
      return condition.branch ?? condition.repo;
    case "threadFinished":
      return "thread";
    case "ciStuck":
      return `CI job queued ${ciMinutes(condition)}+ min`;
    case "machine":
      return condition.metric === "load"
        ? `quieter (load < ${condition.below})`
        : `disk < ${condition.belowGB} GB`;
    case "freezeLifted":
      return `${condition.branch ?? condition.repo} thaw`;
    case "releasePublished":
      return `${shortName(condition.name)} ${condition.after === undefined ? "release" : `newer than ${condition.after}`}${ageWords(condition, "")}`;
    case "versionChanged":
      return `${VERSION_TARGET_NAMES[condition.target]} update`;
  }
};

/** The longest a merge freeze lasts before it expires on its own; a renewal starts it again. */
export const MERGE_FREEZE_MAX_MINUTES = 60;
/** The longest reason a merge freeze carries. */
export const MERGE_FREEZE_REASON_MAX = 200;
/**
 * The longest a freeze may stand, renewals included, from when it was first set: then it ends, and
 * the merges it held go, even if its thread freezes the branch again right after.
 */
export const MERGE_FREEZE_TOTAL_MAX_MINUTES = 240;
/** How many PRs a merge freeze may let through (`MergeFreeze.allow`). */
export const MERGE_FREEZE_ALLOW_MAX = 4;

/**
 * A thread's freeze on merges to a repo's branch (`merge_freeze`): Gram's own merges onto it
 * (`merge_when_ready`, `set_auto_merge`) wait until it is lifted or expires, except the PRs it
 * allows. GitHub auto-merge that Gram's threads' PRs had armed is turned off for its time and armed
 * again after. It can't stop a person, or an auto-merge or merge-queue entry on any other PR. It
 * always expires at `until`, whatever becomes of the thread.
 */
export const MergeFreeze = Schema.Struct({
  repo: RepoName,
  branch: BranchName,
  /** The thread that froze it, which may renew or lift it; its workspace's orchestrator may lift it. */
  threadId: ThreadId,
  /** The thread's title when it froze it, for the line that says who. */
  title: Schema.String,
  workspaceId: Schema.optionalKey(WorkspaceId),
  reason: Schema.String.check(Schema.isMaxLength(MERGE_FREEZE_REASON_MAX)),
  /** PR numbers in the repo that may still merge, such as the release PR the freeze is for. */
  allow: Schema.optionalKey(
    Schema.Array(Schema.Int).check(Schema.isMaxLength(MERGE_FREEZE_ALLOW_MAX)),
  ),
  /** PRs whose GitHub auto-merge the freeze turned off, to arm again with its method once it ends. */
  disarmed: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        number: Schema.Int,
        method: Schema.Literals(["squash", "merge", "rebase"]),
      }),
    ),
  ),
  /** Epoch ms it was frozen, or last renewed. */
  at: Schema.Number,
  /** Epoch ms it was first frozen, which renewals keep: it stands `MERGE_FREEZE_TOTAL_MAX_MINUTES` at most. */
  since: Schema.optionalKey(Schema.Number),
  /** Epoch ms it expires. */
  until: Schema.Number,
});
export type MergeFreeze = typeof MergeFreeze.Type;

/** `"main is frozen by "Release 1.6" for the release cut until 14:05Z"`: why a merge waits. */
export const mergeFreezeText = (freeze: MergeFreeze): string =>
  `${freeze.branch} is frozen by "${freeze.title}" for ${freeze.reason} until ${new Date(freeze.until).toISOString().slice(11, 16)}Z${
    freeze.allow === undefined || freeze.allow.length === 0
      ? ""
      : ` (except ${freeze.allow.map((n) => `#${n}`).join(", ")})`
  }`;

/** Whether `freeze` holds back a merge of PR `number`: every PR but those it allows. */
export const mergeFreezeHolds = (freeze: MergeFreeze, number: number | undefined): boolean =>
  number === undefined || !(freeze.allow ?? []).includes(number);
