import { useEffect, useSyncExternalStore } from "react";

import { thisLinkIsConstrained } from "@/shell/constrained-link";

import type * as Markdown from "./markdown";

type MarkdownModule = typeof Markdown;

/**
 * The module once loaded; `failed` once a load failed, until the next try. `plain` while it is
 * still loading over a slow link: text shows unstyled there and restyles when the module arrives,
 * since the renderer is a fifth of a megabyte and the wait for it is seconds, not a frame.
 */
type MarkdownState = {
  readonly module?: MarkdownModule;
  readonly failed?: true;
  readonly plain?: true;
};

let state: MarkdownState = {};
let slow: boolean | undefined;
/** Asked once, when a transcript first wants the renderer: the window's own files have arrived by then. */
const slowLink = () => (slow ??= thisLinkIsConstrained());
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
  const current = useSyncExternalStore(subscribe, snapshot);
  const missing = current.module === undefined && current.failed === undefined;
  useEffect(() => {
    if (missing) loadMarkdown().catch(() => {});
  }, [missing]);
  return current;
}

const PLAIN: MarkdownState = { plain: true };
/** Stable between changes, as `useSyncExternalStore` needs. */
const snapshot = (): MarkdownState =>
  state.module === undefined && state.failed === undefined && slowLink() ? PLAIN : state;
