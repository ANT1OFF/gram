import { savedFileCount, type SavedWork, type ThreadError } from "@gram/contracts";

import { formatStamp } from "@/lib/time";

// The words for a worker's last save (`Thread.savedWork`) and a machine lost under it, shared by
// the machine-lost card, the task's card and the worker's row, so each says it alike.

/** "6 files" or "1 file". */
export const filesWord = (count: number): string => (count === 1 ? "1 file" : `${count} files`);

/** "+25 −21". */
export const linesWord = (saved: Pick<SavedWork, "additions" | "deletions">): string =>
  `+${saved.additions} −${saved.deletions}`;

/** What the save holds, after its time: "6 files changed, not committed", or that nothing had. */
export const savedWhat = (saved: SavedWork): string => {
  const count = savedFileCount(saved);
  if (count === 0) return "no files changed yet";
  return `${filesWord(count)} changed${saved.uncommitted ? ", not committed" : ""}`;
};

/** The last save before `error`, when there is one: what a lost machine gives back. */
export const savedBefore = (
  saved: SavedWork | undefined,
  error: Pick<ThreadError, "at">,
): SavedWork | undefined => (saved !== undefined && saved.at <= error.at ? saved : undefined);

/**
 * A worker's now line once its machine was lost: "machine lost 08:14 · 6 files saved", or "· nothing
 * to save" when the save held no change. Without a save it names the loss alone.
 */
export const machineLostLine = (
  error: Pick<ThreadError, "at">,
  saved: SavedWork | undefined,
  now?: number,
): string => {
  const head = `machine lost ${formatStamp(error.at, now)}`;
  const before = savedBefore(saved, error);
  if (before === undefined) return head;
  const count = savedFileCount(before);
  return count === 0 ? `${head} · nothing to save` : `${head} · ${filesWord(count)} saved`;
};

/** What a lost machine is listed as among the failures. */
export const MACHINE_LOST_TAG = "Machine lost";

/** A lost machine's line among the failures: what of the work comes back with it. */
export const machineLostDetail = (
  error: Pick<ThreadError, "at">,
  saved: SavedWork | undefined,
): string => {
  const before = savedBefore(saved, error);
  if (before === undefined) return "Its folder comes back as last saved when it resumes.";
  const count = savedFileCount(before);
  if (count === 0) return "Nothing had changed yet; it resumes from its branch.";
  return `${filesWord(count)} saved at ${formatStamp(before.at)} come back when it resumes; anything after is lost.`;
};
