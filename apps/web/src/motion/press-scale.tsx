import * as m from "motion/react-m";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { useMotionLevel, usePresetTransition } from "./hooks";

/**
 * Shrinks its children slightly while pressed, and grows them by `hover` under the pointer when
 * given; still under Reduced and Off.
 */
export function PressScale({
  scale = 0.97,
  hover,
  className,
  children,
}: {
  scale?: number;
  hover?: number | undefined;
  className?: string;
  children: ReactNode;
}) {
  const level = useMotionLevel();
  const snappy = usePresetTransition("snappy");
  return (
    <m.div
      className={cn("inline-flex", className)}
      transition={snappy}
      {...(level === "full"
        ? { whileTap: { scale }, ...(hover === undefined ? {} : { whileHover: { scale: hover } }) }
        : {})}
    >
      {children}
    </m.div>
  );
}
