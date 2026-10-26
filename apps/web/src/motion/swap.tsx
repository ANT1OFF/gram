import { useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * How many times `value` has changed since the caller mounted: 0 on the first render, so an effect
 * gated on it never plays for what was already there when the screen appeared.
 */
export function useChangeCount<T>(value: T): number {
  const [seen, setSeen] = useState({ value, count: 0 });
  if (Object.is(seen.value, value)) return seen.count;
  // Derived during render, as React asks for state that follows a prop: no frame shows the old count.
  setSeen({ value, count: seen.count + 1 });
  return seen.count + 1;
}

/**
 * Content that replaces other content in the same place: a status glyph, Copy turning into a check
 * mark, a word on a button. Keyed by `swapKey`, the new content fades in (and under Full settles from
 * slightly small) where the old stood; `undefined` shows nothing. Only a change plays: what is there
 * at mount is simply there, so a list of these never ripples as it loads. Opacity and transform
 * only, so nothing around it is measured differently.
 */
export function Swap({
  swapKey,
  as = "span",
  className,
  children,
}: {
  swapKey: string | undefined;
  /** `div` for block content, such as one step of a form replacing another. */
  as?: "span" | "div";
  className?: string;
  children: ReactNode;
}) {
  const changes = useChangeCount(swapKey);
  if (swapKey === undefined) return null;
  const Tag = as;
  return (
    <Tag
      key={swapKey}
      className={cn(as === "span" && "inline-flex", changes > 0 && "gram-swap", className)}
    >
      {children}
    </Tag>
  );
}
