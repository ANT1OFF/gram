import type { Diff } from "@gram/contracts";
import type { Query } from "@tanstack/react-query";

/** Where the diff's key has the tree's stamp (`diffStamp`), which moves with every edit. */
const STAMP_AT = 4;

/**
 * The diff panel's `placeholderData` for `diffKey` (["git.diff", thread, scope, turn, stamp]): the
 * diff on screen stays until the asked-for one comes. With whitespace switched on or off, so the
 * files opened in it stay open; on a clean tree's fallback to the branch while Branch loads; and
 * at an older stamp while the tree's newest is fetched: dropped, "Loading diff…" showed between
 * the two. Another thread's, scope's or turn's diff never stands in.
 */
export const keptDiff =
  (diffKey: readonly unknown[]) =>
  (
    previous: Diff | undefined,
    previousQuery: Pick<Query<Diff>, "queryKey"> | undefined,
  ): Diff | undefined =>
    diffKey.every(
      (part, at) =>
        at === STAMP_AT ||
        previousQuery?.queryKey[at] === part ||
        (at === 2 &&
          part === "branch" &&
          previousQuery?.queryKey[at] === "uncommitted" &&
          previous?.base !== undefined),
    )
      ? previous
      : undefined;
