import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** On the `<details>` a `FoldSummary` heads, so its chevron turns as it opens. */
export const FOLD = "group/fold";

/**
 * A `<details>`' summary as every other fold in Gram draws its own: the 14 px chevron that turns
 * as it opens, never the browser's triangle. The `<details>` takes `FOLD`.
 */
export function FoldSummary({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <summary
      className={cn(
        "flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden",
        className,
      )}
    >
      <ChevronRight
        aria-hidden
        className="size-icon-chip shrink-0 transition-transform duration-(--dur-fast) group-open/fold:rotate-90"
      />
      <span className="min-w-0">{children}</span>
    </summary>
  );
}
