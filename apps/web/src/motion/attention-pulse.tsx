import * as m from "motion/react-m";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { useLookMotion, useMotionLevel } from "./hooks";
import { toEase } from "./transitions";

interface AttentionPulseProps {
  active: boolean;
  /** Change to replay the pulses. */
  trigger?: string | number;
  className?: string;
  children: ReactNode;
}

/**
 * Rings its children in the needs-attention colour while `active`: the ring pulses outward twice,
 * then stays still. Reduced fades without scaling; Off shows only the still ring.
 */
export function AttentionPulse({ active, trigger = 0, className, children }: AttentionPulseProps) {
  const level = useMotionLevel();
  const look = useLookMotion();
  return (
    <div className={cn("relative", className)}>
      {children}
      {active && (
        <>
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-status-needs"
          />
          {level !== "off" && (
            <m.span
              key={trigger}
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-[inherit] ring-2 ring-status-needs"
              initial={{ opacity: 0.9, scale: 1 }}
              animate={level === "full" ? { opacity: 0, scale: 1.035 } : { opacity: 0 }}
              transition={{
                duration: Math.max(0.6, (look.durations.slow * 4) / 1000),
                ease: toEase(look.easing.out),
                repeat: 1,
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
