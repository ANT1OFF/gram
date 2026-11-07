import type { ComponentProps } from "react";

import { withHint } from "@/keyboard/use-shortcut-hint";
import { cn } from "@/lib/utils";

import { isErrorPart } from "./needs-you-items";
import { useNeedsYouPill } from "./use-needs-you";

// What needs you has one way in and one wording, an amber dot before it, wherever it shows: its
// kinds, "1 question · 1 error", so a count never stands for more than the cards that show it. It
// sits at the top of the column left of the chat: the open sidebar's pill, the same pill over
// Settings' sections, the compact rail's count; with no column there, the title bar's first chip.
// Quiet's strip draws it at its foot. The rail, with room for a number only, says the words to a
// screen reader and on hover.

/** "1 needs you", "2 need you", or "Nothing needs you". */
export const needsYouWords = (count: number): string =>
  count > 0 ? `${count} ${count === 1 ? "needs" : "need"} you` : "Nothing needs you";

/**
 * How many kinds each form names before it says the count alone, its hover the kinds: the
 * sidebar's row, a column wide, two; a chip in a bar, with the bar's width, three.
 */
const KINDS_SHOWN = { row: 2, chip: 3 } as const;

/**
 * The pill's words: what needs you by kind, "1 question · 1 error", or with more kinds than fit
 * (`max`), "4 need you" (`needsYouWords`), as with nothing at all.
 */
export const needsYouPillWords = (
  count: number,
  kinds: readonly string[],
  max: number = KINDS_SHOWN.row,
): string =>
  count > 0 && kinds.length > 0 && kinds.length <= max ? kinds.join(" · ") : needsYouWords(count);

/** The entry's hover: the count with its scope ("across all workspaces"), then where they are. */
export const needsYouScope = (count: number, where: string): string =>
  count > 0 ? `${needsYouWords(count)} across all workspaces\n${where}` : needsYouWords(count);

/** What a screen reader hears: the count, then its kinds, "2 need you: 1 question, 1 error". */
export const needsYouSpoken = (count: number, kinds: readonly string[]): string =>
  count > 0 && kinds.length > 0
    ? `${needsYouWords(count)}: ${kinds.join(", ")}`
    : needsYouWords(count);

/**
 * The entry: its dot and words, opening the Inbox at the newest ask in view. `row` is the sidebar's
 * full-width pill; `chip` is its inline form, for a bar. With nothing waiting a row stays as quiet
 * grey words, so the column doesn't jump, and a chip draws nothing: in a bar its absence says it.
 */
export function NeedsYouEntry({
  variant,
  className,
  ...rest
}: {
  variant: "row" | "chip";
  className?: string;
} & Omit<ComponentProps<"button">, "children" | "className">) {
  const { count, parts, scope: where, label, hint, openAsks } = useNeedsYouPill();
  if (variant === "chip" && count === 0) return null;
  const words = needsYouPillWords(count, parts, KINDS_SHOWN[variant]);
  // One alarm per failure: an error's is its card and its thread's red dot, so only what asks
  // tints. Errors alone leave the entry neutral; beside an ask, their words stay muted.
  const asks = count > 0 && (parts.length === 0 || parts.some((part) => !isErrorPart(part)));
  const byKind = count > 0 && words === parts.join(" · ") && parts.length > 0;
  return (
    <button
      type="button"
      data-count={count}
      aria-label={withHint(needsYouSpoken(count, parts), hint)}
      title={`${withHint(label, hint)}\n${needsYouScope(count, where)}`}
      onClick={openAsks}
      {...rest}
      className={cn(
        "flex shrink-0 items-center gap-2 border text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
        variant === "row"
          ? "h-8 w-full rounded-(--radius-md) px-1.5"
          : "h-7 rounded-full px-2.5 text-meta",
        // The sidebar's pill outlines in amber while something asks; in a bar the dot and the
        // asks' words are the one amber mark, the pill itself neutral like the bar around it.
        variant === "row" && asks
          ? "border-status-needs-mark/60 font-medium text-status-needs hover:bg-status-needs-mark/10"
          : variant === "chip"
            ? cn(
                "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground aria-pressed:bg-accent",
                asks && "font-medium",
              )
            : "border-transparent text-muted-foreground hover:bg-sidebar-row-hover",
        className,
      )}
    >
      {asks && <span aria-hidden className="size-2 shrink-0 rounded-full bg-status-needs-mark" />}
      <span className="min-w-0 flex-1 truncate">
        {byKind ? (
          parts.map((part, index) => (
            <span key={part}>
              {index > 0 && <span className="text-muted-foreground"> · </span>}
              <span className={isErrorPart(part) ? "text-muted-foreground" : "text-status-needs"}>
                {part}
              </span>
            </span>
          ))
        ) : asks && variant === "chip" ? (
          <span className="text-status-needs">{words}</span>
        ) : (
          words
        )}
      </span>
    </button>
  );
}
