import { Popover } from "@base-ui/react/popover";
import {
  DEFAULT_PR_WAKE_EVENTS,
  prWakeWhen,
  type ThreadId,
  type ThreadWake,
} from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { AlarmClock, X } from "lucide-react";
import { useState } from "react";

import { useApi } from "@/api/context";
import { wakeWhenText } from "@/orchestration/board-model";
import type { Api } from "@/api/types";
import { Button } from "@/components/ui/button";
import { formatWakeTime } from "@/lib/time";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

const NO_WAKES: readonly ThreadWake[] = [];

const threadWakesQuery = (api: Api) => ({
  queryKey: ["threadWakes"],
  queryFn: () => api.listThreadWakes(),
  retry: false,
});

/**
 * The wakes a plain thread set itself with `schedule_wake`, soonest first. Every row and header
 * reads the one list, refetched when the server says it changed.
 */
export function useThreadWakes(threadId: ThreadId): readonly ThreadWake[] {
  const { data } = useQuery({
    ...threadWakesQuery(useApi()),
    select: (list) => list.wakes.filter((wake) => wake.threadId === threadId),
  });
  return data ?? NO_WAKES;
}

const report = (op: Promise<unknown>) =>
  void op.catch((error: unknown) => console.error("cancel wake", error));

const hintOf = (wakes: readonly ThreadWake[], now: number) =>
  wakes
    .map((wake) => `${wakeWhenText(wake, (at) => formatWakeTime(at, now))}: ${wake.note}`)
    .join("\n");

/** A chip's label: the PR a wake on another PR waits on, or when a timed one is due. */
const labelOf = (wake: ThreadWake, now: number) =>
  wake.onPr === undefined ? formatWakeTime(wake.at, now) : `#${wake.onPr.number}`;

/**
 * The pane header's ⏰ chip: the soonest wake's time, opening a list of every wake with its note
 * and a Cancel for each.
 */
export function HeaderWakeChip({
  threadId,
  className,
}: {
  threadId: ThreadId;
  className?: string;
}) {
  const api = useApi();
  const wakes = useThreadWakes(threadId);
  const [open, setOpen] = useState(false);
  const now = useNow(wakes.length > 0, undefined, 60_000);
  const [soonest] = wakes;
  if (soonest === undefined) return null;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        data-testid="pane-wake"
        aria-label={`${wakes.length === 1 ? "Wake" : `${wakes.length} wakes`} pending, the first ${
          soonest.onPr === undefined
            ? `at ${formatWakeTime(soonest.at, now)}`
            : `when ${prWakeWhen(soonest.onPr, soonest.on ?? DEFAULT_PR_WAKE_EVENTS)}`
        }`}
        title={hintOf(wakes, now)}
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-sm border border-border px-1 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        <AlarmClock aria-hidden className="size-3" />
        {labelOf(soonest, now)}
        {wakes.length > 1 && <span className="tabular-nums">+{wakes.length - 1}</span>}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} className="isolate z-50">
          <Popover.Popup
            data-testid="pane-wake-popup"
            className="w-72 origin-(--transform-origin) rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-md outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
          >
            <Popover.Title className="px-1 pb-1.5 text-xs text-muted-foreground">
              The agent set these to wake itself with its note.
            </Popover.Title>
            <ul aria-label="Pending wakes" className="flex max-h-72 flex-col overflow-y-auto">
              {wakes.map((wake) => (
                <li key={wake.id} className="flex items-start gap-2 rounded-sm px-1 py-1">
                  <span
                    title={wakeWhenText(wake, (at) => formatWakeTime(at, now))}
                    className="w-16 shrink-0 text-xs text-muted-foreground tabular-nums"
                  >
                    {labelOf(wake, now)}
                  </span>
                  <span className="min-w-0 flex-1 text-sm break-words">
                    {wake.onPr !== undefined && (
                      <span className="block text-xs text-muted-foreground">
                        {wakeWhenText(wake, (at) => formatWakeTime(at, now))}
                      </span>
                    )}
                    {wake.note}
                  </span>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Cancel the wake at ${formatWakeTime(wake.at, now)}`}
                    title="Cancel"
                    onClick={() => report(api.cancelThreadWake(threadId, wake.id))}
                  >
                    <X aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
