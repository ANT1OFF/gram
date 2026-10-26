import type { GitState, WaitItem } from "@gram/contracts";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * What closing (and possibly deleting) a worktree would put out of sight: uncommitted changes and
 * commits not merged to the base branch, plus whether merging would conflict. `undefined` when there
 * is nothing to warn about or no git state yet.
 */
export function closeWarning(git: GitState | undefined): string | undefined {
  if (!git?.repo) return undefined;
  const parts: string[] = [];
  if (git.changedFiles > 0) parts.push(plural(git.changedFiles, "uncommitted change"));
  // After a squash-merged PR the branch stays "ahead" of base forever; don't nag about it.
  const merged = git.pr?.state === "MERGED" && !git.pr.aheadOfPr;
  if (git.aheadBase > 0 && !merged) {
    const base = git.base ? git.base.replace(/^origin\//, "") : "the base branch";
    parts.push(`${plural(git.aheadBase, "commit")} not merged to ${base}`);
  }
  if (parts.length === 0) return undefined;
  const conflict = git.conflicts ? " Merging it into the base branch would conflict." : "";
  return `This worktree has ${parts.join(" and ")}.${conflict}`;
}

/** How many titles the warning names before it counts the rest. */
const NAMED = 3;

/**
 * What closing a thread leaves undone of its Waiting on you: "2 things still wait on you here: …".
 * `undefined` while nothing does.
 */
export function waitingWarning(
  waits: readonly Pick<WaitItem, "title">[] | undefined,
): string | undefined {
  if (waits === undefined || waits.length === 0) return undefined;
  const titles = waits.slice(0, NAMED).map((item) => `“${item.title}”`);
  const more = waits.length - NAMED;
  const named = more > 0 ? `${titles.join(", ")} and ${more} more` : titles.join(", ");
  return `${waits.length === 1 ? "1 thing still waits" : `${waits.length} things still wait`} on you here: ${named}. Closing leaves ${waits.length === 1 ? "it" : "them"} undone.`;
}
