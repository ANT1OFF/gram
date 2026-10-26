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
