import { useLayoutEffect, useState } from "react";

/** The thread view a pane shows, whose height is the pane's. */
const PANE_ROOT = "[data-pane-root]";

/**
 * Keeps `--pane-height` on the view at its height, for what sits above the composer and must stay a
 * share of the pane: a grid row can be far shorter than any cap in `vh`.
 */
export const trackPaneHeight = (el: HTMLDivElement | null) => {
  if (el === null || typeof ResizeObserver === "undefined") return;
  const resize = new ResizeObserver(([entry]) => {
    if (entry) el.style.setProperty("--pane-height", `${entry.contentRect.height}px`);
  });
  resize.observe(el);
  return () => resize.disconnect();
};

/**
 * Whether `content` is taller than `share` of the pane it sits in, kept up to date as either one
 * resizes. Measured before paint, so a card that has to fold never shows unfolded first; false
 * until both have a height.
 */
export function useTallerThanPaneShare(content: HTMLElement | null, share: number): boolean {
  const [taller, setTaller] = useState(false);
  useLayoutEffect(() => {
    const pane = content?.closest<HTMLElement>(PANE_ROOT);
    if (!content || !pane) return;
    const measure = () => {
      const height = pane.clientHeight;
      setTaller(height > 0 && content.offsetHeight > height * share);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const resize = new ResizeObserver(measure);
    resize.observe(pane);
    resize.observe(content);
    return () => resize.disconnect();
  }, [content, share]);
  return taller;
}
