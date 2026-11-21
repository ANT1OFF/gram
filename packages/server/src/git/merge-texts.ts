// What merge_when_ready tells a thread of its merge: merged, waiting, refused, or not known.
import type { BoundPr, MergeIntent } from "@gram/contracts";

import type { PendingMerge } from "../persistence/merge-fence.ts";
import { prName } from "./check-texts.ts";
import type { LocalCheck } from "./local-checks.ts";

/** What the thread is told once Gram merged its PR. */
export const mergedText = (
  bound: BoundPr,
  intent: MergeIntent,
  head: string,
  localCheck?: LocalCheck,
  gateNotice?: string,
) =>
  `Gram merged ${prName(bound)} (${intent.method}) at ${head.slice(0, 7)}: the workspace merge review policy was satisfied, ${
    localCheck === undefined
      ? "the required checks were green"
      : `Gram's own full check passed on this head merged onto ${localCheck.base.slice(0, 7)} (${localCheck.host}, ${new Date(localCheck.finishedAt ?? 0).toISOString()})`
  } and GitHub allowed the merge.${gateNotice === undefined ? "" : ` Local gate OFF: ${gateNotice}.`}`;

/** What the thread is told of a merge that has been waiting a while; it keeps asking. */
export const waitingText = (bound: Pick<BoundPr, "repo" | "number">, why: string) =>
  `merge_when_ready hasn't merged ${prName(bound)} yet and keeps checking: ${why}.`;

export const uncertaintyText = (pending: PendingMerge) =>
  `merge outcome for ${prName(pending.pr)} at ${pending.head.slice(0, 7)} isn't known; its base is fenced across restarts. Inspect the PR on GitHub. Automatic reconciliation requires that head merged, or a confirmed rejection with it still open. For a terminal PR at another head, the user or owning orchestrator must explicitly call resolve_merge_fence with pr=${prName(pending.pr)}; Gram re-reads GitHub, retires old passes and verifies the base`;

/** What the thread is told when GitHub refused the merge; it is tried again on a new head. */
export const refusedText = (bound: BoundPr, head: string, why: string) =>
  `merge_when_ready couldn't merge ${prName(bound)} at ${head.slice(0, 7)}: ${why.split("\n")[0]!.slice(0, 300)}. It tries again once the head moves; call merge_when_ready again to retry this head.`;
