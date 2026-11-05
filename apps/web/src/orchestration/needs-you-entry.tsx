import type { ComponentProps } from "react";

import { withHint } from "@/keyboard/use-shortcut-hint";
import { cn } from "@/lib/utils";

import { useNeedsYouPill } from "./use-needs-you";

// What needs you has one way in and one wording: "2 need you", an amber dot before it, wherever it
// shows. The open sidebar draws it as its pill; the title bar draws it while no pill is on screen,
// and Quiet's strip draws it at its foot. The compact rail, with room for a number only, shows the
// count and says these words to a screen reader and on hover.

/** "1 needs you", "2 need you", or "Nothing needs you". */
export const needsYouWords = (count: number): string =>
  count > 0 ? `${count} ${count === 1 ? "needs" : "need"} you` : "Nothing needs you";

/** The entry's hover: the words with their scope ("across all workspaces"), then where they are. */
export const needsYouScope = (count: number, where: string): string =>
  count > 0 ? `${needsYouWords(count)} across all workspaces\n${where}` : needsYouWords(count);

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
  const { count, scope: where, label, hint, openAsks } = useNeedsYouPill();
  if (variant === "chip" && count === 0) return null;
  const words = needsYouWords(count);
  return (
    <button
      type="button"
      data-count={count}
      aria-label={withHint(words, hint)}
      title={`${withHint(label, hint)}\n${needsYouScope(count, where)}`}
      onClick={openAsks}
      {...rest}
      className={cn(
        "flex shrink-0 items-center gap-2 border text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
        variant === "row"
          ? "h-8 w-full rounded-(--radius-md) px-1.5"
          : "h-6 rounded-full px-2 text-meta",
        count > 0
          ? "border-status-needs-mark/60 font-medium text-status-needs hover:bg-status-needs-mark/10"
          : "border-transparent text-muted-foreground hover:bg-sidebar-row-hover",
        className,
      )}
    >
      {count > 0 && (
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-status-needs-mark" />
      )}
      <span className="min-w-0 flex-1 truncate">{words}</span>
    </button>
  );
}
