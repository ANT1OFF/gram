import { useEffect, useRef, useSyncExternalStore } from "react";

import { effectiveKeys, useBindingsStore } from "./bindings-store";

export type ShortcutGroup = "App" | "Navigation" | "Thread" | "Composer" | "Terminal";

export interface Shortcut {
  id: string;
  /** `mod` is ⌘ on macOS and Ctrl elsewhere, e.g. `mod+shift+u`, `alt+enter`, `escape`. */
  keys: string;
  label: string;
  group: ShortcutGroup;
  /** Skipped when this returns false; the next matching shortcut gets a chance. */
  when?: () => boolean;
  /**
   * The area this shortcut belongs to, true while it holds focus (e.g. a terminal). A scoped
   * shortcut runs before unscoped ones whatever the registration order, and never outside its scope.
   */
  focusScope?: () => boolean;
  /** Also fire while typing in an input. Shortcuts with `mod` always do. */
  allowInInputs?: boolean;
  /** Never fire while typing in an input, even with `mod`; the next matching shortcut may. */
  skipWhileTyping?: boolean;
  /** Also fire while focus is inside a dialog; the rest wait until it closes, so nothing acts behind it. */
  allowInDialogs?: boolean;
  /** Hide from the shortcut overlay (e.g. duplicates of a documented binding). */
  hidden?: boolean;
  run: (event: KeyboardEvent) => void;
}

export const isMac = () =>
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

interface Chord {
  mod: boolean;
  /** The Control key on every platform; off macOS it's the same key as `mod`. */
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  return: "enter",
  up: "arrowup",
  down: "arrowdown",
};

export function parseKeys(keys: string): Chord {
  const parts = keys.toLowerCase().split("+");
  const key = parts.pop()!;
  return {
    mod: parts.includes("mod"),
    ctrl: parts.includes("ctrl"),
    shift: parts.includes("shift"),
    alt: parts.includes("alt"),
    key: KEY_ALIASES[key] ?? key,
  };
}

/**
 * The zoom characters, which mean zoom wherever a layout puts them. They go by what was typed, ahead
 * of the physical-key rule below: a Nordic `-` sits on the key a US keyboard has `/` on, so by
 * position ⌘- opened the shortcuts overlay (⌘/) instead of zooming out.
 */
const TYPED_FIRST: ReadonlySet<string> = new Set(["-", "+", "="]);

/** Physical key for letters/digits/backslash/brackets (layout- and ⌥-independent), else `event.key`. */
function eventKey(event: KeyboardEvent): string {
  if (TYPED_FIRST.has(event.key)) return event.key;
  const { code } = event;
  if (code.startsWith("Key")) return code.slice(3).toLowerCase();
  if (code.startsWith("Digit")) return code.slice(5);
  if (code === "Backslash") return "\\";
  if (code === "BracketLeft") return "[";
  if (code === "BracketRight") return "]";
  if (code === "Slash") return "/";
  if (code === "Period") return ".";
  if (code === "Space") return "space";
  return event.key.toLowerCase();
}

/** A single character matched by what's typed rather than the physical key, e.g. `?`. */
const byCharacter = (key: string) => key.length === 1 && !/[a-z0-9\\/.[\]]/.test(key);

/**
 * Off macOS, AltGr arrives as Ctrl+Alt, so a press that typed anything but a letter or digit with it
 * (`[` from AltGr+8 on a Nordic layout, `{` from AltGr+B on a Hungarian one) is text, not a shortcut.
 * Ctrl+Alt with a punctuation key therefore can't be a shortcut off macOS.
 */
export const isAltGraphText = (event: KeyboardEvent, mac = isMac()): boolean =>
  !mac && event.ctrlKey && event.altKey && event.key.length === 1 && !/^[a-z0-9]$/i.test(event.key);

export function matches(keys: string, event: KeyboardEvent, mac = isMac()): boolean {
  if (isAltGraphText(event, mac)) return false;
  const chord = parseKeys(keys);
  // Off macOS, `mod` and `ctrl` are both the Control key.
  const wantMeta = mac && chord.mod;
  const wantCtrl = mac ? chord.ctrl : chord.mod || chord.ctrl;
  if (event.metaKey !== wantMeta || event.ctrlKey !== wantCtrl) return false;
  if (chord.alt !== event.altKey) return false;
  // `+` is `=`'s shifted twin on a US keyboard and a key of its own, with `=` somewhere awkward, on
  // a Nordic or German one. A binding on `=` is a zoom-in and means either, as in every browser;
  // `+` can't be bound itself, being what separates a chord's keys.
  if (chord.key === "=") return event.key === "=" || event.key === "+";
  // `?` and similar need shift to type; don't demand it be declared.
  if (byCharacter(chord.key)) return event.key === chord.key;
  if (chord.shift !== event.shiftKey) return false;
  return eventKey(event) === chord.key;
}

const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  "meta",
  "control",
  "alt",
  "altgraph",
  "shift",
  "capslock",
  "fn",
  "os",
]);

/**
 * The keys string a press stands for in this registry's terms, so `matches` holds for the press that
 * recorded it: physical keys for letters, digits and brackets, the typed character for keys like
 * `?`. `undefined` for a lone modifier, a key a keys string can't name (`+`, dead keys), AltGr
 * text, or the Windows key, which keys strings have no name for.
 */
export function keysFromEvent(event: KeyboardEvent, mac = isMac()): string | undefined {
  if (isAltGraphText(event, mac) || (!mac && event.metaKey)) return undefined;
  const key = eventKey(event);
  if (key === "" || key === "+" || key === "dead" || key === "unidentified") return undefined;
  if (MODIFIER_KEYS.has(key)) return undefined;
  const typed = byCharacter(key);
  return [
    (mac ? event.metaKey : event.ctrlKey) && "mod",
    mac && event.ctrlKey && "ctrl",
    event.altKey && "alt",
    !typed && event.shiftKey && "shift",
    typed ? event.key : key,
  ]
    .filter(Boolean)
    .join("+");
}

const GLYPHS: Record<string, string> = {
  space: "Space",
  enter: "⏎",
  escape: "⎋",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  backspace: "⌫",
  tab: "⇥",
};

/** Off macOS, keys are spelled out as Windows labels them. */
const WORDS: Record<string, string> = {
  enter: "Enter",
  escape: "Esc",
  backspace: "Backspace",
  tab: "Tab",
};

export function formatKeys(keys: string, mac = isMac()): string {
  const chord = parseKeys(keys);
  const key = (mac ? undefined : WORDS[chord.key]) ?? GLYPHS[chord.key] ?? chord.key.toUpperCase();
  if (mac) {
    return `${chord.ctrl ? "⌃" : ""}${chord.mod ? "⌘" : ""}${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}${key}`;
  }
  return [(chord.mod || chord.ctrl) && "Ctrl", chord.alt && "Alt", chord.shift && "Shift", key]
    .filter(Boolean)
    .join("+");
}

// ---------------------------------------------------------------------------------------------

const registry: Shortcut[] = [];
const listeners = new Set<() => void>();
let snapshot: readonly Shortcut[] = [];

// The snapshot shows effective keys; a shortcut the user turned off is hidden.
const publish = () => {
  snapshot = registry.map((shortcut) => {
    const keys = effectiveKeys(shortcut.id, shortcut.keys);
    if (keys === shortcut.keys) return shortcut;
    return keys === undefined ? { ...shortcut, hidden: true } : { ...shortcut, keys };
  });
  for (const listener of listeners) listener();
};

useBindingsStore.subscribe(publish);

/** Registers a shortcut; later registrations take precedence. Returns an unregister function. */
export function registerShortcut(shortcut: Shortcut): () => void {
  registry.push(shortcut);
  publish();
  return () => {
    const index = registry.indexOf(shortcut);
    if (index !== -1) registry.splice(index, 1);
    publish();
  };
}

/**
 * Runs the latest shortcut registered as `id` whose `when` allows it, as pressing its keys would;
 * the slash menu's `/model` opens the model picker this way. Returns whether one ran.
 */
export function runShortcut(id: string): boolean {
  for (let i = registry.length - 1; i >= 0; i--) {
    const shortcut = registry[i]!;
    if (shortcut.id !== id || (shortcut.when && !shortcut.when())) continue;
    shortcut.run(new KeyboardEvent("keydown"));
    return true;
  }
  return false;
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/** What Enter already activates when it has focus. */
export const ACTIVATABLE =
  "button, a[href], summary, [role='button'], [role='link'], [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [role='option'], [role='tab'], [role='treeitem'], [role='checkbox'], [role='radio'], [role='switch']";

const isActivatable = (target: EventTarget | null) =>
  target instanceof HTMLElement && target.matches(ACTIVATABLE);

/**
 * Runs the most recently registered matching shortcut, preferring one scoped to the area holding
 * focus. Returns whether one ran. A plain Enter on a focused button, link or widget belongs to that
 * element, so a pending approval's Enter doesn't take it (and approve) from a search result or a
 * dialog button.
 */
export function dispatchShortcut(event: KeyboardEvent, mac = isMac()): boolean {
  // While an IME is composing, every key belongs to it: Enter accepts a candidate, and a chord on
  // it (⌘Enter to send) would post half a word. `keyCode` 229 covers the browsers that report the
  // key before `isComposing` is set.
  if (event.isComposing || event.keyCode === 229) return false;
  const typing = isTyping(event.target);
  const activating = event.key === "Enter" && isActivatable(event.target);
  const dialog =
    event.target instanceof Element
      ? event.target.closest("[role='dialog'], [role='alertdialog']")
      : null;
  // A dialog on its way out still holds focus during its exit transition, but no longer the keys.
  const inDialog =
    dialog !== null &&
    !dialog.hasAttribute("data-closed") &&
    !dialog.hasAttribute("data-ending-style");
  for (const scoped of [true, false]) {
    for (let i = registry.length - 1; i >= 0; i--) {
      const shortcut = registry[i]!;
      if ((shortcut.focusScope !== undefined) !== scoped) continue;
      const keys = effectiveKeys(shortcut.id, shortcut.keys);
      if (keys === undefined || !matches(keys, event, mac)) continue;
      if (inDialog && !shortcut.allowInDialogs) continue;
      if (typing && !shortcut.allowInInputs && !parseKeys(keys).mod) continue;
      if (typing && shortcut.skipWhileTyping) continue;
      if (activating && !parseKeys(keys).mod) continue;
      if (shortcut.focusScope && !shortcut.focusScope()) continue;
      if (shortcut.when && !shortcut.when()) continue;
      event.preventDefault();
      shortcut.run(event);
      return true;
    }
  }
  return false;
}

const onKeyDown = (event: KeyboardEvent) => {
  if (!event.defaultPrevented) dispatchShortcut(event);
};

export function installKeyboard(target: Window = window): () => void {
  target.addEventListener("keydown", onKeyDown);
  return () => target.removeEventListener("keydown", onKeyDown);
}

/** Registers `shortcut` for the component's lifetime; `run`/`when` always see the latest props. */
export function useShortcut(shortcut: Shortcut, enabled = true) {
  const latest = useRef(shortcut);
  useEffect(() => {
    latest.current = shortcut;
  });
  const { id, keys, label, group, allowInInputs, skipWhileTyping, allowInDialogs, hidden } =
    shortcut;
  const scoped = shortcut.focusScope !== undefined;
  useEffect(() => {
    if (!enabled) return;
    return registerShortcut({
      id,
      keys,
      label,
      group,
      ...(allowInInputs !== undefined ? { allowInInputs } : {}),
      ...(skipWhileTyping !== undefined ? { skipWhileTyping } : {}),
      ...(allowInDialogs !== undefined ? { allowInDialogs } : {}),
      ...(hidden !== undefined ? { hidden } : {}),
      ...(scoped ? { focusScope: () => latest.current.focusScope?.() ?? false } : {}),
      when: () => latest.current.when?.() ?? true,
      run: (event) => latest.current.run(event),
    });
  }, [
    id,
    keys,
    label,
    group,
    allowInInputs,
    skipWhileTyping,
    allowInDialogs,
    hidden,
    scoped,
    enabled,
  ]);
}

/** Registered shortcuts, de-duplicated by id, for the overlay. */
export function useShortcutList(): readonly Shortcut[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => snapshot,
  );
}
