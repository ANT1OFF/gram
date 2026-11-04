import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { useTitlebarSlot, type TitlebarFold } from "./titlebar-slot";

/**
 * What a narrow bar folds into "…", at `level`, its fold (see `TitlebarFold`). Folded it stays laid
 * out, unseen, inert and hidden from the accessibility tree, out of the row: the bar measures it
 * there to know when it fits back, whatever it holds by then. `gap` is the room its row leaves
 * before it.
 */
export function Foldable({
  level,
  gap,
  className,
  children,
}: {
  level: Exclude<TitlebarFold, 0>;
  gap: number;
  className?: string;
  children: ReactNode;
}) {
  const folded = useTitlebarSlot((s) => s.fold >= level);
  return (
    <span
      data-titlebar-fold={gap}
      data-titlebar-fold-level={level}
      aria-hidden={folded || undefined}
      inert={folded}
      className={cn(
        "flex shrink-0 items-center",
        // At the row's end, where it can't widen what it overhangs.
        folded && "pointer-events-none invisible absolute top-0 right-0",
        className,
      )}
    >
      {children}
    </span>
  );
}
