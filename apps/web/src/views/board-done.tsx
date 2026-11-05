import type { ThreadId } from "@gram/contracts";
import { CircleCheck, GitMerge, GitPullRequest } from "lucide-react";
import type { MouseEvent } from "react";

import { Button } from "@/components/ui/button";
import type { RailRow } from "@/orchestration/rail-model";
import { useLayoutStore } from "@/stores/layout";

// The Board's Done band: under the lines at work, the features whose work is over and that have
// left the Board, as Done lists them in the sidebar. A line each, newest card last as the cards
// order them, with the PR it ended with; Show on the Board brings them back as lines.

/** The most finished features the band lists before it says how many more there are. */
export const DONE_BAND_MAX = 5;

/** The lines that have left the Board for Done, by the sidebar's rule (`RailRow.settled`). */
export const doneRows = (rows: readonly RailRow[]): readonly RailRow[] =>
  rows.filter((row) => row.settled);

/** What a finished line ended with: its first merged PR, else its first PR, by number and state. */
export const donePr = (
  row: RailRow,
): { number: number; state: "open" | "merged" | "closed" | undefined } | undefined => {
  const prs = row.card.workers.flatMap((worker) => worker.prs);
  const pr = prs.find((each) => each.state === "merged") ?? prs[0];
  return pr === undefined ? undefined : { number: pr.number, state: pr.state };
};

export function DoneBand({
  workspaceId,
  rows,
  repos,
  onOpen,
}: {
  workspaceId: string;
  /** The finished lines (`doneRows`), in the cards' order. */
  rows: readonly RailRow[];
  /** Whether the Board's lines name their repos, so these do too. */
  repos: boolean;
  onOpen: (threadId: ThreadId, event: MouseEvent) => void;
}) {
  if (rows.length === 0) return null;
  const shown = rows.slice(-DONE_BAND_MAX).toReversed();
  const more = rows.length - shown.length;
  return (
    <section
      aria-labelledby={`done-band-${workspaceId}`}
      data-testid="board-done"
      className="mt-4 px-4"
    >
      <div className="flex max-w-[66.5rem] items-center gap-2 border-b border-border/60 pb-1.5">
        <h3 id={`done-band-${workspaceId}`} className="text-meta font-medium text-muted-foreground">
          Done
        </h3>
        <span className="text-meta text-muted-foreground tabular-nums">{rows.length}</span>
        <Button
          size="xs"
          variant="ghost"
          data-testid="board-done-show"
          className="ml-auto text-muted-foreground"
          onClick={() => useLayoutStore.getState().toggleBoardArchived(workspaceId)}
        >
          {more > 0 ? `Show all ${rows.length} on the Board` : "Show on the Board"}
        </Button>
      </div>
      <ul aria-label="Done" className="max-w-[66.5rem]">
        {shown.map((row) => {
          const pr = donePr(row);
          const first = row.card.workers[0];
          return (
            <li
              key={row.feature}
              data-testid="board-done-row"
              data-feature={row.feature}
              className="flex min-w-0 items-center gap-2 border-b border-border/40 py-1.5 text-meta last:border-b-0"
            >
              <CircleCheck aria-hidden className="size-3.5 shrink-0 text-success" />
              {first === undefined ? (
                <span className="min-w-0 truncate text-foreground">{row.title}</span>
              ) : (
                <button
                  type="button"
                  onClick={(event) => onOpen(first.threadId, event)}
                  className="min-w-0 truncate rounded-sm text-left text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {row.title}
                </button>
              )}
              {repos && (
                <span className="truncate text-muted-foreground">{row.projects.join(" · ")}</span>
              )}
              {pr !== undefined && (
                <span
                  data-testid="board-done-pr"
                  className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground tabular-nums"
                >
                  {pr.state === "merged" ? (
                    <GitMerge aria-hidden className="size-3.5 text-merged" />
                  ) : (
                    <GitPullRequest aria-hidden className="size-3.5" />
                  )}
                  #{pr.number}
                  {pr.state !== undefined && ` ${pr.state}`}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {more > 0 && (
        <p className="pt-1 text-meta text-muted-foreground">
          {more} more {more === 1 ? "feature" : "features"} done earlier.
        </p>
      )}
    </section>
  );
}
