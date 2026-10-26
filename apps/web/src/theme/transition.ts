import { easingCss, LOOKS } from "@gram/themes";
import { flushSync } from "react-dom";

import { themeStore, type ThemeStore } from "./store";
import { systemSource, type SystemSource } from "./system";
import { resolveMotion, type ThemePrefs } from "./theme";

export interface Point {
  x: number;
  y: number;
}

/** The clip-path keyframes for a circle growing from `origin` until it covers the viewport. */
export function revealKeyframes(origin: Point, viewport: { width: number; height: number }) {
  const radius = Math.hypot(
    Math.max(origin.x, viewport.width - origin.x),
    Math.max(origin.y, viewport.height - origin.y),
  );
  const at = `at ${Math.round(origin.x)}px ${Math.round(origin.y)}px`;
  return { clipPath: [`circle(0px ${at})`, `circle(${Math.ceil(radius)}px ${at})`] };
}

/** Marks `<html>` while a theme reveal runs so token colour transitions don't smear the capture. */
export const THEME_SWITCHING_ATTR = "data-theme-switching";

/**
 * Applies a theme change, revealing it as a circle from `origin` (the click point) through a view
 * transition. Falls back to an instant change when motion isn't Full or view transitions are
 * unavailable.
 */
export function switchTheme(
  patch: Partial<ThemePrefs>,
  origin?: Point,
  deps: { store?: ThemeStore; system?: SystemSource; doc?: Document } = {},
) {
  const store = deps.store ?? themeStore;
  const system = deps.system ?? systemSource;
  const doc = deps.doc ?? document;
  const apply = () => store.getState().setTheme(patch);
  const motion = resolveMotion(store.getState().motion, system.get().prefersReducedMotion);
  if (motion !== "full" || typeof doc.startViewTransition !== "function") {
    apply();
    return;
  }

  const view = doc.defaultView;
  const viewport = { width: view?.innerWidth ?? 0, height: view?.innerHeight ?? 0 };
  const point = origin ?? { x: viewport.width / 2, y: viewport.height / 2 };
  const root = doc.documentElement;
  root.setAttribute(THEME_SWITCHING_ATTR, "");
  const transition = doc.startViewTransition(() => flushSync(apply));
  const look = LOOKS[store.getState().look];
  transition.ready
    .then(() => {
      root.animate(revealKeyframes(point, viewport), {
        duration: Math.min(900, Math.max(360, look.motion.durations.slow * 2.5)),
        easing: easingCss(look.motion.easing.inOut),
        pseudoElement: "::view-transition-new(root)",
      });
    })
    .catch(() => {});
  transition.finished.finally(() => root.removeAttribute(THEME_SWITCHING_ATTR)).catch(() => {});
}
