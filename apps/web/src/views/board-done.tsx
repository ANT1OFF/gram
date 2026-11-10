import type { ThreadId } from "@gram/contracts";
import { CircleCheck, GitMerge, GitPullRequest } from "lucide-react";
import { useState, type MouseEvent } from "react";

import { Button } from "@/components/ui/button";
import { formatDay, formatStamp } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { RailRow } from "@/orchestration/rail-model";
import { useThreadsStore } from "@/stores/threads";

import { GRID_COLUMNS, useLatestReport } from "./board-grid";

// The Board's Done band: under the lines at work, the features whose work is over and that have
// left the Board, as Done lists them in the sidebar. A line each, newest first, on the grid's
// columns: how it ended and when (Stage), what its last report said (Now) and the PR it ended with;
// "Show N more" unfolds the rest in place, and the header's Show finished brings them back among
// the lines.

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
        {shown.map((row) => (
          <DoneRow key={row.feature} row={row} repos={repos} onOpen={onOpen} />
        ))}
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

/** When a Done row ended, in a date column's words: `09:52` today, else its day (`12 Jun`). */
export const doneEnded = (ended: number, now = Date.now()): string => {
  const stamp = formatStamp(ended, now);
  return stamp.includes(" ") ? formatDay(ended, now) : stamp;
};

/**
 * One finished line: its title (a click from its thread), how it ended and when, the first line of
 * its last report with its repos, and its PR under Pull request.
 */
function DoneRow({
  row,
  repos,
  onOpen,
}: {
  row: RailRow;
  repos: boolean;
  onOpen: (threadId: ThreadId, event: MouseEvent) => void;
}) {
  const pr = donePr(row);
  const first = row.card.workers[0];
  const ended = useThreadsStore((s) =>
    first === undefined ? undefined : s.byId[first.threadId]?.thread.completedAt,
  );
  const report = useLatestReport(row.card.workspaceId, first?.threadId ?? ("" as ThreadId));
  const outcome = pr?.state === "merged" ? "Merged" : "Done";
  const where = repos ? row.projects.join(" · ") : undefined;
  return (
    <li
      data-testid="board-done-row"
      data-feature={row.feature}
      className={cn(
        GRID_COLUMNS,
        "items-start border-b border-border/40 py-2 text-meta last:border-b-0",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <CircleCheck aria-hidden className="size-icon-row shrink-0 text-success" />
        {first === undefined ? (
          <span className="min-w-0 truncate text-body text-foreground">{row.title}</span>
        ) : (
          <button
            type="button"
            title={row.title}
            onClick={(event) => onOpen(first.threadId, event)}
            className="min-w-0 truncate rounded-sm text-left text-body text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {row.title}
          </button>
        )}
      </span>
      {/* One line in the Stage column's width: the clock today, the date alone on another day
          (the column has no room for both, and wrapped), with the whole stamp on hover. */}
      <span
        data-testid="board-done-ended"
        title={ended === undefined ? undefined : `${outcome} ${formatStamp(ended)}`}
        className="truncate text-muted-foreground tabular-nums"
      >
        {outcome}
        {ended !== undefined && (
          <time dateTime={new Date(ended).toISOString()}> {doneEnded(ended)}</time>
        )}
      </span>
      <span
        data-testid="board-done-report"
        title={report?.summary}
        className="line-clamp-2 min-w-0 break-words text-muted-foreground"
      >
        {[where, report?.summary].filter((part) => part !== undefined && part !== "").join(" · ")}
      </span>
      <span className="min-w-0">
        {pr !== undefined && (
          <span
            data-testid="board-done-pr"
            className="flex items-center gap-1 text-muted-foreground tabular-nums"
          >
            {pr.state === "merged" ? (
              <GitMerge aria-hidden className="size-icon-row text-merged" />
            ) : (
              <GitPullRequest aria-hidden className="size-icon-row" />
            )}
            #{pr.number}
            {pr.state !== undefined && ` ${pr.state}`}
          </span>
        )}
      </span>
    </li>
  );
}
