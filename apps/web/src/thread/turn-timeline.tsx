import { Popover } from "@base-ui/react/popover";
import type { ThreadId } from "@gram/contracts";
import { ChartNoAxesGantt } from "lucide-react";
import { useRef, useState } from "react";

import { Hint } from "@/components/hint";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { feedMessages } from "@/stores/feeds";

import type { TurnSummary } from "./tool-group-model";
import { turnReplies, turnTimeline, type StepTone, type TurnTimeline } from "./turn-timeline-model";

const BAR: Readonly<Record<StepTone, string>> = {
  done: "bg-muted-foreground/70",
  running: "bg-primary",
  failed: "bg-destructive",
  stopped: "bg-muted-foreground/35",
};

/**
 * The run timeline beside a turn's fold row: a small chart button that opens the turn's tool calls
 * as bars on one time axis, so what took the time, and what ran side by side, shows at a glance.
 * Read from the thread's loaded messages when it opens, and again each second while the turn runs.
 */
export function TurnTimelineButton({
  threadId,
  turn,
  summary,
}: {
  threadId: ThreadId;
  turn: string;
  summary: TurnSummary;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Hint
        label="Run timeline"
        render={
          <Popover.Trigger
            data-testid="turn-timeline-open"
            aria-label="Run timeline"
            className="grid size-6 shrink-0 place-items-center rounded-(--radius-sm) text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:text-foreground"
          />
        }
      >
        <ChartNoAxesGantt aria-hidden className="size-icon-row" />
      </Hint>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={4} className="isolate z-50">
          <Popover.Popup
            data-surface="overlay"
            data-testid="turn-timeline"
            aria-label="Run timeline"
            className="w-[min(36rem,calc(100vw-2rem))] origin-(--transform-origin) rounded-md border border-edge bg-popover p-3 text-meta text-popover-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
          >
            {open && <TimelineBody threadId={threadId} turn={turn} summary={summary} />}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function TimelineBody({
  threadId,
  turn,
  summary,
}: {
  threadId: ThreadId;
  turn: string;
  summary: TurnSummary;
}) {
  const running = summary.state === "running";
  const root = useRef<HTMLDivElement>(null);
  const now = useNow(running, root);
  const { replies, startedAt } = turnReplies(feedMessages(threadId), turn);
  const timeline = turnTimeline(
    replies,
    summary.startedAt ?? startedAt,
    running ? undefined : summary.endedAt,
    now,
  );
  return (
    <div ref={root}>
      {timeline === undefined ? (
        <p data-testid="turn-timeline-empty" className="text-muted-foreground">
          No timings for this turn: its tool calls ran before Gram recorded them.
        </p>
      ) : (
        <Chart timeline={timeline} />
      )}
    </div>
  );
}

function Chart({ timeline }: { timeline: TurnTimeline }) {
  const untimed = timeline.steps.filter((step) => step.left === undefined).length;
  return (
    <>
      <p className="flex items-baseline justify-between gap-3">
        <span className="font-medium">Run timeline</span>
        <span data-testid="turn-timeline-share" className="text-muted-foreground tabular-nums">
          Tools ran {timeline.toolShare}% of the turn
        </span>
      </p>
      <ol className="mt-2 grid max-h-80 gap-y-1 overflow-y-auto pr-1">
        {timeline.steps.map((step) => (
          <li
            key={step.toolCallId}
            data-testid="turn-timeline-step"
            data-tone={step.tone}
            className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)_3rem] items-center gap-2"
          >
            <span title={step.label} className="truncate text-muted-foreground">
              {step.label}
            </span>
            <span className="relative h-2 rounded-full bg-foreground/8">
              {step.left !== undefined && (
                <span
                  className={cn(
                    "absolute inset-y-0 min-w-1 rounded-full",
                    BAR[step.tone],
                    step.tone === "running" && "animate-pulse",
                  )}
                  style={{ left: `${step.left}%`, width: `${step.width}%` }}
                />
              )}
            </span>
            <span className="text-right text-muted-foreground tabular-nums">
              {step.took ?? (step.tone === "running" ? "…" : "")}
            </span>
          </li>
        ))}
      </ol>
      <div
        aria-hidden
        className="mt-1 grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)_3rem] gap-2 text-caption text-muted-foreground tabular-nums"
      >
        <span />
        <span className="flex justify-between">
          {timeline.ticks.map((tick) => (
            <span key={tick.at}>{tick.label}</span>
          ))}
        </span>
        <span />
      </div>
      {untimed > 0 && (
        <p className="mt-2 text-muted-foreground">
          {untimed === 1 ? "1 call has" : `${untimed} calls have`} no recorded time.
        </p>
      )}
    </>
  );
}
