import type { BabysitState, BabysitStopReason } from "@gram/contracts";

export const STOP_REASON_TEXT: Record<BabysitStopReason, string> = {
  rounds: "round budget used",
  disagreement: "the bot and agent disagree on one thread twice",
  prClosed: "PR closed",
  prMerged: "PR merged",
  checkFailedTwice: "the same check failed twice",
  forcePush: "force-push detected",
};

/** The phase in words: "Watching · round 2 of 6", "Done · ready to merge", "Stopped: PR closed". */
export function babysitStatusText(babysit: BabysitState): string {
  switch (babysit.phase) {
    case "watching":
      return `Watching · round ${babysit.rounds} of ${babysit.budget.rounds}`;
    case "done":
      return "Done · ready to merge";
    case "stopped":
      return babysit.stopReason ? `Stopped: ${STOP_REASON_TEXT[babysit.stopReason]}` : "Stopped";
  }
}

/**
 * The PR badge's label for babysit mode, which the UI calls Watch PR: e.g. "Watching PR · round 2 of
 * 6" or "Watch PR stopped: PR closed".
 */
export function babysitBadgeLabel(babysit: BabysitState): string {
  switch (babysit.phase) {
    case "watching":
      return `Watching PR · round ${babysit.rounds} of ${babysit.budget.rounds}`;
    case "done":
      return "Watch PR done · ready to merge";
    case "stopped":
      return babysit.stopReason
        ? `Watch PR stopped: ${STOP_REASON_TEXT[babysit.stopReason]}`
        : "Watch PR stopped";
  }
}
