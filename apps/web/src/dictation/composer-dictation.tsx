import type { ThreadId } from "@gram/contracts";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
  type RefObject,
} from "react";

import { typeIntoField } from "@/composer/ghost";
import { GHOST_MIRROR } from "@/composer/styles";
import { effectiveKeys } from "@/keyboard/bindings-store";
import { DICTATE_KEYS } from "@/keyboard/catalog";
import { useShortcut } from "@/keyboard/registry";
import { cn } from "@/lib/utils";

import { promoteHoldTarget, registerHoldTarget, resetHold, type HoldTarget } from "./hold-key";
import { createPushToTalk, releasesChord, type PushToTalk } from "./push-to-talk";
import { spacedAfter, type DictationState } from "./session";
import { useDictation, type DictationControls } from "./use-dictation";

/**
 * Dictation as every composer has it, the thread's and the `/new` drafts' alike: the shortcut, the
 * utterance typed in at the caret, Escape to discard, typing to stop, and the partial drawn where
 * it will land. Nothing here knows a thread: a draft without one dictates the same way.
 */

export interface ComposerDictation extends DictationControls {
  /** For the field's `onChange`: typing while dictating keeps what was heard and stops listening. */
  typed(): void;
  /** For the composer's `onKeyDownCapture`: Escape discards what was heard, from anywhere in it. */
  onKeyDownCapture(event: KeyboardEvent): void;
}

/**
 * Dictation into the text area at `fieldRef`, whose value is `text`. Never sends. A chord shortcut
 * toggles on a tap and talks while held; one modifier held alone talks from anywhere in the window
 * (`push-to-talk.ts`, `hold-key.ts`).
 */
export function useComposerDictation({
  fieldRef,
  text,
  setText,
  insertingRef,
  enabled,
  threadId,
}: {
  fieldRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  setText: (value: string) => void;
  /** Set while an insertion of ours is under way, which `onChange` mustn't take for typing. */
  insertingRef: RefObject<boolean>;
  /** Whether the shortcut answers here: the composer's pane has the focus. */
  enabled: boolean;
  /** The thread whose project's names dictation spells; a draft without one has only the user's. */
  threadId?: ThreadId | undefined;
}): ComposerDictation {
  const dictation = useDictation((spoken) => {
    const field = fieldRef.current;
    const before = field === null ? text : field.value.slice(0, field.selectionStart);
    const insert = spacedAfter(before, spoken);
    insertingRef.current = true;
    try {
      if (field === null || !typeIntoField(field, insert)) setText(text + insert);
    } finally {
      insertingRef.current = false;
    }
  }, threadId);
  const latest = useRef(dictation);
  useEffect(() => {
    latest.current = dictation;
  });
  const machine = useRef<PushToTalk | undefined>(undefined);
  const talk = () =>
    (machine.current ??= createPushToTalk({
      now: () => performance.now(),
      active: () => latest.current.active,
      toggle: () => latest.current.toggle(),
      stop: () => latest.current.stop(),
    }));
  const enabledNow = useRef(enabled);
  useEffect(() => {
    enabledNow.current = enabled;
  });
  const target = useRef<HoldTarget | undefined>(undefined);
  useEffect(() => {
    const registered: HoldTarget = {
      focused: () => enabledNow.current,
      available: () => latest.current.available,
      active: () => latest.current.active,
      focus: () => fieldRef.current?.focus(),
      start: () => latest.current.startProvisionally(),
      confirm: () => latest.current.confirm(),
      stop: () => latest.current.stop(),
      cancel: () => latest.current.cancel(),
    };
    target.current = registered;
    return registerHoldTarget(registered);
  }, [fieldRef]);
  useEffect(() => {
    if (enabled && target.current !== undefined) promoteHoldTarget(target.current);
  }, [enabled]);
  const unlisten = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => unlisten.current?.(), []);
  const hold = () => {
    unlisten.current?.();
    if (!talk().held()) return;
    const keys = effectiveKeys("composer.dictate", DICTATE_KEYS) ?? DICTATE_KEYS;
    const onKeyUp = (event: globalThis.KeyboardEvent) => {
      if (!releasesChord(keys, event)) return;
      done();
      talk().release();
    };
    const onBlur = () => {
      done();
      talk().blur();
    };
    const done = () => {
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      unlisten.current = undefined;
    };
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    unlisten.current = done;
  };
  useShortcut(
    {
      id: "composer.dictate",
      keys: DICTATE_KEYS,
      label: "Dictate: hold to talk",
      group: "Composer",
      run: (event) => {
        talk().press(event.repeat);
        if (!event.repeat) hold();
      },
    },
    enabled && dictation.available,
  );
  const cancel = () => {
    talk().reset();
    resetHold();
    unlisten.current?.();
    dictation.cancel();
  };
  return {
    ...dictation,
    cancel,
    typed: () => {
      if (!insertingRef.current && dictation.active) dictation.stop();
    },
    onKeyDownCapture: (event) => {
      if (event.key !== "Escape" || (!dictation.active && dictation.state.phase !== "error"))
        return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    },
  };
}

/** Whether the caret sits at the end of the field, where a partial can show inline. */
export function useCaretAtEnd(): readonly [boolean, (field: HTMLTextAreaElement) => void] {
  const [atEnd, setAtEnd] = useState(true);
  const track = (field: HTMLTextAreaElement) =>
    setAtEnd(
      field.selectionStart === field.selectionEnd && field.selectionEnd === field.value.length,
    );
  return [atEnd, track];
}

/**
 * Grows the field to hold the mirror laid over it while `rest` shows there, never past the field's
 * own cap; true when even that doesn't fit, for the caller to show it elsewhere. Measured afresh
 * each time, the field back at its own height first, so a shorter `rest` shrinks it.
 */
export function useMirrorFit(
  fieldRef: RefObject<HTMLTextAreaElement | null>,
  mirrorRef: RefObject<HTMLDivElement | null>,
  rest: string | undefined,
  ...deps: readonly unknown[]
): boolean {
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (field === null) return;
    field.style.minHeight = "";
    const mirror = mirrorRef.current;
    if (mirror === null || rest === undefined) return setOverflows(false);
    const cap = Number.parseFloat(getComputedStyle(field).maxHeight);
    const wanted = mirror.scrollHeight;
    field.style.minHeight = `${Number.isFinite(cap) ? Math.min(wanted, cap) : wanted}px`;
    setOverflows(Number.isFinite(cap) && wanted > cap);
    // oxlint-disable-next-line react/exhaustive-deps -- see above
  }, [fieldRef, mirrorRef, rest, ...deps]);
  return overflows;
}

const DICTATION_PARTIAL =
  "text-muted-foreground underline decoration-muted-foreground/50 decoration-dotted underline-offset-4";

/**
 * What's heard and not yet committed, behind the field where it will land: shown, not in the
 * draft, until the speaker pauses or stops. `className` matches the field's padding.
 */
export function DictationMirror({
  ref,
  text,
  partial,
  className,
}: {
  ref: Ref<HTMLDivElement>;
  text: string;
  partial: string;
  className?: string | undefined;
}) {
  return (
    <div ref={ref} aria-hidden data-composer-mirror className={cn(GHOST_MIRROR, className)}>
      <span className="text-transparent">{text}</span>
      <span data-testid="dictation-partial" className={DICTATION_PARTIAL}>
        {spacedAfter(text, partial)}
      </span>
    </div>
  );
}

/**
 * The partial under the field, for when it can't show where it will land: the caret is mid-draft,
 * or the words run past the field's cap, where the mirror behind it can't scroll.
 */
export function DictationStrip({ partial }: { partial: string }) {
  return (
    <p
      aria-hidden
      data-testid="dictation-partial"
      className="truncate px-4 pb-1 text-left text-reading [direction:rtl]"
    >
      <span dir="ltr" className={DICTATION_PARTIAL}>
        {partial}
      </span>
    </p>
  );
}

/** A persistent, wrapping error next to the composer, until dictation is retried or cancelled. */
export function DictationError({ state }: { state: DictationState }) {
  if (state.phase !== "error") return null;
  return (
    <p role="alert" className="px-4 pb-2 text-meta text-warning-text">
      Dictation: {state.message}
    </p>
  );
}

/** A composer's status line while dictating, or after it stopped on an error. */
export const dictationStatus = (state: DictationState): string | undefined => {
  switch (state.phase) {
    case "idle":
      return undefined;
    case "starting":
      return "Starting dictation…";
    case "listening":
      return "Listening… Esc discards";
    case "stopping":
      return "Finishing…";
    case "error":
      return `Dictation: ${state.message}`;
  }
};
