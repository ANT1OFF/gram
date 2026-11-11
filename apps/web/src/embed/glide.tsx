import { useLayoutEffect, useRef } from "react";

import { cn } from "@/lib/utils";

/**
 * Puts `mark` over the current row of `container`, in its coordinates, or hides it when no row is
 * current: over the row's tile (`data-glide-tile`) when `tile`, else the whole row. The first time
 * it is shown it is put there; only later moves glide (`data-placed`).
 */
const follow = (container: HTMLElement, mark: HTMLElement, tile: boolean) => {
  const current = container.querySelector<HTMLElement>('[aria-current="page"]');
  const row = tile
    ? (current?.querySelector<HTMLElement>("[data-glide-tile]") ?? current)
    : current;
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
 * move it at once. Its list is the element it is drawn in, which is positioned, and whose rows draw
 * no current fill of their own. It follows the current row after each render and each change of
 * the list's size. (The list is read from the highlight's own parent: a parent's ref is not yet
 * set while its children's layout effects run on the first commit.)
 */
export function Glide({
  className,
  tile = false,
}: {
  className?: string;
  /** Over the current row's tile (`data-glide-tile`) rather than the whole row. */
  tile?: boolean;
}) {
  const mark = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const highlight = mark.current;
    const list = highlight?.parentElement;
    if (highlight && list) follow(list, highlight, tile);
  });
  useLayoutEffect(() => {
    const highlight = mark.current;
    const list = highlight?.parentElement;
    if (!highlight || !list) return;
    const observer = new ResizeObserver(() => follow(list, highlight, tile));
    observer.observe(list);
    return () => observer.disconnect();
  }, [tile]);
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
