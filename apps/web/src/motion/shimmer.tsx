import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { clockPhase, onClock } from "./spin";

const SWEEP_MS = 1600;

const easeInOut = (t: number) => t * t * (3 - 2 * t);

const sweep = onClock({
  step: (element, now) => {
    element.style.backgroundPositionX = `${100 - 100 * easeInOut(clockPhase(now, SWEEP_MS))}%`;
  },
  rest: (element) => {
    element.style.backgroundPositionX = "";
  },
});

/**
 * A band of light across the glyphs of `children` while `active` (e.g. "Thinking…"), on the shared
 * clock, so it stops off screen, while the window is hidden and under Reduced and Off motion.
 */
export function Shimmer({
  active = true,
  className,
  children,
}: {
  active?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      ref={active ? sweep : undefined}
      className={cn("gram-shimmer", className)}
      data-active={active}
    >
      {children}
    </span>
  );
}
