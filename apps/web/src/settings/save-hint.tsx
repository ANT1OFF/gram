import { useSyncExternalStore, type MouseEvent } from "react";

import { Button } from "@/components/ui/button";
import { KEY_CAP } from "@/keyboard/use-shortcut-hint";

/**
 * Beside a typed setting's name while its draft differs from what is saved: how to keep it and how
 * to drop it, "Enter to save · Esc to cancel", the keys as key caps. Leaving the field saves too;
 * the hint teaches the keys, and `DraftActions` beside the field does the same for a pointer. Once
 * saved, the row's "Saved" mark and its Undo take its place.
 */
export function SaveHint({ id }: { id: string }) {
  return (
    <span
      id={id}
      data-testid="setting-unsaved"
      className="flex items-center gap-1 text-meta whitespace-nowrap text-muted-foreground"
    >
      <kbd className={KEY_CAP}>Enter</kbd> to save · <kbd className={KEY_CAP}>Esc</kbd> to cancel
    </span>
  );
}

/** Keeps focus in the field, so the button's click, not the field's blur, decides what happens. */
const keepFocus = (event: MouseEvent) => event.preventDefault();

/**
 * Save and Cancel beside a typed setting's field while its draft differs from what is saved, the
 * pointer's Enter and Esc: Save keeps the draft, Cancel puts the saved value back.
 */
export function DraftActions({
  label,
  onSave,
  onCancel,
}: {
  /**
   * The setting's name, kept as data: an accessible name holding it would make the field's label
   * name the buttons too. They sit right after the field, which names them by place.
   */
  label: string;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <span
      data-testid="setting-draft-actions"
      data-setting-draft={label}
      className="flex shrink-0 items-center gap-1"
    >
      <Button size="sm" variant="outline" onMouseDown={keepFocus} onClick={onSave}>
        Save
      </Button>
      <Button size="sm" variant="ghost" onMouseDown={keepFocus} onClick={onCancel}>
        Cancel
      </Button>
    </span>
  );
}

/** How long a typed setting's Undo stays after its save. */
export const UNDO_SHOW_MS = 8000;

/**
 * The last typed setting saved and how to put its old value back. One at a time, like "Saved": a
 * save elsewhere takes it over. Kept outside the field, since a field keyed by its saved value
 * remounts as the save lands.
 */
let pending: { key: string; seq: number; restore: () => void } | undefined;
let seq = 0;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

/**
 * Offers Undo beside the setting `key` for `UNDO_SHOW_MS`; `restore` saves the value it had before.
 * Call it as a typed draft is saved, and only when the value changes.
 */
export function offerUndo(key: string, restore: () => void): void {
  const mine = ++seq;
  pending = { key, seq: mine, restore };
  notify();
  setTimeout(() => {
    if (pending?.seq !== mine) return;
    pending = undefined;
    notify();
  }, UNDO_SHOW_MS);
}

/** Withdraws the Undo beside `key`, as its field is typed in again. */
export function dropUndo(key: string): void {
  if (pending?.key !== key) return;
  pending = undefined;
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * "Undo" beside a typed setting just saved, for `UNDO_SHOW_MS` or until the field is typed in again:
 * it saves the value the setting had before, which says "Saved" in turn.
 */
export function UndoSave({ undoKey }: { undoKey: string }) {
  const shown = useSyncExternalStore(
    subscribe,
    () => (pending?.key === undoKey ? pending : undefined),
    () => undefined,
  );
  if (shown === undefined) return null;
  return (
    <Button
      size="xs"
      variant="ghost"
      data-testid="setting-undo"
      className="text-muted-foreground hover:text-foreground"
      // Keeps focus where it is: a field the click would blur saves its draft.
      onMouseDown={keepFocus}
      onClick={() => {
        if (pending?.seq !== shown.seq) return;
        pending = undefined;
        notify();
        shown.restore();
      }}
    >
      Undo
    </Button>
  );
}
