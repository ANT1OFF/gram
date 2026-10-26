import { losesNothing, type StorageGroup, type StorageWorktree } from "@gram/contracts";

import { prStateMarkOf } from "@/components/pr-marks-model";
import { formatBytes } from "@/thread/orchestration-model";

/** The groups in the order the page lists them, each with its caption. */
export const STORAGE_GROUPS: readonly { readonly group: StorageGroup; readonly label: string }[] = [
  { group: "inUse", label: "In use" },
  { group: "idle", label: "Idle" },
  { group: "removable", label: "Removable" },
  { group: "kept", label: "Kept" },
  { group: "foreign", label: "Not made by Gram" },
];

/** One line under each group's caption. */
export const GROUP_HINTS: Readonly<Record<StorageGroup, string>> = {
  inUse: "An open thread works here.",
  idle: "Clean and pushed, PR still open or none.",
  removable: "PR merged or closed, clean and pushed.",
  kept: "Uncommitted or unpushed work.",
  foreign: "Made by agent shells or other tools. Each removal asks first.",
};

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** "3 worktrees", for counts in buttons and confirmations. */
export const worktreeCount = (count: number) => plural(count, "worktree");

/** What a row is called: its branch, else its folder. */
export const worktreeName = (entry: Pick<StorageWorktree, "branch" | "path">): string =>
  entry.branch ?? entry.path.split(/[\\/]/).filter(Boolean).at(-1) ?? entry.path;

/** The work a removal would lose, in words, or `undefined` when it would lose nothing. */
export const workAtRisk = (entry: StorageWorktree): string | undefined => {
  if (losesNothing(entry)) return undefined;
  if (entry.unreadable === true) return "git couldn't read it";
  if (entry.locked === true) return "locked";
  const parts: string[] = [];
  if (entry.changedFiles > 0) parts.push(plural(entry.changedFiles, "uncommitted change"));
  if (entry.unpushed > 0) parts.push(plural(entry.unpushed, "unpushed commit"));
  return parts.join(", ");
};

/** The short state shown on a row. */
export const rowState = (entry: StorageWorktree): string | undefined => {
  if (entry.missing) return "Folder gone";
  const risk = workAtRisk(entry);
  if (risk !== undefined) return risk;
  if (entry.pr !== undefined) {
    // The server sends no draft flag for a worktree's PR, so a draft reads as open here.
    return `#${entry.pr.number} ${prStateMarkOf(entry.pr).word.toLowerCase()}`;
  }
  return entry.settled ? "In base branch" : undefined;
};

/** Sizes counted so far: `pending` while any count is still running. */
export interface SizeTotal {
  readonly bytes: number;
  readonly lowerBound: boolean;
  readonly pending: boolean;
}

/** The summed size of `entries` from the counts that have landed. */
export const sumSizes = (
  entries: readonly StorageWorktree[],
  sizes: ReadonlyMap<string, { readonly bytes: number; readonly partial: boolean } | "error">,
): SizeTotal => {
  let bytes = 0;
  let lowerBound = false;
  let pending = false;
  for (const entry of entries) {
    if (entry.missing) continue;
    const size = sizes.get(entry.path);
    if (size === undefined) pending = true;
    else if (size === "error") lowerBound = true;
    else {
      bytes += size.bytes;
      if (size.partial) lowerBound = true;
    }
  }
  return { bytes, lowerBound, pending };
};

/** A size total in words: "4.2 GB", "at least 4.2 GB". */
export const sizeLabel = (total: SizeTotal): string =>
  `${total.lowerBound || total.pending ? "at least " : ""}${formatBytes(total.bytes)}`;

/**
 * Which rows a group's bulk action takes. Removable: Gram's own that lose nothing. Not made by
 * Gram: only registrations whose folder is gone, since another tool's folder is never bulk-deleted.
 */
export const bulkTargets = (
  group: StorageGroup,
  entries: readonly StorageWorktree[],
): readonly StorageWorktree[] => {
  if (group === "removable") {
    return entries.filter(
      (entry) => entry.group !== "inUse" && entry.madeByGram && losesNothing(entry),
    );
  }
  return group === "foreign" ? entries.filter((entry) => entry.missing) : [];
};
