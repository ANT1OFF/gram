import { useEffect, useSyncExternalStore } from "react";

import type * as Markdown from "./markdown";

type MarkdownModule = typeof Markdown;

/** The module once loaded; `failed` once a load failed, until the next try. */
type MarkdownState = { readonly module?: MarkdownModule; readonly failed?: true };

let state: MarkdownState = {};
let loading: Promise<MarkdownModule> | undefined;
const listeners = new Set<() => void>();

const set = (next: MarkdownState) => {
  state = next;
  for (const listener of listeners) listener();
};

/**
 * Loads streamdown and its highlighter once; the shell starts it after first paint. A failed load
 * (a chunk gone after an update) is tried again by the next caller.
 */
export const loadMarkdown = (): Promise<MarkdownModule> => {
  loading ??= import("./markdown").then(
    (module) => {
      set({ module });
      return module;
    },
    (error: unknown) => {
      loading = undefined;
      set({ failed: true });
      throw error;
    },
  );
  return loading;
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The markdown renderer once it has loaded, starting the load if nothing has yet. */
export function useMarkdown(): MarkdownState {
  const current = useSyncExternalStore(subscribe, () => state);
  const missing = current.module === undefined && current.failed === undefined;
  useEffect(() => {
    if (missing) loadMarkdown().catch(() => {});
  }, [missing]);
  return current;
}
