import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Animates between collapsed and `height: auto`; collapsed content is inert. */
export function Expand({
  open,
  id,
  className,
  children,
}: {
  open: boolean;
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div id={id} className={cn("gram-expand", className)} data-open={open} inert={!open}>
      {children}
    </div>
  );
}
