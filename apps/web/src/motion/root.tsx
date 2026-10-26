import { LazyMotion, MotionConfig } from "motion/react";
import type { ReactNode } from "react";

import { useMotionLevel } from "./hooks";

const loadFeatures = () => import("./features").then((mod) => mod.default);

/**
 * Loads Motion's features lazily and applies the motion setting: Reduced and Off strip transform and
 * layout animation, and Off also zeroes default transitions.
 */
export function MotionRoot({ children }: { children: ReactNode }) {
  const level = useMotionLevel();
  return (
    <LazyMotion features={loadFeatures}>
      <MotionConfig
        reducedMotion={level === "full" ? "never" : "always"}
        {...(level === "off" ? { transition: { duration: 0 } } : {})}
      >
        {children}
      </MotionConfig>
    </LazyMotion>
  );
}
