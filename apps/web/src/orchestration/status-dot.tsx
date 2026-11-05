import { Hourglass, Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TitlebarPopover } from "@/shell/titlebar-popover";

import { TONE_DOT, type RailTone } from "./rail-model";

// One dot per state, the same in the sidebar, on the Board and in Workers: a filled dot is where
// the thing stands, a hollow ring that it waits on something outside it (checks, a review, a
// wake), and a dashed ring a brief held for a usage limit. Colour is the status it means
// (DESIGN.md): amber needs you, the accent works, red failed, the merged colour merged. The legend
// says so, from the sidebar's header and the Board's.

/** Every state a dot can say: a worker's tone, a finished or archived worker, and a held brief. */
export type DotState = RailTone | "done" | "archived" | "held";

export const STATUS_DOTS: Readonly<
  Record<DotState, { readonly dot: string; readonly label: string; readonly meaning: string }>
> = {
  needs: {
    dot: TONE_DOT.needs,
    label: "Needs you",
    meaning: "A question, an approval or an ask waits on you",
  },
  working: { dot: TONE_DOT.working, label: "Working", meaning: "Running a turn now; it pulses" },
  waiting: {
    dot: TONE_DOT.waiting,
    label: "Waiting",
    meaning: "On something outside it: checks, a review, a wake",
  },
  attention: {
    dot: TONE_DOT.attention,
    label: "Needs attention",
    meaning: "Stopped with its own next step; nothing will wake it",
  },
  error: { dot: TONE_DOT.error, label: "Failed", meaning: "Its last turn or its checks failed" },
  idle: { dot: TONE_DOT.idle, label: "Idle", meaning: "At rest; faded once quiet for a day" },
  merged: { dot: TONE_DOT.merged, label: "Merged", meaning: "Its pull request merged" },
  done: { dot: "bg-success", label: "Done", meaning: "Delivered without a pull request" },
  archived: { dot: "bg-border-strong", label: "Archived", meaning: "Put away; History keeps it" },
  held: {
    dot: "border border-dashed border-muted-foreground bg-transparent",
    label: "Held",
    meaning: "Paused by you, or held until a usage limit resets",
  },
};

/** The order the legend lists them in: what needs you first, then what moves, then what rests. */
const LEGEND_ORDER: readonly DotState[] = [
  "needs",
  "working",
  "waiting",
  "attention",
  "error",
  "idle",
  "merged",
  "held",
];

/**
 * A state's 8 px dot. `working` pulses unless `still`. Decorative: the row it sits on says the state
 * in words, so it is hidden from a screen reader unless `label` is given.
 */
export function StatusDot({
  state,
  still = false,
  label,
  className,
  ...data
}: {
  state: DotState;
  still?: boolean;
  /** Its name, for a dot with no words beside it. */
  label?: string;
  className?: string;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
  const working = state === "working" && !still;
  return (
    <span
      {...data}
      aria-hidden={label === undefined || undefined}
      role={label === undefined ? undefined : "img"}
      aria-label={label}
      data-working={working || undefined}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        STATUS_DOTS[state].dot,
        working && "gram-working",
        className,
      )}
    />
  );
}

/** What the dots and the sidebar's marks mean, one line each. */
export function StatusLegend() {
  return (
    <div data-testid="status-legend" className="flex w-72 flex-col gap-3 p-3 text-meta">
      <section aria-label="Dots" className="flex flex-col gap-1.5">
        <h3 className="text-caption font-medium tracking-wide text-muted-foreground uppercase">
          Dots
        </h3>
        <ul className="flex flex-col gap-1">
          {LEGEND_ORDER.map((state) => (
            <li
              key={state}
              data-testid="status-legend-dot"
              data-state={state}
              className="grid grid-cols-[0.625rem_minmax(0,1fr)] items-baseline gap-x-2"
            >
              <span className="flex h-lh items-center justify-center">
                <StatusDot state={state} still />
              </span>
              <span className="min-w-0">
                <span className="font-medium text-foreground">{STATUS_DOTS[state].label}</span>
                <span className="text-muted-foreground"> · {STATUS_DOTS[state].meaning}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground">Filled is where it stands; hollow waits on others.</p>
      </section>
      <section aria-label="Marks" className="flex flex-col gap-1.5 border-t border-border pt-3">
        <h3 className="text-caption font-medium tracking-wide text-muted-foreground uppercase">
          Marks
        </h3>
        <ul className="flex flex-col gap-1">
          <li className="grid grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-x-2">
            <span
              aria-hidden
              className="min-w-4.5 rounded-full border border-status-needs-mark/70 px-1.5 text-center text-caption leading-4 font-semibold text-status-needs tabular-nums"
            >
              1
            </span>
            <span className="text-muted-foreground">
              <span className="text-foreground">Count</span> · how many need you in that workspace;
              the pill at the top counts all of them
            </span>
          </li>
          <li className="grid grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-x-2">
            <Hourglass aria-hidden className="size-3.5 justify-self-center text-muted-foreground" />
            <span className="text-muted-foreground">
              <span className="text-foreground">Waits on</span> · what it waits for, in its hover
            </span>
          </li>
          <li className="grid grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-x-2">
            <span aria-hidden />
            <span className="text-muted-foreground">
              <span className="text-foreground">asks you</span> · a worker's line while it needs
              you; the Inbox has the ask
            </span>
          </li>
        </ul>
      </section>
    </div>
  );
}

/** The legend's button: an inline (14 px) info glyph that opens it under itself. */
export function StatusLegendButton({
  className,
  align = "start",
  testId = "status-legend-button",
}: {
  className?: string;
  align?: "start" | "end";
  testId?: string;
}) {
  return (
    <TitlebarPopover
      label="What the dots mean"
      hint="What the dots mean"
      align={align}
      testId="status-legend-popover"
      trigger={
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="What the dots mean"
          data-testid={testId}
          className={cn("text-muted-foreground", className)}
        >
          <Info aria-hidden />
        </Button>
      }
    >
      <StatusLegend />
    </TitlebarPopover>
  );
}
