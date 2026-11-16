import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * Where something still loading will be: a block in the surface-hover fill at the size of what
 * comes (give it a height and width), pulsing under the Full motion setting only. A span, so it
 * sits in a line of text as well as in a block. Hidden from a screen reader: say what loads in
 * words nearby, or put the skeletons in a `role="status"` with a label.
 */
export function Skeleton({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      aria-hidden
      data-slot="skeleton"
      className={cn("block rounded-sm bg-accent motion-safe:animate-pulse", className)}
      {...props}
    />
  );
}
