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

/** The PR badge's babysit label, e.g. "Babysitting · round 2 of 6" or "Babysit stopped: PR closed". */
export function babysitBadgeLabel(babysit: BabysitState): string {
  switch (babysit.phase) {
    case "watching":
      return `Babysitting · round ${babysit.rounds} of ${babysit.budget.rounds}`;
    case "done":
      return "Babysit done · ready to merge";
    case "stopped":
      return babysit.stopReason
        ? `Babysit stopped: ${STOP_REASON_TEXT[babysit.stopReason]}`
        : "Babysit stopped";
  }
}
