import { Popover } from "@base-ui/react/popover";
import type { ThreadId } from "@gram/contracts";

import { cn } from "@/lib/utils";
import { useThreadsStore } from "@/stores/threads";
import { contextLevel, contextPercent, UsageBar, type ContextLevel } from "@/thread/usage-bar";
import { useCostShown } from "@/usage/cost";

// The fill is read against the composer's card, so it takes the title bar's usage meter's tokens
// (`LimitBar`), which the contrast matrix holds above the UI floor on every surface.
const FILL: Record<ContextLevel, string> = {
  normal: "bg-muted-foreground",
  warning: "bg-warning",
  critical: "bg-destructive",
};

/** How much of the bar to fill for `percent`, clamped to the track. */
export const barShare = (percent: number): number => Math.min(100, Math.max(0, percent));

/** The trigger's name: the context filled when there is a window to fill, else just "Usage". */
export const ringLabel = (percent: number | undefined): string =>
  percent === undefined ? "Usage" : `Usage: ${percent}% of the context window`;

/**
 * The thread's usage beside Send: how full the context window is, its number over a thin bar in
 * the title bar's usage meter's colours, in the 32 px the ring had, opening onto the usage bar (tokens, context, and cost on a
 * gateway). Never a ring: a partly drawn circle beside Send read as a spinner on a thread with
 * nothing running. Without a window to measure it says "Usage". Subscribed on its own, so a usage
 * report renders only this.
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
        // The ring's 32 px, no wider: the toolbar measures this slot to decide when its pickers go
        // compact (`useToolbarLayout`), so a wider gauge would fold them a step early.
        className="flex size-8 shrink-0 flex-col items-center justify-center gap-0.5 rounded-(--radius-sm) text-caption leading-none text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:focus-ring"
      >
        {percent === undefined ? (
          <span>Usage</span>
        ) : (
          <>
            <span aria-hidden className="tabular-nums">
              {percent}%
            </span>
            <span
              aria-hidden
              data-testid="usage-ring-bar"
              className="block h-0.5 w-5 shrink-0 overflow-hidden rounded-full bg-foreground/15"
            >
              <span
                className={cn(
                  "block h-full rounded-full transition-[width] duration-(--dur-move-base) ease-(--ease-spring)",
                  FILL[level],
                )}
                style={{ width: `${barShare(percent)}%` }}
              />
            </span>
          </>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="end" sideOffset={8} className="isolate z-50">
          <Popover.Popup
            data-surface="overlay"
            aria-label="Usage"
            className="origin-(--transform-origin) rounded-md border border-edge bg-popover px-3 py-1 text-popover-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
          >
            <UsageBar usage={usage} countUp={countUp} showCost={showCost} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
