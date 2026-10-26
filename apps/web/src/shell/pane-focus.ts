/** Whether the thread grid is on screen, rather than Settings, the new-thread draft or another page. */
export const gridShown = (): boolean => document.querySelector("[data-pane-index]") !== null;

/** Controls a pane without a composer can take focus on, e.g. an empty pane's thread picker. */
const FOCUSABLE =
  "button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * Moves real focus into pane `index` once it has rendered: its composer, else its first control.
 * Focus already inside the pane stays where it is, unless `always` asks for the composer anyway. The
 * layout store only records which pane counts as focused, so a pane shortcut or a closed pane
 * otherwise leaves the caret in another pane.
 */
export function focusPaneComposer(index: number, { always = false } = {}): void {
  requestAnimationFrame(() => {
    const pane = paneAt(index);
    if (!pane || (!always && pane.contains(document.activeElement))) return;
    paneFocusTarget(pane)?.focus();
  });
}

const paneAt = (index: number) =>
  document.querySelector<HTMLElement>(`[data-pane-index="${index}"]`);

const paneFocusTarget = (pane: HTMLElement): HTMLElement | null =>
  pane.querySelector<HTMLElement>('textarea[aria-label="Message"]') ??
  pane.querySelector<HTMLElement>(FOCUSABLE);

/** Where focus in pane `index` goes now (its composer, else its first control), if it is shown. */
export const paneComposerNow = (index: number): HTMLElement | null => {
  const pane = paneAt(index);
  return pane === null ? null : paneFocusTarget(pane);
};
