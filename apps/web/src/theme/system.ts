import { useSyncExternalStore } from "react";

import { DEFAULT_SYSTEM_PREFS, type SystemPrefs } from "./theme";

/** An external store of OS preferences; `get` returns a stable object until something changes. */
export interface SystemSource {
  get: () => SystemPrefs;
  subscribe: (onChange: () => void) => () => void;
}

const QUERIES = {
  prefersDark: "(prefers-color-scheme: dark)",
  prefersReducedMotion: "(prefers-reduced-motion: reduce)",
  prefersMoreContrast: "(prefers-contrast: more)",
} as const satisfies Record<keyof SystemPrefs, string>;

function createBrowserSystemSource(win: Window): SystemSource {
  const dark = win.matchMedia(QUERIES.prefersDark);
  const reduced = win.matchMedia(QUERIES.prefersReducedMotion);
  const contrast = win.matchMedia(QUERIES.prefersMoreContrast);
  const lists = [dark, reduced, contrast];
  const read = (): SystemPrefs => ({
    prefersDark: dark.matches,
    prefersReducedMotion: reduced.matches,
    prefersMoreContrast: contrast.matches,
  });
  let snapshot = read();
  return {
    get: () => snapshot,
    subscribe(onChange) {
      const listener = () => {
        snapshot = read();
        onChange();
      };
      for (const mql of lists) mql.addEventListener("change", listener);
      return () => {
        for (const mql of lists) mql.removeEventListener("change", listener);
      };
    },
  };
}

function createStaticSystemSource(prefs: SystemPrefs = DEFAULT_SYSTEM_PREFS): SystemSource {
  return { get: () => prefs, subscribe: () => () => {} };
}

export const systemSource: SystemSource =
  typeof window === "undefined" || typeof window.matchMedia !== "function"
    ? createStaticSystemSource()
    : createBrowserSystemSource(window);

export function useSystemPrefs(): SystemPrefs {
  return useSyncExternalStore(systemSource.subscribe, systemSource.get, () => DEFAULT_SYSTEM_PREFS);
}
