import { useEffect, useSyncExternalStore } from "react";

/**
 * A part of the app left out of the first download: a dialog's body, a sheet, a view. The shell
 * preloads it once the window is idle after first paint (`usePreloadAfterPaint`), so it's usually
 * in hand before anyone opens it.
 */
export interface LazyPart<T> {
  /** Loads the module once; a failed load (a chunk gone after an update) is tried again next time. */
  readonly preload: () => Promise<T>;
  /** The module if it has loaded, without asking for it. */
  readonly current: () => T | undefined;
  /**
   * The module once loaded, asking for it while `wanted`. A surface that opens over the app passes
   * its open flag, and opens once this returns the module: it then opens the way it always did, with
   * its enter transition and initial focus, rather than as an empty frame that fills in. Named as a
   * hook, not `use`, which the React Compiler takes for React's own `use()` and lets run
   * conditionally.
   */
  readonly useModule: (wanted: boolean) => T | undefined;
}

const parts: LazyPart<unknown>[] = [];

export function lazyPart<T>(load: () => Promise<T>): LazyPart<T> {
  let loaded: T | undefined;
  let loading: Promise<T> | undefined;
  const listeners = new Set<() => void>();
  const preload = () => {
    loading ??= load().then(
      (module) => {
        loaded = module;
        for (const listener of listeners) listener();
        return module;
      },
      (error: unknown) => {
        loading = undefined;
        throw error;
      },
    );
    return loading;
  };
  const current = () => loaded;
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const useModule = (wanted: boolean) => {
    const module = useSyncExternalStore(subscribe, current, current);
    const missing = wanted && module === undefined;
    useEffect(() => {
      if (missing) preload().catch((error: unknown) => console.error("lazy part: load", error));
    }, [missing]);
    return module;
  };
  const part: LazyPart<T> = { preload, current, useModule };
  parts.push(part as LazyPart<unknown>);
  return part;
}

/** Every part made so far, for the shell's idle preload. */
export const lazyParts = (): readonly LazyPart<unknown>[] => parts;
