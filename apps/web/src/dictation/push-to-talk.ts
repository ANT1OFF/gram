import { isMac, keysFromEvent, parseKeys } from "@/keyboard/registry";

/**
 * The dictation shortcut's two ways in one chord: a tap toggles, as it always did, and a hold past
 * `HOLD_MS` talks until the keys come up. No DOM, so the keys' order is tested without a keyboard:
 * `composer-dictation.tsx` feeds it the shortcut's presses, the chord's key-ups and the window's
 * blur.
 */

/** How long the chord is down before its release stops what it started: shorter is a tap. */
export const HOLD_MS = 300;

export interface PushToTalkDeps {
  readonly now: () => number;
  /** Starting, listening or finishing. */
  readonly active: () => boolean;
  /** Starts dictation, or stops it when active. */
  readonly toggle: () => void;
  /** Stops listening, keeping what was heard. */
  readonly stop: () => void;
}

export interface PushToTalk {
  /** The shortcut pressed; `repeat` is the OS's key repeat while it's held, which does nothing. */
  press(repeat: boolean): void;
  /** One of the chord's keys came up. */
  release(): void;
  /** The window lost the focus with the chord down, so its key-ups won't come here. */
  blur(): void;
  /** Escape discarded what was heard: the press ends without a stop. */
  reset(): void;
  /** Whether the chord is down, for the caller to listen for its release. */
  held(): boolean;
}

export function createPushToTalk(deps: PushToTalkDeps): PushToTalk {
  /** The press under way, and whether it started dictation (a press that stopped it can't hold). */
  let down: { readonly at: number; readonly started: boolean } | undefined;

  const end = (heldLongEnough: (at: number) => boolean) => {
    if (down === undefined) return;
    const { at, started } = down;
    down = undefined;
    if (started && heldLongEnough(at) && deps.active()) deps.stop();
  };

  return {
    press: (repeat) => {
      if (repeat) return;
      // A press with one already down lost its key-up (macOS sends none for a key released while ⌘
      // is down): it starts afresh.
      down = { at: deps.now(), started: !deps.active() };
      deps.toggle();
    },
    release: () => end((at) => deps.now() - at >= HOLD_MS),
    blur: () => end(() => true),
    reset: () => {
      down = undefined;
    },
    held: () => down !== undefined,
  };
}

/** The chord modifier a key is: off macOS, Control is `mod` and `ctrl` alike, and ⌘ is neither. */
const modifierOf = (key: string, mac: boolean): "mod" | "ctrl" | "shift" | "alt" | undefined => {
  switch (key) {
    case "Meta":
      return mac ? "mod" : undefined;
    case "Control":
      return mac ? "ctrl" : "mod";
    case "Shift":
      return "shift";
    case "Alt":
      return "alt";
    default:
      return undefined;
  }
};

/**
 * Whether a key-up ends a hold of `keys`: the chord's own key, whatever else is held by then, or
 * any modifier it needs, whichever comes up first. On macOS the main key's never comes while ⌘ is
 * down, so ⌘'s is what ends it.
 */
export const releasesChord = (keys: string, event: KeyboardEvent, mac = isMac()): boolean => {
  const chord = parseKeys(keys);
  const modifier = modifierOf(event.key, mac);
  if (modifier === undefined) {
    // `=` means its shifted `+` too, as `matches` has it, and `+` has no keys string of its own.
    if (chord.key === "=") return event.key === "=" || event.key === "+";
    // The key alone, as though nothing else were held: Ctrl and Alt together read as AltGr.
    const bare = { key: event.key, code: event.code, ctrlKey: false, metaKey: false };
    const key = keysFromEvent({ ...bare, altKey: false, shiftKey: false } as KeyboardEvent, mac);
    return key === chord.key;
  }
  return modifier === "mod" && !mac ? chord.mod || chord.ctrl : chord[modifier];
};

/** How soon after a tap a second one locks dictation on, as a double-click would. */
export const DOUBLE_TAP_MS = 350;

export interface ModifierHoldDeps {
  readonly now: () => number;
  /** Starting, listening or finishing. */
  readonly active: () => boolean;
  /** Starts dictation, provisionally: it makes no sound until `confirm`. */
  readonly start: () => void;
  /** The press is a hold or a lock, not a tap or part of a shortcut. */
  readonly confirm: () => void;
  /** Stops listening, keeping what was heard. */
  readonly stop: () => void;
  /** Stops and throws away what was heard, silently. */
  readonly cancel: () => void;
}

export interface ModifierHold {
  /** The modifier went down; `repeat` is the OS's key repeat, which does nothing. */
  down(repeat: boolean): void;
  /** The modifier came up. */
  up(): void;
  /** Any other key went down while it was held: a shortcut, not dictation. */
  other(): void;
  /** The window lost the focus, so the key-up won't come here. */
  blur(): void;
  /** Escape discarded what was heard. */
  reset(): void;
}

/**
 * Push-to-talk on one modifier held alone (Right ⌥, say), as Hex has it: dictation starts at the
 * press so nothing is missed, and the press then turns out to be one of these:
 *
 * - a hold of `HOLD_MS` or more, which talks until the key comes up;
 * - a tap, which throws away what it heard without a sound;
 * - part of a shortcut: another key went down before it came up, so that shortcut works as ever
 *   and dictation is thrown away;
 * - a second tap within `DOUBLE_TAP_MS` of a tap, which locks dictation on until the next press.
 *
 * A press while dictation runs (locked, or from the mic button) stops it.
 */
export function createModifierHold(deps: ModifierHoldDeps): ModifierHold {
  type State =
    | { readonly kind: "idle" }
    /** Held: `second` when it came soon after a tap, so a tap of it locks. */
    | { readonly kind: "holding"; readonly at: number; readonly second: boolean }
    /** Held, but this press stopped dictation or was part of a shortcut: its key-up does nothing. */
    | { readonly kind: "spent" }
    | { readonly kind: "locked" };
  let state: State = { kind: "idle" };
  let lastTap: number | undefined;
  /** Confirms a hold as soon as it's long enough, so its sound plays while the key is still down. */
  let holdTimer: ReturnType<typeof setTimeout> | undefined;

  const settle = (next: State) => {
    clearTimeout(holdTimer);
    holdTimer = undefined;
    state = next;
  };

  return {
    down: (repeat) => {
      if (repeat || state.kind === "holding" || state.kind === "spent") return;
      if (state.kind === "locked" || deps.active()) {
        settle({ kind: "spent" });
        deps.stop();
        return;
      }
      const at = deps.now();
      const second = lastTap !== undefined && at - lastTap <= DOUBLE_TAP_MS;
      lastTap = undefined;
      settle({ kind: "holding", at, second });
      deps.start();
      holdTimer = setTimeout(() => {
        holdTimer = undefined;
        if (state.kind === "holding" && deps.active()) deps.confirm();
      }, HOLD_MS);
    },
    up: () => {
      if (state.kind !== "holding") {
        if (state.kind === "spent") settle({ kind: "idle" });
        return;
      }
      const { at, second } = state;
      const held = deps.now() - at;
      if (held >= HOLD_MS) {
        settle({ kind: "idle" });
        if (deps.active()) deps.stop();
      } else if (second) {
        settle({ kind: "locked" });
        if (deps.active()) deps.confirm();
        else settle({ kind: "idle" });
      } else {
        settle({ kind: "idle" });
        lastTap = deps.now();
        deps.cancel();
      }
    },
    other: () => {
      lastTap = undefined;
      if (state.kind !== "holding") return;
      settle({ kind: "spent" });
      deps.cancel();
    },
    blur: () => {
      lastTap = undefined;
      if (state.kind !== "holding") {
        if (state.kind === "spent") settle({ kind: "idle" });
        return;
      }
      const long = deps.now() - state.at >= HOLD_MS;
      settle({ kind: "idle" });
      if (long && deps.active()) deps.stop();
      else deps.cancel();
    },
    reset: () => {
      lastTap = undefined;
      settle({ kind: "idle" });
    },
  };
}
