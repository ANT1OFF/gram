import { useSyncExternalStore } from "react";

/**
 * The widest window laid out for a phone (phone access): a drawer for the threads, full-screen
 * sheets for dialogs, bottom sheets for popovers and cards for tables. Only with a touch screen
 * as the main pointer: a desktop window this narrow keeps the desktop layout. The `phone:`
 * Tailwind variant (globals.css) is the same query, so classes and `usePhone()` agree.
 */
export const PHONE_MAX_WIDTH = 639;

export const PHONE_QUERY = `(max-width: ${PHONE_MAX_WIDTH}px) and (pointer: coarse)`;

const QUERY = PHONE_QUERY;

const media = () =>
  typeof window === "undefined" || typeof window.matchMedia !== "function"
    ? undefined
    : window.matchMedia(QUERY);

function subscribe(onChange: () => void) {
  const list = media();
  list?.addEventListener("change", onChange);
  return () => list?.removeEventListener("change", onChange);
}

const snapshot = () => media()?.matches ?? false;

/** True while the window is phone-sized. */
export function usePhone(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
