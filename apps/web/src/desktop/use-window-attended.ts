import { useSyncExternalStore } from "react";

const subscribe = (onChange: () => void) => {
  document.addEventListener("visibilitychange", onChange);
  window.addEventListener("focus", onChange);
  window.addEventListener("blur", onChange);
  return () => {
    document.removeEventListener("visibilitychange", onChange);
    window.removeEventListener("focus", onChange);
    window.removeEventListener("blur", onChange);
  };
};

/** The window is on screen and has the user's focus, as `use-window-placements` reports it. */
const windowAttended = (): boolean => document.visibilityState !== "hidden" && document.hasFocus();

/** Whether the user is in this window right now: not minimised, hidden or behind another app. */
export const useWindowAttended = (): boolean => useSyncExternalStore(subscribe, windowAttended);
