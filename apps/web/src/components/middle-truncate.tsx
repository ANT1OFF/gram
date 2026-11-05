import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/** Titles this short fit a sidebar row whole, so they are never split. */
const SPLIT_FROM = 24;
/** The most of a title's ending kept whole: its last word or two. */
const TAIL_MAX = 14;
/** A last word longer than that keeps only this many of its letters. */
const TAIL_LETTERS = 8;

/**
 * Where a long title splits so its ending survives a cut: the last word or two (at most
 * `TAIL_MAX` characters, its leading space included), or the last `TAIL_LETTERS` letters of a
 * long last word. Undefined for a title short enough to fit whole.
 */
export function middleSplit(text: string): { head: string; tail: string } | undefined {
  if (text.length < SPLIT_FROM) return undefined;
  const space = text.lastIndexOf(" ", text.length - 2);
  const cut = space > 0 && text.length - space <= TAIL_MAX ? space : text.length - TAIL_LETTERS;
  return { head: text.slice(0, cut), tail: text.slice(cut) };
}

/**
 * A one-line title cut in the middle rather than at its end, so the ending that tells two similar
 * titles apart ("…webhook retries", "…webhook signing") stays in view. The head takes the ellipsis;
 * the tail keeps its width. The text reads whole to a screen reader and to `textContent`.
 */
export function MiddleTruncate({
  text,
  className,
  ...props
}: { text: string } & Omit<ComponentProps<"span">, "children">) {
  const split = middleSplit(text);
  if (split === undefined) {
    return (
      <span className={cn("truncate", className)} {...props}>
        {text}
      </span>
    );
  }
  return (
    <span className={cn("flex min-w-0", className)} {...props}>
      <span className="min-w-0 truncate">{split.head}</span>
      <span className="shrink-0 whitespace-pre">{split.tail}</span>
    </span>
  );
}
