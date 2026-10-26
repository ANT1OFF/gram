import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

import { cn } from "@/lib/utils";

import { TREE_SHARE, clampShare } from "./files-store";

const KEYBOARD_STEP = 0.05;

/**
 * The drag handle between the file tree and the preview. `share` is the tree's part of the panel:
 * its height when they're stacked (`horizontal`, the default), its width side by side (`vertical`).
 * `container` measures the drag. Arrow keys move it, Home and End go to the ends, and a double-click
 * restores the default.
 */
export function SplitHandle({
  share,
  container,
  onResize,
  orientation = "horizontal",
}: {
  share: number;
  container: () => HTMLElement | null;
  onResize: (share: number) => void;
  orientation?: "horizontal" | "vertical";
}) {
  const across = orientation === "vertical";
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = container()?.getBoundingClientRect();
    const size = across ? box?.width : box?.height;
    if (event.button !== 0 || box === undefined || !size) return;
    event.preventDefault();
    const move = (moveEvent: PointerEvent) =>
      onResize(
        clampShare(
          across ? (moveEvent.clientX - box.left) / size : (moveEvent.clientY - box.top) / size,
        ),
      );
    const up = () => window.removeEventListener("pointermove", move);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const grow = across ? "ArrowRight" : "ArrowDown";
    const shrink = across ? "ArrowLeft" : "ArrowUp";
    const next =
      event.key === grow
        ? share + KEYBOARD_STEP
        : event.key === shrink
          ? share - KEYBOARD_STEP
          : event.key === "Home"
            ? TREE_SHARE.min
            : event.key === "End"
              ? TREE_SHARE.max
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    onResize(clampShare(next));
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={orientation}
      aria-label="Resize file tree"
      aria-valuenow={Math.round(share * 100)}
      aria-valuemin={Math.round(TREE_SHARE.min * 100)}
      aria-valuemax={Math.round(TREE_SHARE.max * 100)}
      title="Drag to resize, double-click to reset"
      data-testid="files-split"
      className={cn(
        "relative shrink-0 bg-border outline-none hover:bg-ring/60 focus-visible:bg-ring focus-visible:ring-2 focus-visible:ring-ring/50",
        across
          ? "w-px cursor-col-resize before:absolute before:inset-y-0 before:-inset-x-1"
          : "h-px cursor-row-resize before:absolute before:inset-x-0 before:-inset-y-1",
      )}
      onPointerDown={onPointerDown}
      onDoubleClick={() => onResize(TREE_SHARE.default)}
      onKeyDown={onKeyDown}
    />
  );
}
