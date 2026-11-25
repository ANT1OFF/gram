import * as Schema from "effect/Schema";

export const WorktreeHookKind = Schema.Literals(["setup", "resume"]);
export type WorktreeHookKind = typeof WorktreeHookKind.Type;

export const WorktreeHookInspection = Schema.Union([
  Schema.Struct({ status: Schema.Literal("absent") }),
  Schema.Struct({ status: Schema.Literals(["invalid", "skipped"]), reason: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("found"),
    path: Schema.String,
    revision: Schema.String,
    fingerprint: Schema.String,
    script: Schema.String,
  }),
]);
export type WorktreeHookInspection = typeof WorktreeHookInspection.Type;

/** Scope and source an admitted control plane expects the host to serve. */
export const WorktreeHookRequest = Schema.Struct({
  checkout: Schema.String,
  kind: WorktreeHookKind,
  revision: Schema.optionalKey(Schema.String),
});
export type WorktreeHookRequest = typeof WorktreeHookRequest.Type;

export const WorktreeHookRun = Schema.Struct({
  ...WorktreeHookRequest.fields,
  revision: Schema.String,
  fingerprint: Schema.String,
  budgetMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  generation: Schema.optionalKey(Schema.String),
  workspace: Schema.optionalKey(Schema.String),
  repository: Schema.optionalKey(Schema.String),
  environment: Schema.optionalKey(Schema.String),
});
export type WorktreeHookRun = typeof WorktreeHookRun.Type;

export const WorktreeHookOutcome = Schema.Struct({
  status: Schema.Literals(["passed", "reused", "failed", "skipped", "absent"]),
  durationMs: Schema.Number,
  log: Schema.String,
  reason: Schema.optionalKey(Schema.String),
  failure: Schema.optionalKey(
    Schema.Literals([
      "missing-tool",
      "timeout",
      "exited",
      "launch",
      "cleanup",
      "interrupted",
      "unavailable",
    ]),
  ),
  exitCode: Schema.optionalKey(Schema.Number),
  resultId: Schema.optionalKey(Schema.String),
});
export type WorktreeHookOutcome = typeof WorktreeHookOutcome.Type;

export const ThreadWorktreeHook = Schema.Struct({
  checkout: Schema.String,
  kind: WorktreeHookKind,
  generation: Schema.String,
  path: Schema.optionalKey(Schema.String),
  result: Schema.Union([WorktreeHookOutcome, Schema.Struct({ status: Schema.Literal("running") })]),
});
export type ThreadWorktreeHook = typeof ThreadWorktreeHook.Type;
