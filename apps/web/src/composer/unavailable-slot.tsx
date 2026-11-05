import type { ReactNode } from "react";

import { Hint } from "@/components/hint";
import { cn } from "@/lib/utils";

import { GHOST_TRIGGER } from "./styles";

/**
 * A toolbar control that doesn't apply here, such as Effort for a model with none: its glyph
 * greyed in its usual slot, so the controls after it keep their places, and why on hover.
 */
export function UnavailableSlot({
  label,
  reason,
  children,
}: {
  label: string;
  reason: string;
  children: ReactNode;
}) {
  return (
    <Hint
      label={`${label}: ${reason}`}
      render={
        <button
          type="button"
          aria-disabled="true"
          aria-label={`${label}: ${reason}`}
          data-testid={`unavailable-${label.toLowerCase()}`}
          className={cn(
            GHOST_TRIGGER,
            "inline-flex cursor-default items-center justify-center rounded-md opacity-50 hover:bg-transparent hover:text-muted-foreground dark:hover:bg-transparent",
          )}
        />
      }
    >
      {children}
    </Hint>
  );
}
