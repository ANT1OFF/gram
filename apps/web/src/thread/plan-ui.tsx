import type { PlanHeadline, ThreadId } from "@gram/contracts";
import { CircleCheck } from "lucide-react";
import { useEffect, useState } from "react";

import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { HYSTERESIS_MS } from "@/sidebar/hysteresis";
import { activityLine } from "@/sidebar/status";
import { useThreadsStore } from "@/stores/threads";

import { hasPlan, headlineOf, PHASE_TONE } from "./plan-model";

const keyOf = (headline: PlanHeadline | undefined): string =>
  headline === undefined
    ? ""
    : `${headline.phase}|${headline.text}|${headline.pr ?? ""}|${headline.prUrl ?? ""}|${headline.done}/${headline.total}`;

/**
 * `headline` as the screen shows it: a change settles in after `HYSTERESIS_MS`, so a row doesn't
 * flicker through every step of a busy turn. Needing the user, and a headline appearing or going,
 * show at once.
 */
function useSteadyHeadline(headline: PlanHeadline | undefined): PlanHeadline | undefined {
  const key = keyOf(headline);
  const [shown, setShown] = useState({ key, headline });
  const instant =
    shown.headline === undefined || headline === undefined || headline.phase === "needsYou";
  // Derived during render, as React asks for state that follows a prop.
  if (shown.key !== key && instant) setShown({ key, headline });
  const [pending, setPending] = useState(headline);
  if (keyOf(pending) !== key) setPending(headline);
  useEffect(() => {
    if (shown.key === key || instant) return;
    const timer = setTimeout(() => setShown({ key, headline: pending }), HYSTERESIS_MS);
    return () => clearTimeout(timer);
  }, [key, shown.key, instant, pending]);
  return instant ? headline : shown.headline;
}

/**
 * A thread's headline, from the store, and whether it keeps a plan: a thread without one still has
 * a headline for what needs the user, and for its PR, which only some places show.
 */
export function useThreadHeadline(threadId: ThreadId): {
  readonly headline: PlanHeadline | undefined;
  readonly planned: boolean;
} {
  const summary = useThreadsStore((s) => s.byId[threadId]);
  const turnPlan = useThreadsStore((s) => s.plans[threadId]);
  const detail = useThreadsStore((s) => s.statusDetail[threadId]);
  const planned = hasPlan(summary?.plan, turnPlan);
  // Only the idle rule reads the clock, in days, so a slow tick will do.
  const now = useNow(summary !== undefined, undefined, 10 * 60_000);
  const activity =
    summary === undefined ? undefined : activityLine(summary.status, detail, summary.activity);
  const headline = useSteadyHeadline(
    summary === undefined ? undefined : headlineOf(summary, turnPlan, activity, now),
  );
  return { headline, planned };
}

const RING_R = 5.25;
const RING_C = 2 * Math.PI * RING_R;

/** A ring filled to the share of steps done, in the phase's tone; the check once all are. */
export function PlanRing({
  headline,
  className,
}: {
  headline: Pick<PlanHeadline, "phase" | "done" | "total">;
  className?: string;
}) {
  const share = headline.total === 0 ? 0 : headline.done / headline.total;
  if (share === 1) {
    return (
      <CircleCheck
        aria-hidden
        data-testid="plan-ring"
        data-share={1}
        className={cn("size-3.5 shrink-0 text-success", className)}
      />
    );
  }
  return (
    <svg
      aria-hidden
      data-testid="plan-ring"
      data-share={share}
      viewBox="0 0 14 14"
      className={cn("size-3.5 shrink-0", PHASE_TONE[headline.phase], className)}
    >
      <circle
        cx="7"
        cy="7"
        r={RING_R}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.28"
        strokeWidth="1.6"
      />
      {share > 0 && (
        <circle
          cx="7"
          cy="7"
          r={RING_R}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeDasharray={`${RING_C * share} ${RING_C}`}
          strokeLinecap="round"
          transform="rotate(-90 7 7)"
        />
      )}
    </svg>
  );
}
