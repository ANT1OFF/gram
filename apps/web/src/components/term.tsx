import type { ReactNode } from "react";

import { useFirstUse, type TermId } from "@/lib/first-use";
import { cn } from "@/lib/utils";

/**
 * One of Gram's own words where it is met: dotted underneath until its explanation has opened once
 * (on hover or focus), so a first look says there is one; plain after. The words never change.
 */
export function Term({
  term,
  children,
  className,
}: {
  term: TermId;
  children: ReactNode;
  className?: string;
}) {
  const seen = useFirstUse((s) => s.seen[term] === true);
  return (
    <span
      data-term={term}
      data-first-use={seen ? undefined : ""}
      className={cn(
        !seen && "underline decoration-current/50 decoration-dotted underline-offset-4",
        className,
      )}
    >
      {children}
    </span>
  );
}
