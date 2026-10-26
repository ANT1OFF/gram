/*
 * The ring, arc, check and cross are redrawn after two MIT-licensed icon sets, whose notices are in
 * `THIRD-PARTY-NOTICES.md` beside this file: line-md's `confirm` (Copyright 2020 Vjacheslav
 * Trushkin) and svg-spinners' `90-ring` (Copyright (c) Utkarsh Verma). Neither set's SMIL animation
 * is used: the arc turns on the shared clock, and the rest is CSS transitions.
 */
import { cn } from "@/lib/utils";

import { onClock, spinAngle } from "./spin";

export type MarkPhase = "todo" | "pending" | "running" | "active" | "done" | "error";

const MARK_PHASES: ReadonlySet<string> = new Set<MarkPhase>([
  "todo",
  "pending",
  "running",
  "active",
  "done",
  "error",
]);

/** Whether `phase` is one a `StatusMark` draws; anything else is another glyph. */
export const isMarkPhase = (phase: string): phase is MarkPhase => MARK_PHASES.has(phase);

/**
 * Turns the ring while running, and leaves it where it stopped: the arc then closes into a whole
 * ring in place, rather than jumping back to twelve o'clock first.
 */
const turnRing = onClock({
  step: (element, now) => {
    element.style.rotate = `${spinAngle(now)}deg`;
  },
  rest: () => {},
});

/**
 * One glyph for a step's life: an empty ring to do, a dashed one pending, an arc that turns while
 * running (a dot in the ring for a step in hand that isn't turning), and on done the arc closes into a ring as a check draws inside it (a cross on error).
 * Only a change plays, being CSS transitions: mounted done, it is simply done. Reduced lands each
 * phase at once with a fade, Off at once.
 */
export function StatusMark({ phase, className }: { phase: MarkPhase; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      data-phase={phase}
      data-testid="status-mark"
      className={cn("gram-mark", className)}
    >
      <circle
        ref={phase === "running" ? turnRing : undefined}
        className="gram-mark-ring"
        cx="12"
        cy="12"
        r="9.5"
        pathLength={100}
      />
      <circle className="gram-mark-dot" cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
      <path className="gram-mark-check" d="M7.75 12.25l2.85 2.85l5.65 -5.65" pathLength={1} />
      <path className="gram-mark-cross" d="M9 9l6 6M15 9l-6 6" pathLength={1} />
    </svg>
  );
}
