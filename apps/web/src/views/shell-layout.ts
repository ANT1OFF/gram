import { focusLost } from "@/lib/use-return-focus";
import { gridShown, paneComposerNow } from "@/shell/pane-focus";
import { useLayoutStore } from "@/stores/layout";
import { navigationNow, useNavigationStore } from "@/stores/navigation";

/** What marks the overview, open or compact, for the focus to be found in it. */
export const OVERVIEW_ROOT = "data-overview";

/**
 * ⌘B: hides or shows the overview. Hidden with the focus in it, the overview hands the focus to the
 * focused pane's composer, or on a page with no panes to the title bar's button that shows it again.
 * An auto-hidden navigation slides into view or away instead, and the dock's Overview opens or closes.
 */
export const toggleOverviewSidebar = (): void => {
  const nav = navigationNow();
  const navigation = useNavigationStore.getState();
  if (nav.autoHide) {
    if (navigation.shown) navigation.hide();
    else navigation.setRevealed(true);
    return;
  }
  if (nav.position !== "side") {
    navigation.setSheet(!navigation.sheet);
    return;
  }
  const inside = focusInOverview();
  useLayoutStore.getState().toggleOverview();
  const after = useLayoutStore.getState();
  if (!inside || after.overviewSidebar !== "hidden") return;
  handFocusOn();
};

/** Whether an element is in the overview: open, compact, or open over the page beside the strip. */
export const inOverview = (element: Element | null | undefined): boolean =>
  element?.closest(`[${OVERVIEW_ROOT}]`) != null;

/** Whether the focus is in the overview: open, compact, or open over the page beside the strip. */
export const focusInOverview = (): boolean => inOverview(document.activeElement);

function handFocusOn(frames = 10, given?: HTMLElement): void {
  requestAnimationFrame(() => {
    if (given?.isConnected) {
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
