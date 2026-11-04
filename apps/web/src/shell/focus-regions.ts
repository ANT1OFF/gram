import {
  drawnVirtualRow,
  scrollVirtualRow,
  virtualCurrent,
  virtualLists,
} from "@/lib/virtual-rows";
import { fitShell, useLayoutStore } from "@/stores/layout";
import { OVERVIEW_ROOT } from "@/views/shell-layout";

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** What marks a row of the overview sidebar as a stop for its arrow keys. */
export const OVERVIEW_STOP = "data-overview-stop";

/** The overview's stops that can take focus now: enabled, and not inside a folded section. */
export const overviewStops = (root: ParentNode): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(`[${OVERVIEW_STOP}]:not(:disabled)`)].filter(
    (stop) => stop.closest("[hidden]") === null,
  );

/** Focuses what `find` returns once it has rendered, trying for a few frames. */
async function focusWhenRendered(find: () => HTMLElement | null, frames = 10): Promise<boolean> {
  for (let frame = 0; frame < frames; frame++) {
    const target = find();
    if (target) {
      target.focus();
      return true;
    }
    await nextFrame();
  }
  return false;
}

/** The overview's current row (or tile), else its first; a hidden overview shows first. */
export function focusSidebar(): Promise<boolean> {
  const layout = useLayoutStore.getState();
  if (fitShell(layout).sidebar === "none") layout.toggleOverview();
  // The current row scrolled to and not drawn in time: the first stop, as before.
  let tries = 0;
  return focusWhenRendered(() => {
    // Open or compact: the compact rail's stops are its tiles.
    const overview = document.querySelector<HTMLElement>(`[${OVERVIEW_ROOT}]`);
    const stops = overview === null ? [] : overviewStops(overview);
    const current = stops.find((stop) => stop.getAttribute("aria-current") === "true");
    if (current !== undefined) return current;
    // A long list draws only the rows near the view: its current row is scrolled to, then found.
    const list =
      overview === null
        ? undefined
        : virtualLists(overview).find(
            (each) => virtualCurrent(each) !== -1 && each.closest("[hidden]") === null,
          );
    tries++;
    if (list !== undefined && drawnVirtualRow(list, virtualCurrent(list)) === null && tries < 9) {
      scrollVirtualRow(list, virtualCurrent(list));
      return null;
    }
    return stops[0] ?? null;
  });
}

/** The right panel's selected tab; a hidden panel opens first. */
export function focusPanel(): Promise<boolean> {
  const layout = useLayoutStore.getState();
  if (fitShell(layout).panel === "none") layout.togglePanel();
  return focusWhenRendered(() =>
    document.querySelector<HTMLElement>(
      '[data-testid="right-panel"] [role="tab"][aria-selected="true"]',
    ),
  );
}
