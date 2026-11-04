import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { useSyncExternalStore, type SyntheticEvent } from "react";

import { DrawnCheck, useMotionLevel } from "@/motion";

/**
 * Which setting a save belongs to, so it can say "Saved" beside itself. A row marks itself touched
 * when its control is clicked, typed in or changed, including a menu it opens elsewhere, since
 * React events reach the row through a portal; a save asked for soon after belongs to the row
 * touched last. Taken at the moment the save is asked for, so a field that saves as it loses focus
 * to another row's click is still the one that says so: that click lands after the save starts.
 */
let touched: { row: string; at: number } | undefined;

/** How long after a touch a save still counts as that row's. */
const TOUCH_WINDOW_MS = 5000;

/** How long "Saved" stays. */
export const SAVED_SHOW_MS = 1600;

let saved: { row: string; seq: number } | undefined;
let seq = 0;
const listeners = new Set<() => void>();

/** Marks `row` as the one the next save belongs to. */
export function touchRow(row: string): void {
  touched = { row, at: Date.now() };
}

/**
 * The row a save asked for now belongs to, if one was touched recently; call it as the save starts,
 * then `markSaved` with what it returns once the save succeeds.
 */
export function claimTouchedRow(): string | undefined {
  const row =
    touched !== undefined && Date.now() - touched.at < TOUCH_WINDOW_MS ? touched.row : undefined;
  touched = undefined;
  return row;
}

const notify = () => {
  for (const listener of listeners) listener();
};

/** Says "Saved" beside `row` for `SAVED_SHOW_MS`; nothing for a save no row asked for. */
export function markSaved(row: string | undefined): void {
  if (row === undefined) return;
  const mine = ++seq;
  saved = { row, seq: mine };
  notify();
  setTimeout(() => {
    // A later save, here or on another row, has taken over the mark and its own timer.
    if (saved?.seq !== mine) return;
    saved = undefined;
    notify();
  }, SAVED_SHOW_MS);
}

/** Says "Saved" beside the row last touched, for a setting stored on this computer at once. */
export function markTouchedSaved(): void {
  markSaved(claimTouchedRow());
}

/** Handlers for a row's element that mark it touched. */
export function touchHandlers(row: string) {
  const touch = (_event: SyntheticEvent) => touchRow(row);
  return {
    onClickCapture: touch,
    onInputCapture: touch,
    onChangeCapture: touch,
    onKeyDownCapture: touch,
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The save `row` shows "Saved" for, as a counter that rises with each one; none once it goes. */
function useSavedSeq(row: string): number | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (saved?.row === row ? saved.seq : undefined),
    () => undefined,
  );
}

/**
 * A brief ✓ Saved beside a setting whose change was just stored. The check draws itself under Full
 * motion, fades in under Reduced and simply shows under Off; it fades out the same way.
 */
export function SavedMark({ row }: { row: string }) {
  const shown = useSavedSeq(row);
  const level = useMotionLevel();
  const fade = level === "off" ? 0 : 0.2;
  return (
    <span aria-live="polite" className="inline-flex">
      <AnimatePresence initial={false}>
        {shown !== undefined && (
          <m.span
            key={shown}
            data-testid="setting-saved"
            className="inline-flex items-center gap-0.5 text-xs text-success-text"
            initial={{ opacity: level === "off" ? 1 : 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: fade }}
          >
            <DrawnCheck className="size-3.5" />
            Saved
          </m.span>
        )}
      </AnimatePresence>
    </span>
  );
}
