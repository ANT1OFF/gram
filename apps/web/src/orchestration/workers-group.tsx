import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

// What the Workers tab's sections share, the worker groups and the Docs under them: one grid, one
// heading and one quiet line, so every section of the tab reads the same way.

/**
 * The rows' grid, which a section's heading and its "N more" share: a 10 px mark column, then the
 * title, then its age, so marks centre on one column and words start on one edge.
 */
export const ROW_GRID = "grid w-full grid-cols-[0.625rem_minmax(0,1fr)_auto] gap-x-2 px-1.5";

/** A quiet line under a section's rows that acts: "12 more", "2 need you elsewhere · Open Inbox". */
export const ROW_NOTE = cn(
  ROW_GRID,
  "rounded-xs py-1 text-left text-meta text-muted-foreground outline-none hover:text-foreground focus-visible:focus-ring",
);

/**
 * A section's heading: the chevron that folds it, centred on the rows' marks, then its name where
 * their titles start and its count, quiet beside it.
 */
export function GroupHeading({
  label,
  count,
  folded,
  controls,
  onToggle,
}: {
  label: string;
  count: number;
  folded: boolean;
  /** The id of the rows it folds. */
  controls: string;
  onToggle: () => void;
}) {
  return (
    <h3>
      <button
        type="button"
        aria-expanded={!folded}
        aria-controls={controls}
        aria-label={`${label}, ${count}`}
        onClick={onToggle}
        className={cn(
          ROW_GRID,
          "h-7 items-center rounded-xs text-left text-body text-muted-foreground outline-none hover:text-foreground focus-visible:focus-ring",
        )}
      >
        <span className="flex justify-center">
          <ChevronDown
            aria-hidden
            className={cn(
              "size-icon-chip shrink-0 transition-transform duration-(--dur-fast)",
              folded && "-rotate-90",
            )}
          />
        </span>
        <span className="flex min-w-0 items-baseline gap-inset">
          <span className="truncate font-medium text-foreground">{label}</span>
          <span data-testid="workers-group-count" className="text-meta tabular-nums">
            {count}
          </span>
        </span>
      </button>
    </h3>
  );
}
