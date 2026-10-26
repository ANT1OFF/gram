import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { OVERVIEW_STOP } from "@/shell/focus-regions";
import { overviewSectionFolded, useLayoutStore, type OverviewSection } from "@/stores/layout";

// The overview sidebar's pieces its sections share: a foldable section and the row's grid.

/** A stop for the arrow keys: every row and section title. */
export const STOP = OVERVIEW_STOP;

export const ROW =
  "grid w-full cursor-default grid-cols-[0.625rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-(--radius-sm) px-1.5 py-1 text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring";

/** A section with a title that folds it, its fold kept in the layout store. */
export function Section({
  id,
  title,
  count,
  children,
}: {
  id: OverviewSection;
  title: string;
  count: number;
  children: ReactNode;
}) {
  const folded = useLayoutStore((s) => overviewSectionFolded(s, id));
  const toggle = useLayoutStore((s) => s.toggleOverviewSection);
  const body = `overview-${id}`;
  return (
    <section aria-label={title} data-testid={`overview-section-${id}`} className="flex flex-col">
      <h2>
        <button
          type="button"
          {...{ [STOP]: "" }}
          aria-expanded={!folded}
          aria-controls={body}
          onClick={() => toggle(id)}
          className="flex h-6 w-full items-center gap-1.5 rounded-(--radius-sm) px-1.5 text-left text-[11px] font-medium tracking-wide text-muted-foreground uppercase outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronDown
            aria-hidden
            className={cn(
              "size-3 shrink-0 transition-transform duration-(--dur-fast)",
              folded && "-rotate-90",
            )}
          />
          <span className="flex-1">{title}</span>
          <span className="tracking-normal tabular-nums">{count}</span>
        </button>
      </h2>
      <div id={body} hidden={folded} className="flex flex-col gap-px">
        {children}
      </div>
    </section>
  );
}
