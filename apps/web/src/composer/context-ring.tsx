import { Popover } from "@base-ui/react/popover";
import type { ThreadId } from "@gram/contracts";

import { cn } from "@/lib/utils";
import { useThreadsStore } from "@/stores/threads";
import { contextLevel, contextPercent, UsageBar, type ContextLevel } from "@/thread/usage-bar";
import { useCostShown } from "@/usage/cost";

const RADIUS = 8;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// The fill is a glyph read against the composer's card, so it takes text-grade tokens, which the
// contrast matrix holds above the UI floor on every surface.
const FILL: Record<ContextLevel, string> = {
  normal: "stroke-muted-foreground",
  warning: "stroke-warning",
  critical: "stroke-destructive",
};

/** How much of the ring to leave undrawn for `percent`, as a `stroke-dashoffset`. */
export const ringOffset = (percent: number): number =>
  CIRCUMFERENCE * (1 - Math.min(100, Math.max(0, percent)) / 100);

/** The trigger's name: the context filled when there is a window to fill, else just "Usage". */
export const ringLabel = (percent: number | undefined): string =>
  percent === undefined ? "Usage" : `Usage: ${percent}% of the context window`;

/**
 * The thread's usage beside Send: a ring for how full the context window is, opening onto the
 * usage bar (tokens, context, and cost on a gateway). Without a window to measure the ring is only
 * its dashed track. Subscribed on its own, so a usage report renders only the ring.
 */
export function ContextRing({ threadId, countUp }: { threadId: ThreadId; countUp: boolean }) {
  const usage = useThreadsStore((s) => s.usage[threadId]);
  const showCost = useCostShown(useThreadsStore((s) => s.byId[threadId]?.thread.model));
  if (!usage) return null;
  const percent = contextPercent(usage);
  const level = percent === undefined ? "normal" : contextLevel(percent);

  return (
    <Popover.Root>
      <Popover.Trigger
        openOnHover
        delay={150}
        data-testid="usage-ring"
        data-level={level}
        aria-label={ringLabel(percent)}
        className="grid size-7 shrink-0 place-items-center rounded-full outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <svg aria-hidden viewBox="0 0 20 20" className="size-5 -rotate-90">
          <circle
            cx="10"
            cy="10"
            r={RADIUS}
            fill="none"
            strokeWidth="2.5"
            strokeDasharray={percent === undefined ? "2 2.2" : undefined}
            className="stroke-[color-mix(in_srgb,var(--fg-muted)_28%,transparent)]"
          />
          {percent !== undefined && (
            <circle
              cx="10"
              cy="10"
              r={RADIUS}
              fill="none"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={ringOffset(percent)}
              className={cn(
                "transition-[stroke-dashoffset] duration-(--dur-move-base) ease-(--ease-spring)",
                FILL[level],
              )}
            />
          )}
        </svg>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="end" sideOffset={8} className="isolate z-50">
          <Popover.Popup
            data-surface="overlay"
            aria-label="Usage"
            className="origin-(--transform-origin) rounded-md border border-border bg-popover px-3 py-1 text-popover-foreground shadow-md outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
          >
            <UsageBar usage={usage} countUp={countUp} showCost={showCost} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
