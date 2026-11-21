import { useEffect, useState, type RefObject } from "react";

const OVERLAYS = [
  "[data-base-ui-portal] > *",
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[data-surface="overlay"]',
].join(", ");

const TOOLTIP = '[data-slot="tooltip-content"]';

const RECHECK_MS = 250;

interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

const overlaps = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

function coveredByOverlay(own: Element, root: ParentNode = document): boolean {
  const box = own.getBoundingClientRect();
  for (const element of root.querySelectorAll(OVERLAYS)) {
    if (own.contains(element)) continue;
    if (element.matches(TOOLTIP) || element.querySelector(TOOLTIP) !== null) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && overlaps(box, rect)) return true;
  }
  return false;
}

/**
 * Whether an overlay covers `ref`'s element now. Popups mount in portals at the end of `body`, so
 * a change there is what to look for, and while one overlaps it is looked at again until it's gone.
 */
export function useCoveredByOverlay(ref: RefObject<HTMLElement | null>): boolean {
  const [covered, setCovered] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      const own = ref.current;
      const now = own !== null && coveredByOverlay(own);
      setCovered(now);
      if (now) timer = setTimeout(check, RECHECK_MS);
    };
    const observer = new MutationObserver(() => requestAnimationFrame(check));
    observer.observe(document.body, { childList: true });
    check();
    return () => {
      observer.disconnect();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [ref]);
  return covered;
}
