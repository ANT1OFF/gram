import { AppToolError, samePr } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { parsePrRef, prName, type MergeWhenReady } from "../git/merge-when-ready.ts";
import { userMergeApproverIsOrchestrator } from "../git/user-merge-authorization.ts";
import type { ThreadStore } from "../persistence/thread-store.ts";
import { defineAppTool } from "./definition.ts";

/** Only an approval card or the current owning orchestrator can authorize this exact attempt. */
export const resolveMergeFenceTool = (
  store: ThreadStore["Service"],
  gate: MergeWhenReady["Service"] | undefined,
) =>
  defineAppTool({
    descriptor: {
      name: "resolve_merge_fence",
      class: "crossThread",
      description:
        "Explicitly reconcile an uncertain merge shown as fenced in the ledger. Name pr as owner/repo#N. Only the user or the owning orchestrator may resolve it. Gram must read terminal MERGED or CLOSED state from GitHub, at whichever head, and freshly verify the base branch. Older local passes are retired before any later merge; this never lifts merge holds or waives checks. A worker requires a user approval card, including under full autonomy.",
    },
    rejectExcessProperties: true,
    approvalRequiresResolvedTarget: true,
    input: Schema.Struct({ pr: Schema.NonEmptyString }),
    resolve: (_caller, input) =>
      Effect.gen(function* () {
        const pr = parsePrRef(input.pr);
        const record =
          pr === undefined
            ? undefined
            : (yield* store.listMergeFences).find(
                (row) => row.pending !== undefined && samePr(row.pending.pr, pr),
              );
        if (record?.pending === undefined || gate === undefined)
          return yield* new AppToolError({
            tool: "resolve_merge_fence",
            message: "No pending merge fence matches that PR. Inspect its current ledger row.",
          });
        return { pending: record.pending };
      }),
    needsApproval: (caller, _input, { pending }) =>
      Effect.gen(function* () {
        const scope = yield* store
          .getThreadWithAuthority(pending.threadId, caller)
          .pipe(Effect.option);
        return !(
          Option.isSome(scope) &&
          userMergeApproverIsOrchestrator(caller, scope.value.thread, scope.value.context)
        );
      }),
    describe: (_caller, { pending }) =>
      Effect.succeed(
        `Resolve the uncertain merge of ${prName(pending.pr)} at ${pending.head} (attempt ${pending.at}) only after GitHub confirms it merged or closed. Retire older checks and verify its base freshly. Merge holds remain.`,
      ),
    handle: (caller, { pending }, call) =>
      gate === undefined
        ? Effect.fail(
            new AppToolError({
              tool: "resolve_merge_fence",
              message: "Merge reconciliation is unavailable.",
            }),
          )
        : gate.resolveFence(caller, {
            ...pending.pr,
            head: pending.head,
            at: pending.at,
            userApproved: call.carded === true,
          }),
  });
