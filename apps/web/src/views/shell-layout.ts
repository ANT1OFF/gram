import { focusLost } from "@/lib/use-return-focus";
import { gridShown, paneComposerNow } from "@/shell/pane-focus";
import { useLayoutStore } from "@/stores/layout";

/** What marks the overview, open or compact, for the focus to be found in it. */
export const OVERVIEW_ROOT = "data-overview";

/**
 * ⌘B: hides or shows the overview. Hidden with the focus in it, the overview hands the focus to the
 * focused pane's composer, or on a page with no panes to the title bar's button that shows it again.
 */
export const toggleOverviewSidebar = (): void => {
  const inside = focusInOverview();
  useLayoutStore.getState().toggleOverview();
  const after = useLayoutStore.getState();
  if (!inside || after.overviewSidebar !== "hidden") return;
  handFocusOn();
};

/** What marks a compact tile's flyout, which is portalled out of the overview to the page's end. */
export const OVERVIEW_FLYOUT = "data-overview-flyout";

/** Whether an element is in the overview, open or compact, or in one of its tiles' flyouts. */
export const inOverview = (element: Element | null | undefined): boolean =>
  element?.closest(`[${OVERVIEW_ROOT}], [${OVERVIEW_FLYOUT}]`) != null;

/** Whether the focus is in the overview, open or compact, or in one of its tiles' flyouts. */
export const focusInOverview = (): boolean => inOverview(document.activeElement);

/**
 * Gives the focus the overview took with it to the focused pane's composer, or with no panes to the
 * title bar's Show sidebar. Just after a navigation the URL has changed before the new page has
 * replaced the panes, so for a few frames a target that leaves the page with the focus on it is
 * replaced. Once the focus is anywhere else (the target kept it, or the person moved it on), it
 * stays where it is.
 */
function handFocusOn(frames = 10, given?: HTMLElement): void {
  requestAnimationFrame(() => {
    if (given?.isConnected) {
      // Still on what it was handed: keep watching, in case the page takes that away. Moved on: done.
      if (document.activeElement === given && frames > 1) handFocusOn(frames - 1, given);
      return;
    }
    if (!focusLost()) return;
    const target = gridShown()
      ? paneComposerNow(useLayoutStore.getState().grid.focused)
      : document.querySelector<HTMLElement>('[data-testid="overview-show"]');
    target?.focus();
    const took = target !== null && document.activeElement === target ? target : undefined;
    if (frames > 1) handFocusOn(frames - 1, took);
  });
}
