import { useLayoutEffect, useRef, type RefObject } from "react";

import { cn } from "@/lib/utils";

/**
 * Puts `mark` over the current row of `container`, in its coordinates, or hides it when no row is
 * current. The first time it is shown it is put there; only later moves glide (`data-placed`).
 */
const follow = (container: HTMLElement, mark: HTMLElement) => {
  const row = container.querySelector<HTMLElement>('[aria-current="page"]');
  if (row === null) {
    mark.hidden = true;
    delete mark.dataset["placed"];
    return;
  }
  const outer = container.getBoundingClientRect();
  const inner = row.getBoundingClientRect();
  mark.style.top = `${inner.top - outer.top + container.scrollTop}px`;
  mark.style.left = `${inner.left - outer.left}px`;
  mark.style.width = `${inner.width}px`;
  mark.style.height = `${inner.height}px`;
  if (mark.hidden) {
    mark.hidden = false;
    requestAnimationFrame(() => {
      mark.dataset["placed"] = "";
    });
  }
};

/**
 * The current row's highlight, one for a whole list, which glides from row to row as the window
 * moves rather than jumping: under the Motion setting, at the theme's ease-out; Reduced and Off
 * move it at once. `container` is positioned, and its rows draw no current fill of their own.
 * It follows the current row after each render of the list and each change of its size.
 */
export function Glide({
  container,
  className,
}: {
  container: RefObject<HTMLElement | null>;
  className?: string;
}) {
  const mark = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (container.current !== null && mark.current !== null) {
      follow(container.current, mark.current);
    }
  });
  useLayoutEffect(() => {
    const element = container.current;
    const highlight = mark.current;
    if (element === null || highlight === null) return;
    const observer = new ResizeObserver(() => follow(element, highlight));
    observer.observe(element);
    return () => observer.disconnect();
  }, [container]);
  return (
    <span
      ref={mark}
      aria-hidden
      hidden
      data-testid="embed-navigation-glide"
      className={cn(
        "pointer-events-none absolute rounded-(--radius-sm) bg-sidebar-row-active data-placed:transition-[top,left,width,height] data-placed:duration-(--dur-move-base) data-placed:ease-(--ease-out)",
        className,
      )}
    />
  );
}
