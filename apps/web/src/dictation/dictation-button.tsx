import { Mic, MicOff } from "lucide-react";

import { ROUND } from "@/composer/styles";
import { withHint } from "@/keyboard/use-shortcut-hint";
import { cn } from "@/lib/utils";
import { LevelBars, Spinner, Swap } from "@/motion";
import { Hint } from "@/components/hint";

import type { DictationState } from "./session";

/** Muted like the toolbar's other glyphs until hovered. */
const IDLE = "text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";
/** Listening: the glyph and a faint tint in the danger tone, the way a recording light reads. */
const LIVE =
  "bg-destructive-tint text-destructive transition-colors hover:bg-destructive-tint-hover";
/** Couldn't start: the glyph crossed out in the warning tone, until the next try. */
const FAILED = "text-warning transition-colors hover:bg-accent";

/** What the button and the composer's status line say about a dictation. */
const dictationLabel = (state: DictationState): string => {
  switch (state.phase) {
    case "idle":
      return "Start dictation";
    case "starting":
      return "Starting dictation…";
    case "listening":
      return "Stop dictation";
    case "stopping":
      return "Finishing dictation…";
    case "error":
      return `Dictation stopped: ${state.message}`;
  }
};

/**
 * The composer's mic: a toggle whose state shows as its glyph and tone, never colour alone, and as
 * its label. While it listens the mic gives way to bars that follow your voice. The spinner and the
 * bars move on the app's shared clock, which the motion setting stills.
 */
export function DictationButton({
  state,
  hint,
  level,
  onToggle,
}: {
  state: DictationState;
  /** How loud the microphone is now, 0–1, for the bars that stand for the mic while it listens. */
  level: () => number;
  /** The shortcut, as `useShortcutHint` shows it; empty when it's turned off. */
  hint: string;
  onToggle: () => void;
}) {
  const live = state.phase === "listening" || state.phase === "stopping";
  const busy = state.phase === "starting" || state.phase === "stopping";
  const label = dictationLabel(state);
  return (
    <Hint
      label={withHint(
        state.phase === "error" ? "Start dictation" : label,
        hint === "" ? "" : `${hint}, or hold it to talk`,
      )}
      render={
        <button
          type="button"
          aria-label={state.phase === "error" ? "Start dictation" : label}
          aria-pressed={live || state.phase === "starting"}
          data-testid="dictation-button"
          data-state={state.phase}
          className={cn(ROUND, live ? LIVE : state.phase === "error" ? FAILED : IDLE)}
          onClick={onToggle}
        />
      }
    >
      <Swap
        swapKey={
          state.phase === "error" || state.phase === "listening"
            ? state.phase
            : busy
              ? "busy"
              : "mic"
        }
      >
        {state.phase === "error" ? (
          <MicOff aria-hidden className="size-4" />
        ) : busy ? (
          <Spinner aria-hidden className="size-4" />
        ) : state.phase === "listening" ? (
          <LevelBars level={level} />
        ) : (
          <Mic aria-hidden className="size-4" />
        )}
      </Swap>
    </Hint>
  );
}
