import { KEY_CAP } from "@/keyboard/use-shortcut-hint";

/**
 * Beside a typed setting's name while its draft differs from what is saved: how to keep it and how
 * to drop it, "Enter to save · Esc to cancel", the keys as key caps. Leaving the field saves too;
 * the hint teaches the keys. Once saved, the row's "Saved" mark takes its place.
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
