import { effectiveKeys } from "@/keyboard/bindings-store";
import { DICTATE_KEYS } from "@/keyboard/catalog";
import { loneModifierFromEvent } from "@/keyboard/registry";

import { createModifierHold, type ModifierHold } from "./push-to-talk";

/**
 * The dictation key when it is one modifier held alone: it answers anywhere in the window, not only
 * in a composer's pane, and dictates into the composer in use. One listener for the window,
 * whichever composers are mounted.
 */

/** A composer that can take dictation, as its `useComposerDictation` registers it. */
export interface HoldTarget {
  /** Its pane has the focus. */
  readonly focused: () => boolean;
  /** Voice input is on and this window reaches a speech process. */
  readonly available: () => boolean;
  readonly active: () => boolean;
  /** Puts the focus in its field, so the words land there and Escape reaches it. */
  readonly focus: () => void;
  readonly start: () => void;
  readonly confirm: () => void;
  readonly stop: () => void;
  readonly cancel: () => void;
}

/** Most recently used first. */
const targets: HoldTarget[] = [];
/** The target the press under way, or the lock, dictates into. */
let owner: HoldTarget | undefined;
let machine: ModifierHold | undefined;
let unlisten: (() => void) | undefined;

/** The composer whose pane has the focus, else the one last used. */
const current = (): HoldTarget | undefined =>
  targets.find((target) => target.focused() && target.available()) ??
  targets.find((target) => target.available());

const hold = (): ModifierHold =>
  (machine ??= createModifierHold({
    now: () => performance.now(),
    active: () => (owner ?? current())?.active() ?? false,
    start: () => {
      owner = current();
      owner?.focus();
      owner?.start();
    },
    confirm: () => owner?.confirm(),
    stop: () => {
      (owner ?? current())?.stop();
      owner = undefined;
    },
    cancel: () => {
      owner?.cancel();
      owner = undefined;
    },
  }));

/** The keys dictation is bound to, when they're one modifier held alone (`altright`). */
const boundModifier = (): string | undefined => {
  const keys = effectiveKeys("composer.dictate", DICTATE_KEYS);
  return keys !== undefined && loneModifierFromEvent({ code: keys }) !== undefined
    ? keys.toLowerCase()
    : undefined;
};

/** Settings and the key recorder hold the keys while they're open; nothing dictates behind them. */
const inDialog = (target: EventTarget | null) =>
  target instanceof Element && target.closest("[role='dialog'], [role='alertdialog']") !== null;

const onKeyDown = (event: KeyboardEvent) => {
  const bound = boundModifier();
  if (bound === undefined) return;
  if (loneModifierFromEvent(event) !== bound) return hold().other();
  if (!inDialog(event.target)) hold().down(event.repeat);
};
const onKeyUp = (event: KeyboardEvent) => {
  const bound = boundModifier();
  if (bound !== undefined && loneModifierFromEvent(event) === bound) hold().up();
};
const onBlur = () => hold().blur();

const listen = (): (() => void) => {
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", onBlur);
  return () => {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("blur", onBlur);
  };
};

/** Adds a composer for the key to dictate into; returns its removal. */
export function registerHoldTarget(target: HoldTarget): () => void {
  targets.push(target);
  unlisten ??= listen();
  return () => {
    const index = targets.indexOf(target);
    if (index !== -1) targets.splice(index, 1);
    if (owner === target) {
      owner = undefined;
      machine?.reset();
    }
    if (targets.length === 0) {
      unlisten?.();
      unlisten = undefined;
    }
  };
}

/** `target` is the one in use now, for when its pane gets the focus. */
export function promoteHoldTarget(target: HoldTarget): void {
  const index = targets.indexOf(target);
  if (index <= 0) return;
  targets.splice(index, 1);
  targets.unshift(target);
}

/** Escape discarded what was heard: a press or lock under way ends with it. */
export function resetHold(): void {
  owner = undefined;
  machine?.reset();
}
