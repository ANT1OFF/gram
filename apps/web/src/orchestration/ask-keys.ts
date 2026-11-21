import { shortcutPressed } from "@/keyboard/bindings";
import { ACTIVATABLE } from "@/keyboard/registry";

import type { AskOption } from "./ask-model";

/** A key within this long of an answer, or of a new current ask, is taken as a slip, not an answer. */
export const SETTLE_MS = 300;
/** The clock those are measured on; read in handlers and effects only. */
export const clock = () => performance.now();

const FIELDS = "input, textarea, select, [role='textbox'], [role='searchbox']";
const OVERLAYS = '[role="dialog"], [role="menu"], [role="listbox"]';

/**
 * Whether a plain key pressed with focus on `target` may answer for `area`: focus is on nothing, or
 * inside `area` on nothing that types, activates or sits over it.
 */
export const plainKeysReach = (target: Element | null, area: Element): boolean => {
  if (target === null || target === document.body) return true;
  if (!area.contains(target)) return false;
  return target.closest(OVERLAYS) === null && !types(target) && !target.closest(ACTIVATABLE);
};

const editableByAttribute = (target: Element): boolean => {
  const host = target.closest("[contenteditable]");
  return host !== null && host.getAttribute("contenteditable")?.toLowerCase() !== "false";
};

/**
 * Whether `target` types, so its keys are its own: a field, an element with an ARIA textbox role,
 * or anything editable (`isContentEditable`, plaintext-only included), or inside one.
 */
export const types = (target: Element): boolean =>
  (target instanceof HTMLElement && target.isContentEditable) ||
  editableByAttribute(target) ||
  target.closest(FIELDS) !== null;

/** Whether `target` sits in an overlay (a dialog, menu or listbox), which keeps every key. */
export const inOverlay = (target: Element): boolean => target.closest(OVERLAYS) !== null;

/** What marks a choice that a number key picks, in order: `data-choice-index`. */
export const CHOICE = "[data-choice-index]";
/** What marks the button ⌘⏎ presses: the one Send answer of an answer form. */
export const SEND_ANSWER = "[data-send-answer]";

/**
 * The one answer rule, for a form drawn in `root` (the ask sheet, a question card): a number key
 * picks that choice, while focus is on nothing that types; ⌘⏎ (Ctrl+⏎) presses Send answer, from
 * anywhere in it. Returns whether the key was taken.
 */
export const answerKey = (
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing" | "defaultPrevented"
  > & { readonly target: EventTarget | null },
  root: Element,
): boolean => {
  if (event.defaultPrevented || event.isComposing) return false;
  const mod = event.metaKey || event.ctrlKey;
  if (mod && !event.altKey && !event.shiftKey && event.key === "Enter") {
    const send = root.querySelector<HTMLButtonElement>(SEND_ANSWER);
    if (send === null || send.disabled) return false;
    send.click();
    return true;
  }
  if (mod || event.altKey || event.shiftKey || !/^[1-9]$/.test(event.key)) return false;
  const target = event.target instanceof Element ? event.target : null;
  if (target !== null && types(target) && !target.matches(CHOICE)) return false;
  const choice = root.querySelectorAll<HTMLElement>(CHOICE)[Number(event.key) - 1];
  if (choice === undefined) return false;
  choice.click();
  choice.focus({ preventScroll: true });
  return true;
};

/**
 * The approval verb among `options` that `event` presses, by its shortcut (1 Allow once, 2 Always
 * allow this rule…, 3 Deny unless rebound), else -1. Its press acts, as on the thread's card.
 */
export const shortcutOptionAt = (
  options: readonly Pick<AskOption, "shortcut">[],
  event: KeyboardEvent,
): number =>
  options.findIndex(
    (option) => option.shortcut !== undefined && shortcutPressed(option.shortcut, event),
  );

/** Whether `options` are an approval's verbs, which their shortcuts answer rather than 1–9. */
export const keyedByShortcut = (options: readonly Pick<AskOption, "shortcut">[]): boolean =>
  options.some((option) => option.shortcut !== undefined);
