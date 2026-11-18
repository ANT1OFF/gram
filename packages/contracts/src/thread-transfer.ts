// Moving one thread to another Gram, with its conversation and its work in progress, and back
// (docs/design/move-a-thread.md). Behind the hosted features setting (`embeddingOn`), as the
// workspace move is.
//
// What goes is what lets it carry on: the conversation and its turns, scrubbed; its repository's
// shareable remote and its branch; and where its edits are, a hidden ref the machine it ran on
// pushed (`refs/gram/wip/…`), never the branch. No agent's own session file goes: the other side
// opens a fresh session that reads the recent turns. Sign-ins, keys, ignored files, this machine's
// hooks and MCP servers, terminals and approvals in flight never go.

import * as Schema from "effect/Schema";
import { PlanItem, Thread } from "./domain.ts";
import { ThreadId } from "./ids.ts";
import { ThreadPlan } from "./thread-plan.ts";
import { BUNDLE_MESSAGES_MAX, BundleMessage, BundleTurn } from "./workspace-transfer.ts";

/** The bundle's shape. A server reads only the format it writes. */
export const THREAD_BUNDLE_FORMAT = 1;

const Line = Schema.String.check(Schema.isMaxLength(2_000));
const Oid = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/));
/** A hidden ref a host keeps a thread's work under: `refs/gram/wip/<thread>`, or under a name. */
const WipRefName = Schema.String.check(
  Schema.isPattern(
    /^refs\/gram\/wip\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\/)?[A-Za-z0-9_-]{1,128}$/,
  ),
);

/** Where the thread's edits are: the hidden ref at the repository's remote, and its commit. */
export const BundleWip = Schema.Struct({
  ref: WipRefName,
  commit: Oid,
  /** Whether it holds files the branch's tip doesn't: uncommitted ones. */
  uncommitted: Schema.Boolean,
});
export type BundleWip = typeof BundleWip.Type;

/** One thread as one Gram exports it for another to take in. */
export const ThreadBundle = Schema.Struct({
  format: Schema.Literal(THREAD_BUNDLE_FORMAT),
  /** The Gram that wrote it: its version, and how many schema migrations its database had run. */
  app: Schema.Struct({ version: Schema.String, schema: Schema.Int }),
  /** Epoch ms. */
  exportedAt: Schema.Number,
  /** As it was stored, without its machine's facts: no session, no folder grant, no wait. */
  thread: Thread,
  messages: Schema.Array(BundleMessage).check(Schema.isMaxLength(BUNDLE_MESSAGES_MAX)),
  turns: Schema.Array(BundleTurn).check(Schema.isMaxLength(BUNDLE_MESSAGES_MAX)),
  plan: Schema.optionalKey(ThreadPlan),
  turnPlan: Schema.optionalKey(Schema.Array(PlanItem)),
  /** Its repository: a name, and its `origin` without credentials, for the other side to clone. */
  repository: Schema.Struct({ name: Line, remote: Line }),
  /** The branch it worked on, pushed there; absent on a detached HEAD. */
  branch: Schema.optionalKey(Line),
  /** The branch it started from, when Gram knew it. */
  base: Schema.optionalKey(Line),
  /** Absent when nothing was kept: no change beyond the branch, pushed. */
  wip: Schema.optionalKey(BundleWip),
  /** What the export left behind or could not read, for whoever moves it to see. */
  notes: Schema.Array(Line).check(Schema.isMaxLength(50)),
});
export type ThreadBundle = typeof ThreadBundle.Type;

/** `POST /threads/export`: the thread to export. It must be at rest. */
export const ExportThreadInput = Schema.Struct({ threadId: ThreadId });
export type ExportThreadInput = typeof ExportThreadInput.Type;

/**
 * `POST /threads/import`: a bundle, the main checkout of its repository here, and the name the
 * person knows the other Gram by. The thread is made in a worktree of that checkout, its edits put
 * back from the bundle's ref.
 */
export const ImportThreadInput = Schema.Struct({
  bundle: ThreadBundle,
  root: Schema.NonEmptyString,
  from: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});
export type ImportThreadInput = typeof ImportThreadInput.Type;

export const ImportThreadResult = Schema.Struct({
  thread: Thread,
  notes: Schema.Array(Schema.String),
});
export type ImportThreadResult = typeof ImportThreadResult.Type;

/**
 * `POST /threads/settle`: the other Gram has the thread, so the record here becomes a read-only
 * copy, archived, saying where it went. Only once the import there answered.
 */
export const SettleThreadInput = Schema.Struct({
  threadId: ThreadId,
  to: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  url: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_000))),
});
export type SettleThreadInput = typeof SettleThreadInput.Type;
