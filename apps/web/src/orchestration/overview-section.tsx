import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { seeTerm, type TermId } from "@/lib/first-use";
import { cn } from "@/lib/utils";
import { OVERVIEW_STOP } from "@/shell/focus-regions";
import { overviewSectionFolded, useLayoutStore, type OverviewSection } from "@/stores/layout";

// The overview sidebar's pieces its sections share: a foldable section and the row's grid.

/** A stop for the arrow keys: every row and section title. */
export const STOP = OVERVIEW_STOP;

/**
 * Every row's shape, whatever it lists: a 10 px mark column, then its title (`ROW_TITLE`), and under
 * it one compact status line (`ROW_STATUS`) with what trails it (a time, its badges) at the right
 * edge. The title is one line, cut at its end with an ellipsis, and its hover says the whole of it,
 * so every row keeps the same height and a list of them reads as even rows.
 */
export const ROW =
  "grid w-full cursor-default grid-cols-[0.625rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-(--radius-sm) px-1.5 py-1 text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring";

/** A row's title: the row's full width, one line, cut at its end with an ellipsis. */
export const ROW_TITLE = "col-span-2 min-w-0 truncate";

/** A row's status line, under its title: muted words, and its time or badges at the right edge. */
export const ROW_STATUS =
  "col-span-2 col-start-2 flex h-lh min-w-0 items-center gap-x-1.5 text-meta text-muted-foreground";

/** A row's mark (its dot or glyph), centred on its title's line. */
export const ROW_MARK = "flex h-lh items-center justify-center self-start";

/**
 * The thread open in the chat, as a row under its workspace: the chosen fill and edge, stronger than
 * its workspace's `bg-sidebar-row-active`, so the place you are reads at its deepest level.
 */
export const CURRENT_ROW = "aria-current:choice-selected";

/** A settled row: grey and a step back, until hovered, focused or open. */
export const SETTLED =
  "opacity-75 grayscale transition-[opacity,filter] duration-(--dur-fast) hover:opacity-100 hover:grayscale-0 focus-visible:opacity-100 focus-visible:grayscale-0 aria-current:opacity-100 aria-current:grayscale-0";

/**
 * A section with a title that folds it, its fold kept in the layout store. Only folded does it say
 * its count; open, its rows do, and the title's name and hover keep the number. `action`, a control
 * of the section's own, sits at the title's end while it is open; `folded`, while it is folded,
 * puts its own words in the title's place ("8 done"). The whole line is the fold's button, and
 * every section's title has the one look: a Gram word's explanation (`term`) is on its hover, never
 * marked on the title itself.
 */
export function Section({
  id,
  title,
  count,
  action,
  folded: foldedLine,
  hint,
  term,
  children,
}: {
  id: OverviewSection;
  title: string;
  count: number;
  action?: ReactNode;
  /** Folded, the title's words in place of its name and count. */
  folded?: string | undefined;
  /** What the section's name means, on its hover and to a screen reader. */
  hint?: string;
  /** The Gram word the name is: its `hint`'s hover counts as the word's first use. */
  term?: TermId;
  children: ReactNode;
}) {
  const folded = useLayoutStore((s) => overviewSectionFolded(s, id));
  const toggle = useLayoutStore((s) => s.toggleOverviewSection);
  const body = `overview-${id}`;
  return (
    <section aria-label={title} data-testid={`overview-section-${id}`} className="flex flex-col">
      <div className="flex items-center gap-1">
        <h2 className="min-w-0 flex-1">
          <button
            type="button"
            {...{ [STOP]: "" }}
            aria-expanded={!folded}
            aria-controls={body}
            aria-label={`${title}, ${count}`}
            aria-description={hint}
            title={hint === undefined ? `${title}, ${count}` : `${title}, ${count}\n${hint}`}
            // The hover that shows `hint` is its first use; a native title has no open event.
            onPointerEnter={term === undefined ? undefined : () => seeTerm(term)}
            onFocus={term === undefined ? undefined : () => seeTerm(term)}
            onClick={() => toggle(id)}
            // Its chevron centred on the rows' marks, its name where their titles start.
            className="flex h-6 w-full items-center gap-1.5 rounded-(--radius-sm) pr-1.5 pl-1 text-left text-meta font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDown
              aria-hidden
              className={cn(
                "size-icon-chip shrink-0 transition-transform duration-(--dur-fast)",
                folded && "-rotate-90",
              )}
            />
            {folded && foldedLine !== undefined ? (
              <span data-testid={`overview-section-${id}-folded`} className="flex-1 tabular-nums">
                {foldedLine}
              </span>
            ) : (
              <span className="flex-1">{title}</span>
            )}
            {folded && foldedLine === undefined && count > 0 && (
              <span className="tracking-normal tabular-nums">{count}</span>
            )}
          </button>
        </h2>
        {!folded && action}
      </div>
      <div id={body} hidden={folded} className="flex flex-col gap-px">
        {children}
      </div>
    </section>
  );
}

/**
 * A thread's row with its context menu: a right-click anywhere on it, its PR chips included. The
 * chips, buttons of their own, sit over the row's status line at its right edge.
 */
export function RowMenu({ menu, children }: { menu: ReactNode; children: ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger className="relative flex flex-col">{children}</ContextMenuTrigger>
      <ContextMenuContent>{menu}</ContextMenuContent>
    </ContextMenu>
  );
}
