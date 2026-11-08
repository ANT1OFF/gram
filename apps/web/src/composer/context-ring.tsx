import { Popover } from "@base-ui/react/popover";
import type { ThreadId } from "@gram/contracts";

import { cn } from "@/lib/utils";
import { useThreadsStore } from "@/stores/threads";
import { contextLevel, contextPercent, UsageBar, type ContextLevel } from "@/thread/usage-bar";
import { useCostShown } from "@/usage/cost";

import { PHONE_HIT } from "./styles";

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
  percent === undefined ? "Usage" : `Context: ${percent}% of the window used`;

/** What the number is, said once in its popover: a bare percentage beside Send read as anything. */
export const CONTEXT_HINT =
  "How much of the model's context window this thread has used. Near full, the agent compacts older turns to make room.";

/**
 * The thread's usage beside Send: how full the context window is, as a short bar in the title
 * bar's usage meter's colours in a 32 px target, its words on hover: the pointer opens its popover,
 * headed "Context 36%", onto the usage bar (tokens, context, and cost on a gateway) and a line on
 * what it measures; its name says the same. Never a ring: a partly drawn circle beside Send read as
 * a spinner on a thread with nothing running. Without a window to measure, the bar is an empty
 * track named "Usage". Subscribed on its own, so a usage report renders only this.
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
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-(--radius-sm) outline-none hover:bg-accent focus-visible:focus-ring",
          PHONE_HIT,
        )}
      >
        {/* The bar alone; its words, "Context 36%", head the popover the pointer opens. */}
        <span
          aria-hidden
          data-testid="usage-ring-bar"
          className="block h-1 w-5 shrink-0 overflow-hidden rounded-full bg-foreground/15"
        >
          {percent !== undefined && (
            <span
              className={cn(
                "block h-full rounded-full transition-[width] duration-(--dur-move-base) ease-(--ease-spring)",
                FILL[level],
              )}
              style={{ width: `${barShare(percent)}%` }}
            />
          )}
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="end" sideOffset={8} className="isolate z-50">
          <Popover.Popup
            data-surface="overlay"
            aria-label="Usage"
            className="origin-(--transform-origin) rounded-md border border-edge bg-popover px-3 py-1 text-popover-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
          >
            <p data-testid="usage-ring-title" className="pt-1.5 text-meta font-medium tabular-nums">
              {percent === undefined ? "Usage" : `Context ${percent}%`}
            </p>
            <UsageBar usage={usage} countUp={countUp} showCost={showCost} />
            {percent !== undefined && (
              <p className="max-w-64 pb-1 text-meta text-muted-foreground">{CONTEXT_HINT}</p>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
