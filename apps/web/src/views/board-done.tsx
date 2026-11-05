import type { ThreadId } from "@gram/contracts";
import { CircleCheck, GitMerge, GitPullRequest } from "lucide-react";
import { useState, type MouseEvent } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { RailRow } from "@/orchestration/rail-model";

import { GRID_COLUMNS } from "./board-grid";

// The Board's Done band: under the lines at work, the features whose work is over and that have
// left the Board, as Done lists them in the sidebar. A line each, newest first, on the grid's
// columns with the PR it ended with; "Show N more" unfolds the rest in place, and the header's
// Show finished brings them back among the lines.

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
  // "Show N more" unfolds the rest here; the header's Show finished puts them back among the lines.
  const [all, setAll] = useState(false);
  if (rows.length === 0) return null;
  const newest = rows.toReversed();
  const shown = all ? newest : newest.slice(0, DONE_BAND_MAX);
  const more = rows.length - shown.length;
  return (
    <section
      aria-labelledby={`done-band-${workspaceId}`}
      data-testid="board-done"
      className="mt-4 px-4"
    >
      {/* On the grid's columns, as wide as its lines: a finished task's PR sits under Pull request. */}
      <div className={cn(GRID_COLUMNS, "items-baseline border-b border-border/60 pb-1.5")}>
        <h3
          id={`done-band-${workspaceId}`}
          className="flex items-baseline gap-2 text-meta font-medium text-muted-foreground"
        >
          Done
          <span className="tabular-nums">{rows.length}</span>
        </h3>
      </div>
      <ul aria-label="Done">
        {shown.map((row) => {
          const pr = donePr(row);
          const first = row.card.workers[0];
          return (
            <li
              key={row.feature}
              data-testid="board-done-row"
              data-feature={row.feature}
              className={cn(
                GRID_COLUMNS,
                "items-center border-b border-border/40 py-1.5 text-meta last:border-b-0",
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                <CircleCheck aria-hidden className="size-3.5 shrink-0 text-success" />
                {first === undefined ? (
                  <span className="min-w-0 truncate text-foreground">{row.title}</span>
                ) : (
                  <button
                    type="button"
                    title={row.title}
                    onClick={(event) => onOpen(first.threadId, event)}
                    className="min-w-0 truncate rounded-sm text-left text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {row.title}
                  </button>
                )}
              </span>
              <span className="text-muted-foreground">Done</span>
              <span className="min-w-0 truncate text-muted-foreground">
                {repos ? row.projects.join(" · ") : null}
              </span>
              <span className="min-w-0">
                {pr !== undefined && (
                  <span
                    data-testid="board-done-pr"
                    className="flex items-center gap-1 text-muted-foreground tabular-nums"
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
              </span>
            </li>
          );
        })}
      </ul>
      {more > 0 && (
        <Button
          size="xs"
          variant="ghost"
          data-testid="board-done-more"
          className="mt-1 -ml-2 text-muted-foreground"
          onClick={() => setAll(true)}
        >
          Show {more} more
        </Button>
      )}
    </section>
  );
}
