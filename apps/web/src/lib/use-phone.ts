import { useSyncExternalStore } from "react";

/**
 * The widest window laid out for a phone or a tablet held upright (phone access): a drawer for the
 * threads, full-screen sheets for dialogs, bottom sheets for popovers and cards for tables. Only
 * with a touch screen as the main pointer: a desktop window this narrow keeps the desktop layout,
 * unless it is as narrow as a phone (`NARROW_MAX_WIDTH`), where the desktop's columns do not fit.
 * The `phone:` Tailwind variant (theme.css) is the same query, so classes and `usePhone()` agree.
 */
export const PHONE_MAX_WIDTH = 1023;

/** The widest window laid out for a phone whatever its pointer. */
export const NARROW_MAX_WIDTH = 479;

export const PHONE_QUERY = `(max-width: ${PHONE_MAX_WIDTH}px) and (pointer: coarse), (max-width: ${NARROW_MAX_WIDTH}px)`;

/** A touch screen as the main pointer, at any width: one pane at a time, nothing side by side. */
export const TOUCH_QUERY = "(pointer: coarse)";

const media = (query: string) =>
  typeof window === "undefined" || typeof window.matchMedia !== "function"
    ? undefined
    : window.matchMedia(query);

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = media(query);
      list?.addEventListener("change", onChange);
      return () => list?.removeEventListener("change", onChange);
    },
    () => media(query)?.matches ?? false,
    () => false,
  );
}

/** True while the window is laid out for a phone (or an upright tablet). */
export function usePhone(): boolean {
  return useMedia(PHONE_QUERY);
}

/** True while the main pointer is a touch screen. */
export function useTouch(): boolean {
  return useMedia(TOUCH_QUERY);
}

/** `useTouch()` outside React, read once (a command list built on open). */
export const isTouch = (): boolean => media(TOUCH_QUERY)?.matches ?? false;
