// What a host keeps of its threads' work when it stops, and what it puts back after.

import * as Schema from "effect/Schema";
import { ThreadId } from "../ids.ts";
import { SavedDiff } from "../saved-work.ts";

/** What keeps a host from updating now: work that a restart would cut off. */
export const HostBusy = Schema.Struct({
  /** Agent sessions in a turn, waiting on a question, or with background tasks running. */
  turns: Schema.Int,
  /** Terminals running a command, or a sign-in shell still open. */
  terminals: Schema.Int,
  /** Clones or fetches of a repository in flight. */
  clones: Schema.Int,
  /** Project checks running or waiting their turn. */
  checks: Schema.Int,
});
export type HostBusy = typeof HostBusy.Type;

/** A thread's folder on a host, whose work in progress a stop keeps (`host.stop.prepare`). */
export const HostStopCheckout = Schema.Struct({
  threadId: ThreadId,
  cwd: Schema.String.check(Schema.isMaxLength(4096)),
});
export type HostStopCheckout = typeof HostStopCheckout.Type;

/** What a stop kept of one thread's folder: the hidden ref it wrote, and whether it was pushed. */
export const HostStopKept = Schema.Struct({
  threadId: ThreadId,
  cwd: Schema.String,
  /**
   * The folder's own ref, `refs/gram/wip/<thread>--<folder>`, once the working tree was committed
   * under it; `refs/gram/wip/<thread>` from a host built before each folder had its own.
   */
  ref: Schema.optionalKey(Schema.String),
  commit: Schema.optionalKey(Schema.String),
  /** Whether the remote now has that commit under the ref. */
  pushed: Schema.Boolean,
  /**
   * The branch at the remote is at `commit` and nothing was uncommitted: the remote holds all of
   * it already, so no ref is written for this folder, and one this folder left before was
   * deleted. A ref that holds other work of the thread (another folder's) is left there. Absent
   * from a host built before it was said, which pushes the ref regardless.
   */
  caughtUp: Schema.optionalKey(Schema.Boolean),
  /** The branch the folder was on; absent on a detached HEAD, and from a host that doesn't say. */
  branch: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
  /** Why it wasn't committed or pushed, in the host's words. */
  note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
  /**
   * What the kept commit holds against the branch's base, so it can be shown while the machine is
   * away. Absent from a host built before it, and when it couldn't be read.
   */
  saved: Schema.optionalKey(SavedDiff),
});
export type HostStopKept = typeof HostStopKept.Type;

/**
 * A host's answer to `host.stop.prepare`. `idle` says nothing is running on it and nothing new
 * will start: it can be stopped now, and takes no new work until `host.stop.cancel` or ten minutes
 * pass. Not idle and not forced, nothing was changed and `kept` is empty.
 */
export const HostStopPrepared = Schema.Struct({
  idle: Schema.Boolean,
  busy: HostBusy,
  kept: Schema.Array(HostStopKept),
  /** Why it isn't idle when `busy` doesn't say, such as an update under way. */
  note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
  /** The stop didn't hold (taken back, or its hold ran out): the host takes work again. */
  released: Schema.optionalKey(Schema.Boolean),
});
export type HostStopPrepared = typeof HostStopPrepared.Type;

/**
 * A host's answer to `host.stop.restore`: whether the thread's folder is there again with the work
 * a stop kept of it, and what was put back.
 */
export const HostStopRestored = Schema.Struct({
  restored: Schema.Boolean,
  /** The commit put back: the one the remote kept under the folder's ref, or its branch's tip. */
  commit: Schema.optionalKey(Schema.String),
  /** Whether files that weren't committed were put back with the branch. */
  uncommitted: Schema.optionalKey(Schema.Boolean),
  /**
   * Where the folder came from: the thread's hidden ref, or the branch at the remote for a thread
   * no ref was kept of. Absent from a host that restores only from the ref.
   */
  source: Schema.optionalKey(Schema.Literals(["ref", "branch"])),
  /**
   * Nothing was put back because the folder is there already, made by something else: it is left
   * as it is. Absent from a host built before it, which says so only in `note`.
   */
  there: Schema.optionalKey(Schema.Boolean),
  /** Why nothing was put back, or what to know of what was, in the host's words. */
  note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
  /**
   * Nothing was put back because the work the stop kept (`commit`) is gone from the remote and the
   * branch there doesn't hold it: a person may take the branch without it (`fromBranch`). Absent
   * from a host before `wip-restore-kept`.
   */
  keptGone: Schema.optionalKey(Schema.Literal(true)),
});
export type HostStopRestored = typeof HostStopRestored.Type;
