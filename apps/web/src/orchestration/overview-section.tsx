import { ChevronDown } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";

import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { seeTerm, type TermId } from "@/lib/first-use";
import { cn } from "@/lib/utils";
import { OVERVIEW_STOP } from "@/shell/focus-regions";
import { overviewSectionFolded, useLayoutStore, type OverviewSection } from "@/stores/layout";

import { foldByKey } from "./overview-model";

// The overview sidebar's pieces its sections share: a foldable section and the row's grid.

/** A stop for the arrow keys: every row and section title. */
export const STOP = OVERVIEW_STOP;

/**
 * Every row's shape, whatever it lists: a 10 px mark column, its title (`ROW_TITLE`), and at the
 * line's right edge what trails it (`ROW_TRAIL`): a short state ("asks you", "checks"), a time or
 * its badges. One line, one height (`--space-row`): the title is cut at its end with an ellipsis,
 * and its hover says the whole of it and the rest of its state, so a list of rows reads as even
 * rows in every section. The title keeps at least 2.5 rem: short of room, the edge gives way first.
 */
export const ROW =
  "grid min-h-(--space-row) w-full cursor-default grid-cols-[0.625rem_minmax(2.5rem,1fr)_auto] items-center gap-x-2 rounded-(--radius-sm) px-1.5 text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring";

/** A row's title: one line, cut at its end with an ellipsis. */
export const ROW_TITLE = "min-w-0 truncate";

/**
 * What trails a row's title at its right edge, in the row's one line: muted meta words, never more
 * than 7 rem, so the title keeps most of the row.
 */
export const ROW_TRAIL =
  "flex h-lh max-w-28 min-w-0 items-center justify-end gap-x-1.5 text-meta text-muted-foreground";

/**
 * A two-line row's status line, under its title (the Workers tab's rows): muted words, and its time
 * or badges at the right edge.
 */
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
 * A section with a title that folds it, its fold kept in the layout store. Every section's title
 * has the one look, folded or open (`SECTION_TITLE`): its chevron on the rows' mark column, its name
 * in muted 13 px words where the rows' titles start, and its count in the column at the right edge,
 * where the rows' trailing words end. The whole line is the fold's button. `action`, a control of
 * the section's own, sits at the title's end while it is open. A Gram word's explanation (`term`)
 * is on its hover, never marked on the title itself.
 */
export function Section({
  id,
  title,
  count,
  action,
  hint,
  term,
  children,
}: {
  id: OverviewSection;
  title: string;
  count: number;
  action?: ReactNode;
  /** What the section's name means, on its hover and to a screen reader. */
  hint?: string;
  /** The Gram word the name is: its `hint`'s hover counts as the word's first use. */
  term?: TermId;
  children: ReactNode;
}) {
  const folded = useLayoutStore((s) => overviewSectionFolded(s, id));
  const toggle = useLayoutStore((s) => s.toggleOverviewSection);
  const body = `overview-${id}`;
  // ← folds and → unfolds, as a tree row's do; anything else is the overview's.
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const to = foldByKey(event, folded);
    if (to === undefined) return;
    event.preventDefault();
    toggle(id);
  };
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
            onKeyDown={onKeyDown}
            className={SECTION_TITLE}
          >
            <ChevronDown aria-hidden className={cn(SECTION_CHEVRON, folded && "-rotate-90")} />
            <span className="min-w-0 truncate">{title}</span>
            <span data-testid={`overview-section-${id}-count`} className="tabular-nums">
              {count > 0 ? count : ""}
            </span>
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
 * A section's title line, and a fold inside a section that heads rows of its own: the rows' grid
 * (mark, words, count), 24 px tall, muted 13 px words that brighten on hover.
 */
export const SECTION_TITLE =
  "grid h-6 w-full grid-cols-[0.625rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-(--radius-sm) px-1.5 text-left text-meta text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

/** A title's chevron, centred on the rows' mark column; it points right while folded. */
export const SECTION_CHEVRON =
  "size-icon-chip justify-self-center transition-transform duration-(--dur-fast)";

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
