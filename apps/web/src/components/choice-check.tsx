import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The picked choice's check, beside its title: with the accent fill and edge, the pick reads by
 * shape as well as colour. Takes its room whether shown or not, so picking moves nothing.
 */
export function ChoiceCheck({ checked, className }: { checked: boolean; className?: string }) {
  return (
    <Check
      aria-hidden
      data-testid={checked ? "choice-check" : undefined}
      className={cn(
        "size-icon-row shrink-0 text-(--row-cursor-edge) transition-opacity duration-(--dur-fast)",
        checked ? "opacity-100" : "opacity-0",
        className,
      )}
    />
  );
}
