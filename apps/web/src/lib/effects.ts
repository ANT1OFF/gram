// The web app's effects, by what they are for. A raw `useEffect` takes any code and any
// dependencies, and most of what gets written in one belongs in render or in an event handler, so
// product code names its effect with one of these instead (`gram/no-raw-effect`; see
// CONTRIBUTING.md#react-effects). Timers are in `timers.ts` and `use-now.ts`.

import { useEffect, useLayoutEffect, useRef, type DependencyList, type RefObject } from "react";

/** What an effect hands back to undo itself. */
type Cleanup = () => void;

/**
 * Attach to something outside React while the component is mounted: a store's `subscribe`, the
 * desktop bridge's `onChange`, a DOM event (with `listen`), an observer, a `retain` that is
 * released. `subscribe` returns the detach, or `undefined` when there is nothing to attach to, and
 * runs again whenever `deps` change. To read a value that changes, `useSyncExternalStore` or the
 * store's own hook is simpler still.
 */
export function useSubscription(subscribe: () => Cleanup | undefined, deps: DependencyList): void {
  // oxlint-disable-next-line react/exhaustive-deps -- `deps` are the caller's, checked at its call (`additionalHooks`)
  useEffect(subscribe, deps);
}

/**
 * Push what this render shows out to something React doesn't own: the document, an element's
 * attribute, local storage, the desktop bridge, a store another tree reads. Not for setting this
 * component's own state or telling a parent something changed: derive that in render, or do it in
 * the handler that made the change.
 */
export function useExternalSync(
  sync: () => Cleanup | undefined | void,
  deps?: DependencyList,
): void {
  // oxlint-disable-next-line react/exhaustive-deps -- `deps` are the caller's, checked at its call (`additionalHooks`)
  useEffect(sync, deps);
}

/** `useExternalSync` before the browser paints: to measure or place the DOM without a flicker. */
export function useLayoutSync(sync: () => Cleanup | undefined | void, deps?: DependencyList): void {
  // oxlint-disable-next-line react/exhaustive-deps -- `deps` are the caller's, checked at its call (`additionalHooks`)
  useLayoutEffect(sync, deps);
}

/**
 * Run `effect` once, after the first render, and its cleanup on unmount. It sees the first render's
 * values only; for something that must follow later ones, use `useSubscription` or
 * `useExternalSync` with their dependencies.
 */
export function useMountEffect(effect: () => Cleanup | undefined | void): void {
  // oxlint-disable-next-line react/exhaustive-deps -- once on mount by definition
  useEffect(effect, []);
}

/**
 * A ref that holds the value of the last committed render, for a handler or a subscription that
 * must read the current value without being re-attached when it changes.
 */
export function useLatest<T>(value: T): RefObject<T> {
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  });
  return latest;
}

/** `addEventListener`, returning its `removeEventListener`: what `useSubscription` takes. */
export function listen<K extends keyof WindowEventMap>(
  target: Window,
  type: K,
  listener: (event: WindowEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
): Cleanup;
export function listen<K extends keyof DocumentEventMap>(
  target: Document,
  type: K,
  listener: (event: DocumentEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
): Cleanup;
export function listen<K extends keyof HTMLElementEventMap>(
  target: HTMLElement,
  type: K,
  listener: (event: HTMLElementEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
): Cleanup;
export function listen(
  target: EventTarget,
  type: string,
  listener: (event: Event) => void,
  options?: boolean | AddEventListenerOptions,
): Cleanup;
export function listen(
  target: EventTarget,
  type: string,
  listener: (event: Event) => void,
  options?: boolean | AddEventListenerOptions,
): Cleanup {
  target.addEventListener(type, listener, options);
  return () => target.removeEventListener(type, listener, options);
}
