import { cn } from "@/lib/utils";

import { TONE_DOT, type RailTone } from "./rail-model";

// One dot per state, the same in the sidebar, on the Board and in Workers, and few of them: amber
// needs you, the accent runs (and pulses), a hollow accent ring waits on something outside it
// (checks, a review, a wake, a usage limit), grey has stopped, red failed, and the merged colour is
// done. The row beside a dot says its state in words, so no legend is needed (DESIGN.md).

/** Every state a dot can say: a worker's tone, a finished or archived worker, and a held brief. */
export type DotState = RailTone | "done" | "archived" | "held";

export const STATUS_DOTS: Readonly<
  Record<DotState, { readonly dot: string; readonly label: string }>
> = {
  needs: { dot: TONE_DOT.needs, label: "Needs you" },
  working: { dot: TONE_DOT.working, label: "Running" },
  waiting: { dot: TONE_DOT.waiting, label: "Waiting" },
  attention: { dot: TONE_DOT.attention, label: "Stopped" },
  error: { dot: TONE_DOT.error, label: "Failed" },
  idle: { dot: TONE_DOT.idle, label: "Stopped" },
  merged: { dot: TONE_DOT.merged, label: "Done" },
  done: { dot: TONE_DOT.merged, label: "Done" },
  archived: { dot: TONE_DOT.merged, label: "Done" },
  // Held until a limit resets, or by you: a wait like any other, its reason in words.
  held: { dot: TONE_DOT.waiting, label: "Waiting" },
};

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
