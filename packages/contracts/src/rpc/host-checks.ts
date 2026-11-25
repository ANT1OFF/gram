import * as Schema from "effect/Schema";
import { InspectedWorktreeHook } from "../worktree-hooks.ts";

/** Why a check on the host didn't pass, as the control plane records it. */
export const HostCheckFailure = Schema.Struct({
  kind: Schema.Literals(["not-found", "timed-out", "exited", "stopped", "unstartable", "conflict"]),
  command: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.Number),
  tail: Schema.optionalKey(Schema.String),
});

/** How a check on the host ended, and what it checked. */
export const HostCheckResult = Schema.Struct({
  /** The tree of the head merged onto the base; null when they conflict. */
  tree: Schema.NullOr(Schema.String),
  /** The throwaway commit of that tree the check ran on. */
  mergedCommit: Schema.optionalKey(Schema.String),
  setupApproval: Schema.optionalKey(InspectedWorktreeHook),
  setupFingerprint: Schema.optionalKey(Schema.String),
  /** The runner that issued the setup preview or executed the setup. */
  setupRunnerVersion: Schema.optionalKey(Schema.Number),
  ok: Schema.Boolean,
  reason: Schema.optionalKey(Schema.String),
  failure: Schema.optionalKey(HostCheckFailure),
  /** The end of the run's output, bounded. */
  log: Schema.optionalKey(Schema.String),
  /** The host machine's own name. */
  host: Schema.String,
});
export type HostCheckResult = typeof HostCheckResult.Type;

export const HostCheckRepositorySetup = Schema.Struct({
  fingerprint: Schema.optionalKey(Schema.String),
  revision: Schema.optionalKey(Schema.String),
});
