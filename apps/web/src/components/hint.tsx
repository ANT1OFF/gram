import type { ReactElement, ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * The words behind a glyph, shown the moment it is hovered or focused. For marks that are an icon
 * or a bare count: a native `title` waits a second before it says what they mean. Line breaks in
 * `label` are kept, so a state-then-remedy title reads as two lines.
 */
export function Hint({
  label,
  render,
  children,
  side = "top",
}: {
  /** Words, or for a list of them, a node. */
  label: ReactNode;
  /** The element that carries the glyph, with its own test id, classes and handlers. */
  render: ReactElement;
  children?: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={render}>{children}</TooltipTrigger>
      <TooltipContent side={side} className="whitespace-pre-line">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
