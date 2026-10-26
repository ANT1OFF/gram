import { ACTIVATABLE } from "@/keyboard/registry";

// The safe-key rules the ask stack and Quiet share: a plain key answers only while focus is on
// nothing that types or activates, and never in the wake of an answer or of a current ask that
// changed by itself. No React.

/** A key within this long of an answer, or of a new current ask, is taken as a slip, not an answer. */
export const SETTLE_MS = 300;
/** The clock those are measured on; read in handlers and effects only. */
export const clock = () => performance.now();

/** What types: its keys are its own. */
const TYPES = "input, textarea, select, [contenteditable=''], [contenteditable='true']";
/** What sits over the page and keeps its keys. */
const OVERLAYS = '[role="dialog"], [role="menu"], [role="listbox"]';

/**
 * Whether a plain key pressed with focus on `target` may answer for `area`: focus is on nothing, or
 * inside `area` on nothing that types, activates or sits over it.
 */
export const plainKeysReach = (target: Element | null, area: Element): boolean => {
  if (target === null || target === document.body) return true;
  if (!area.contains(target)) return false;
  return (
    target.closest(OVERLAYS) === null && !target.closest(TYPES) && !target.closest(ACTIVATABLE)
  );
};

/** Whether `target` sits in an overlay (a dialog, menu or listbox), which keeps every key. */
export const inOverlay = (target: Element): boolean => target.closest(OVERLAYS) !== null;
