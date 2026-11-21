import type { ComponentProps } from "react";

import { withHint } from "@/keyboard/use-shortcut-hint";
import { cn } from "@/lib/utils";

import { asksAmong, isErrorPart } from "./needs-you-items";
import { useNeedsYouPill } from "./use-needs-you";
import { useHostAttention } from "@/embed/attention";

/** "1 needs you", "2 need you", or "Nothing needs you". */
export const needsYouWords = (count: number): string =>
  count > 0 ? `${count} ${count === 1 ? "needs" : "need"} you` : "Nothing needs you";

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
 * full-width pill; `chip` is its inline form, for Quiet's strip. With nothing waiting a row stays as quiet
 * grey words, so the column doesn't jump, and a chip draws nothing: in a strip its absence says it.
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
  const host = useHostAttention();
  if (host !== undefined) {
    if (host.count === 0) return null;
    return (
      <button
        type="button"
        data-count={host.count}
        data-host=""
        aria-label={host.words}
        title={host.words}
        onClick={host.open}
        {...rest}
        className={cn(
          "flex shrink-0 items-center gap-2 border text-left font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
          variant === "row"
            ? "h-8 w-full rounded-(--radius-md) border-sidebar-block-border px-1.5 text-foreground hover:bg-sidebar-row-hover"
            : "h-7 rounded-full border-transparent px-2.5 text-meta text-status-needs hover:bg-accent",
          className,
        )}
      >
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-status-needs-mark" />
        <span className="min-w-0 flex-1 truncate">{host.words}</span>
      </button>
    );
  }
  if (variant === "chip" && count === 0) return null;
  const words = needsYouPillWords(count, parts, KINDS_SHOWN[variant]);
  const asks = asksAmong(count, parts);
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
        variant === "row" && asks
          ? "border-sidebar-block-border font-medium text-foreground hover:bg-sidebar-row-hover"
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
