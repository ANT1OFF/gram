// `merge_freeze`: a thread holds Gram's merges onto a branch for a while, its workspace's by
// default and every workspace's only on the user's yes.
import {
  AppToolError,
  BranchName,
  MERGE_FREEZE_ALLOW_MAX,
  MERGE_FREEZE_MAX_MINUTES,
  MERGE_FREEZE_REASON_MAX,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { MergeFreezes } from "../git/merge-freezes.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { defineAppTool, failed } from "./definition.ts";

/** The `merge_freeze` tool, over the server's merge freezes. */
export const makeMergeFreezeTool = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const freezes = yield* MergeFreezes;
  return defineAppTool({
    descriptor: {
      name: "merge_freeze",
      class: "self",
      description: `Freeze your workspace's Gram merges (\`acrossWorkspaces: true\`, on the user's yes: every workspace's) onto a branch of a workspace \`repo\` (default: your PR's; \`branch\`: its default) for a \`reason\`, up to ${MERGE_FREEZE_MAX_MINUTES} \`minutes\`; call again to renew, 4 h at most. merge_when_ready waits and set_auto_merge refuses, except PRs in \`allow\`; GitHub auto-merge on Gram's PRs is off meanwhile, then restored on the head it stood on (a PR pushed meanwhile stays off; its thread is told). A person, a merge queue or other PRs' auto-merge can still merge. \`lift: true\` ends it (its thread or orchestrator). Wait with schedule_wake's freezeLifted.`,
    },
    audience: ["orchestrator", "worker"],
    input: Schema.Struct({
      repo: Schema.optionalKey(Schema.String),
      branch: Schema.optionalKey(BranchName),
      reason: Schema.optionalKey(
        Schema.NonEmptyString.check(Schema.isMaxLength(MERGE_FREEZE_REASON_MAX)),
      ),
      minutes: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MERGE_FREEZE_MAX_MINUTES })),
      ),
      allow: Schema.optionalKey(
        Schema.Array(Schema.Int).check(Schema.isMaxLength(MERGE_FREEZE_ALLOW_MAX)),
      ),
      lift: Schema.optionalKey(Schema.Boolean),
      acrossWorkspaces: Schema.optionalKey(Schema.Boolean),
    }),
    // Holding other workspaces' merges is the person's call: always on a card.
    needsApproval: (_caller, input) => Effect.succeed(input.acrossWorkspaces === true),
    handle: (caller, input, { carded }) =>
      Effect.gen(function* () {
        const tool = "merge_freeze";
        if (input.acrossWorkspaces === true && input.lift !== true && carded !== true) {
          return yield* new AppToolError({
            tool,
            message: "Only the user can let a freeze hold every workspace's merges.",
          });
        }
        const thread = yield* store.getThread(caller).pipe(Effect.mapError(failed(tool)));
        const repo = input.repo ?? thread.boundPr?.repo;
        if (repo === undefined || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
          return yield* new AppToolError({ tool, message: "Name the `repo` as owner/repo." });
        }
        if (input.lift === true) {
          const lifted = yield* freezes.lift(thread, { repo, branch: input.branch });
          return { lifted: true, repo: lifted.repo, branch: lifted.branch };
        }
        if (input.reason === undefined) {
          return yield* new AppToolError({ tool, message: "Say why in `reason`." });
        }
        const { freeze: frozen, notDisarmed } = yield* freezes.freeze(thread, {
          repo,
          branch: input.branch,
          reason: input.reason,
          minutes: input.minutes,
          allow: input.allow,
          acrossWorkspaces: input.acrossWorkspaces === true,
        });
        return {
          frozen: true,
          repo: frozen.repo,
          branch: frozen.branch,
          until: new Date(frozen.until).toISOString(),
          ...(frozen.allow === undefined ? {} : { allow: frozen.allow }),
          ...(frozen.disarmed === undefined
            ? {}
            : { autoMergeOff: frozen.disarmed.map((pr) => pr.number) }),
          ...(notDisarmed.length === 0 ? {} : { autoMergeStillArmed: notDisarmed }),
        };
      }),
  });
});
