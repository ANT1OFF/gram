import { reconcileOpenPrs, type OpenPrRow, type OwnPr, type ThreadSummary } from "@gram/contracts";

export type { OpenPrRow };

/**
 * The Open PRs list for the threads as they are now: `reconcileOpenPrs`, which `list_open_prs`
 * reads through too, so an agent is told of the list on screen.
 */
export const openPrRows = (
  listed: readonly OwnPr[],
  byId: Readonly<Record<string, ThreadSummary>>,
): OpenPrRow[] => reconcileOpenPrs(listed, Object.values(byId));

/**
 * What keeps a draft from merging, in words, for the card, which spells out its merge marks
 * (`mergeMarksOf`) and has none for a draft; `undefined` where the marks say it all.
 */
export function openPrMergeNote(pr: OwnPr): string | undefined {
  return pr.isDraft ? "A draft, so it can't merge yet" : undefined;
}
