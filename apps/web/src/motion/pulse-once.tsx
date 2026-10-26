import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { useChangeCount } from "./swap";

export type PulseTone = "needs" | "success" | "merged" | "primary";

/**
 * Marks the moment something changed for the better or started needing you: one ring that widens and
 * fades around `children`, once, when `trigger` changes while `when` holds. `burst` adds a few sparks
 * for the rare thing worth a small celebration (a PR merging). Never at mount, so a screen full of
 * green checks loads still; never looping; nothing to dismiss. Reduced fades the ring without
 * widening it and drops the sparks, and Off shows nothing.
 */
export function PulseOnce({
  trigger,
  when = true,
  tone = "primary",
  burst = false,
  className,
  children,
}: {
  /** What changed; the pulse replays each time this does. */
  trigger: string | number | boolean | undefined;
  /** Whether the new value is one worth marking. */
  when?: boolean;
  tone?: PulseTone;
  burst?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const changes = useChangeCount(trigger);
  return (
    <span className={cn("relative inline-flex", className)}>
      {children}
      {changes > 0 && when && (
        <span
          key={changes}
          aria-hidden
          data-testid="pulse-once"
          data-tone={tone}
          data-burst={burst || undefined}
          className="gram-pulse-once"
        />
      )}
    </span>
  );
}
