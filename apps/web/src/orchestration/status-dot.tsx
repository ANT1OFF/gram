import { cn } from "@/lib/utils";

import { TONE_DOT } from "./rail-model";
import { STATUS_WORDS, type DotState } from "./status-words";

// One dot per state, the same in the sidebar, on the Board and in Workers, and few of them: amber
// needs you, the accent runs (and pulses), a hollow accent ring waits on something outside it
// (checks, a review, a wake, a usage limit), grey has stopped, red failed, and the merged colour is
// done. The row beside a dot says its state in words, and the dot's own hover says what its colour
// and fill mean, so the marks teach themselves without a legend (DESIGN.md).

export type { DotState };

/** Each state's dot, and its word (`STATUS_WORDS`), the one every surface says. */
export const STATUS_DOTS: Readonly<
  Record<DotState, { readonly dot: string; readonly label: string; readonly meaning: string }>
> = {
  needs: {
    dot: TONE_DOT.needs,
    label: STATUS_WORDS.needs,
    meaning: "Amber: needs you, an approval, a question or an ask",
  },
  working: { dot: TONE_DOT.working, label: STATUS_WORDS.working, meaning: "Filled: running" },
  waiting: {
    dot: TONE_DOT.waiting,
    label: STATUS_WORDS.waiting,
    meaning: "Hollow: waiting on checks, a review, a wake or a limit",
  },
  attention: { dot: TONE_DOT.attention, label: STATUS_WORDS.attention, meaning: "Grey: stopped" },
  error: { dot: TONE_DOT.error, label: STATUS_WORDS.error, meaning: "Red: failed" },
  idle: { dot: TONE_DOT.idle, label: STATUS_WORDS.idle, meaning: "Grey: stopped" },
  merged: { dot: TONE_DOT.merged, label: STATUS_WORDS.merged, meaning: "Purple: done" },
  done: { dot: TONE_DOT.merged, label: STATUS_WORDS.done, meaning: "Purple: done" },
  archived: { dot: TONE_DOT.merged, label: STATUS_WORDS.archived, meaning: "Purple: done" },
  held: {
    dot: TONE_DOT.waiting,
    label: STATUS_WORDS.held,
    meaning: "Hollow: waiting on checks, a review, a wake or a limit",
  },
};

/**
 * A state's 8 px dot. `working` pulses unless `still`. Decorative: the row it sits on says the state
 * in words, so it is hidden from a screen reader unless `label` is given. Its hover says what the
 * dot means, so a pointer finds the vocabulary where the dot is.
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
      title={STATUS_DOTS[state].meaning}
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
