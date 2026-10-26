import * as Layer from "effect/Layer";
import { CheckpointsLive } from "./checkpoints.ts";
import { GitStateRuntimeLive } from "./git-state-runtime.ts";
import { PrLive } from "./pr.ts";
import { PathProbeLive, ProcLive } from "./proc.ts";
import { ReviewBots } from "./review-bots.ts";
import { ToolsLive } from "./tools.ts";
import { WorktreesLive } from "./worktrees.ts";

export * from "./checkpoints.ts";
export * from "./claude-settings.ts";
export * from "./diff.ts";
export * from "./errors.ts";
export * from "./exec.ts";
export * from "./git-state-runtime.ts";
export * from "./git-state.ts";
export * from "./names.ts";
export * from "./open-prs.ts";
export * from "./paths.ts";
export * from "./pr.ts";
export * from "./pr-actions.ts";
export * from "./pr-cache.ts";
export * from "./pr-checkout.ts";
export * from "./pr-people.ts";
export * from "./proc.ts";
export * from "./pr-create.ts";
export * from "./push.ts";
export * from "./rate-limit.ts";
export * from "./rate-limit-headers.ts";
export * from "./rate-limit-probe.ts";
export * from "./refs.ts";
export * from "./repo-facts.ts";
export * from "./review-actions.ts";
export * from "./review-bots.ts";
export * from "./review-requests.ts";
export * from "./review.ts";
export * from "./tools.ts";
export * from "./upstream-sync.ts";
export * from "./watch.ts";
export * from "./worktree-include.ts";
export * from "./worktrees.ts";

const Base = Layer.mergeAll(ProcLive, PathProbeLive, ReviewBots.layer);
const WithTools = Layer.provideMerge(ToolsLive, Base);
const WithPr = Layer.provideMerge(PrLive, WithTools);

/** Every git service over the real platform: Proc, PathProbe, Tools, Pr, Worktrees, GitStateRuntime, Checkpoints. */
export const GitLive = Layer.mergeAll(GitStateRuntimeLive, WorktreesLive, CheckpointsLive).pipe(
  Layer.provideMerge(WithPr),
);

export * from "./ci-diagnostics.ts";
