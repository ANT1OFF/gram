import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Nothing has focus: the focused node was removed, or focus went to the page itself. */
export const focusLost = (): boolean =>
  document.activeElement === null || document.activeElement === document.body;

/** Focuses `element` when it's still on the page; false otherwise. */
export function focusIfConnected(element: Element | null | undefined): boolean {
  if (!(element instanceof HTMLElement) || !element.isConnected) return false;
  element.focus();
  return document.activeElement === element;
}

const focusedElement = (): HTMLElement | null =>
  document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement
    : null;

/**
 * For a transient surface such as a find bar or an inline form: remembers what had focus when it
 * mounted, and gives focus back when it unmounts, but only if focus fell to the page. When the
 * opener is gone as well, focus goes to `fallback()`.
 */
export function useReturnFocus(fallback?: () => Element | null | undefined) {
  // Read during the first render, before the surface's `autoFocus` moves focus.
  const [opener] = useState(() => (typeof document === "undefined" ? null : focusedElement()));
  const latestFallback = useRef(fallback);

  useEffect(() => {
    latestFallback.current = fallback;
  });

  useEffect(
    () => () => {
      // The surface's nodes leave the page after this cleanup; look once they have.
      setTimeout(() => {
        if (!focusLost()) return;
        if (!focusIfConnected(opener)) focusIfConnected(latestFallback.current?.());
      }, 0);
    },
    [opener],
  );
}

/**
 * The element that had focus when `open` turned true, for a dialog opened from a store or a
 * shortcut rather than a trigger. Use it as base-ui's `finalFocus`.
 */
export function useOpener(open: boolean): RefObject<HTMLElement | null> {
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open) opener.current = focusedElement();
  }, [open]);
  return opener;
}

/**
 * base-ui `finalFocus` for a dialog without a trigger: back to `opener` while it's on the page,
 * else `fallback()`, else base-ui's default.
 */
export const returnFocusTo =
  (opener: RefObject<HTMLElement | null>, fallback?: () => HTMLElement | null | undefined) =>
  (): HTMLElement | true => {
    const element = opener.current;
    if (element?.isConnected) return element;
    return fallback?.() ?? true;
  };
