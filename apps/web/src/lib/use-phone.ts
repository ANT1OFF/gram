import { useSyncExternalStore } from "react";

/**
 * The widest window laid out for a phone (phone access): a drawer for the threads, full-screen
 * sheets for dialogs, bottom sheets for popovers and cards for tables. It matches Tailwind's `sm`
 * breakpoint, so `max-sm:` classes and `usePhone()` agree.
 */
export const PHONE_MAX_WIDTH = 639;

const QUERY = `(max-width: ${PHONE_MAX_WIDTH}px)`;

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
