import {
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { cn } from "@/lib/utils";
import type { WidthBounds } from "@/stores/layout";

const KEYBOARD_STEP = 16;
/** How long after the window's last resize event it still counts as being resized. */
const WINDOW_SETTLE_MS = 150;

export interface WindowWidth {
  width: number;
  /** True while the window is being resized, so widths that follow it don't animate behind it. */
  resizing: boolean;
}

let windowWidth: WindowWidth = {
  width: typeof window === "undefined" ? 0 : window.innerWidth,
  resizing: false,
};

const subscribeWindowWidth = (onChange: () => void) => {
  let settle: ReturnType<typeof setTimeout> | undefined;
  const onResize = () => {
    windowWidth = { width: window.innerWidth, resizing: true };
    onChange();
    clearTimeout(settle);
    settle = setTimeout(() => {
      windowWidth = { width: window.innerWidth, resizing: false };
      onChange();
    }, WINDOW_SETTLE_MS);
  };
  window.addEventListener("resize", onResize);
  if (windowWidth.width !== window.innerWidth) {
    windowWidth = { width: window.innerWidth, resizing: false };
    onChange();
  }
  return () => {
    clearTimeout(settle);
    window.removeEventListener("resize", onResize);
  };
};

export function useWindowWidth(): WindowWidth {
  return useSyncExternalStore(
    subscribeWindowWidth,
    () => windowWidth,
    () => windowWidth,
  );
}

/** How far the pointer moves before a press counts as a drag, so a double-click's jitter doesn't. */
const DRAG_THRESHOLD = 3;

/** A drag handle on a side panel's inner edge; double-click restores the default width. */
export function SideResizeHandle({
  side,
  label,
  width,
  bounds,
  onResize,
  onActive,
  onDoubleClick,
  hint = "Drag to resize, double-click to reset",
}: {
  side: "left" | "right";
  label: string;
  width: number;
  bounds: WidthBounds;
  onResize: (width: number) => void;
  onActive: (active: boolean) => void;
  /** Replaces the reset; `hint` should say what it does instead. */
  onDoubleClick?: (() => void) | undefined;
  hint?: string;
}) {
  // Dragging the left panel's edge right widens it; the right panel's edge widens to the left.
  const direction = side === "left" ? 1 : -1;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    onActive(true);
    let dragging = false;
    const move = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      if (!dragging && Math.abs(delta) < DRAG_THRESHOLD) return;
      dragging = true;
      onResize(startWidth + delta * direction);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      onActive(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowRight" ? KEYBOARD_STEP : event.key === "ArrowLeft" ? -KEYBOARD_STEP : 0;
    if (step === 0) return;
    event.preventDefault();
    onResize(width + step * direction);
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      title={hint}
      data-testid={`${side}-resize`}
      className={cn(
        "absolute inset-y-0 z-40 w-1.5 cursor-col-resize outline-none hover:bg-ring/40 focus-visible:bg-ring/50",
        // Inside the column: the column clips overflow while it animates.
        side === "left" ? "right-0" : "left-0",
      )}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick ?? (() => onResize(bounds.default))}
      onKeyDown={onKeyDown}
    />
  );
}
