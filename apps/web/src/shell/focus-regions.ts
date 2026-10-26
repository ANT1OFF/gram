import {
  drawnVirtualRow,
  scrollVirtualRow,
  virtualCurrent,
  virtualLists,
} from "@/lib/virtual-rows";
import { fitShell, overviewFoldKey, useLayoutStore } from "@/stores/layout";
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

/**
 * ⌘J with the overview open: the focus goes to its first worker row, the Orchestrators section
 * and its orchestrator opening first if folded. False, touching nothing, where the overview isn't open (hidden or
 * compact) or no worker row shows, so ⌘J opens the Workers list instead.
 */
export async function focusOverviewWorkers(): Promise<boolean> {
  const layout = useLayoutStore.getState();
  if (layout.overviewSidebar === "compact") return false;
  const fit = fitShell(layout);
  const overview = document.querySelector<HTMLElement>('[data-testid="overview-sidebar"]');
  if (fit.sidebar !== "full" || overview === null) return false;
  // The workspace the window is on first, else the first open one with a worker.
  const worker =
    overview.querySelector<HTMLElement>(
      '[data-testid="overview-workspace"]:has([aria-current]) [data-testid="overview-worker"]',
    ) ?? overview.querySelector<HTMLElement>('[data-testid="overview-worker"]');
  // Nothing to jump to: no workers now.
  if (worker === null) return false;
  const home = worker.closest<HTMLElement>("[data-workspace-id]");
  const first = () =>
    overviewStops(overview).find(
      (stop) => stop.dataset["testid"] === "overview-worker" && (home?.contains(stop) ?? true),
    ) ?? null;
  layout.unfoldOverviewSection("orchestrators");
  // Its orchestrator unfolds too, when its workers were folded under it.
  const workspaceId = home?.dataset["workspaceId"];
  if (workspaceId !== undefined) layout.toggleWorkspaceNode(overviewFoldKey(workspaceId), false);
  return focusWhenRendered(first);
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
