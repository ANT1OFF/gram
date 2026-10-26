import { useLayoutEffect, useRef } from "react";

import { cn } from "@/lib/utils";

/**
 * How soon after the last move another counts as a held arrow key's repeat. A repeat jumps rather
 * than glides, so the highlight never trails the key: at about 30 moves a second a glide would never
 * arrive.
 */
export const REPEAT_MS = 100;

/** Whether a move `sinceLast` ms after the previous one glides; the first placement never does. */
export const glides = (sinceLast: number | undefined): boolean =>
  sinceLast !== undefined && sinceLast >= REPEAT_MS;

/** Where `target` sits and how big it is, in the list's own coordinates, as one comparable key. */
const geometryOf = (target: HTMLElement): string =>
  `${target.offsetLeft} ${target.offsetTop} ${target.offsetWidth} ${target.offsetHeight}`;

/** Puts the highlight exactly over `target`, in the list's own coordinates. */
const placeOver = (element: HTMLElement, target: HTMLElement) => {
  element.style.translate = `${target.offsetLeft}px ${target.offsetTop}px`;
  element.style.width = `${target.offsetWidth}px`;
  element.style.height = `${target.offsetHeight}px`;
};

/**
 * The active option's background in a floating list (the composer's slash and @ menus): one
 * element under the options that moves to the option `targetId` names, gliding there by transform
 * at Full motion, after animate-ui's highlight. A held key's repeats and a list that changes under
 * it jump, so what is highlighted is always where the key is. Reduced and Off jump always, since
 * the glide takes the motion-scaled duration. The list needs `relative` or another position, and
 * `isolate`, so the highlight sits under the options' text. `layout` names what is in the list, so
 * the highlight follows an option that moves when the list is filtered.
 */
export function ListHighlight({
  targetId,
  layout,
  className,
}: {
  targetId: string;
  layout: string;
  className?: string;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const last = useRef<{ targetId: string; at: number } | undefined>(undefined);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const target = document.getElementById(targetId);
    if (target === null) {
      element.hidden = true;
      return;
    }
    const now = performance.now();
    const moved = last.current !== undefined && last.current.targetId !== targetId;
    element.dataset["glide"] = String(moved && glides(now - last.current!.at));
    last.current = { targetId, at: now };
    element.hidden = false;
    placeOver(element, target);
    // The menu narrows and widens with the window, and the option with it, while neither the
    // selection nor the list changes: follow it there at once, never gliding.
    if (typeof ResizeObserver === "undefined") return;
    let placed = geometryOf(target);
    // An observer reports once as it starts watching, with nothing changed: that one must not end
    // the glide this selection just began, so only a real change of geometry re-places.
    const resized = new ResizeObserver(() => {
      const current = geometryOf(target);
      if (current === placed) return;
      placed = current;
      element.dataset["glide"] = "false";
      placeOver(element, target);
    });
    resized.observe(target);
    return () => resized.disconnect();
    // `layout` isn't read: a list that changes around the same option must place it again.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies, react-hooks/exhaustive-deps -- see above
  }, [targetId, layout]);
  return (
    <li
      ref={ref}
      aria-hidden
      role="presentation"
      data-testid="list-highlight"
      hidden
      className={cn("gram-list-highlight", className)}
    />
  );
}
