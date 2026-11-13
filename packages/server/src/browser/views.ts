// Watching a thread's page in the server's own browser from a client: this module asks the
// browser host for the page while anyone watches (`pane.view.watch`, again and again, so a host
// that hears nothing more stops by itself), hands its page state and frames to each watcher, and
// carries a person's input the other way. It starts no host and no browser: a page shows once an
// agent has one.

import {
  VIEW_RENEW_MS,
  viewHostMessage,
  type BrowserViewEvent,
  type BrowserViewPage,
  type ViewControl,
  type ViewInput,
} from "@gram/contracts";

import type { PaneViewPort } from "./pane-port.ts";

export type ViewEvent = BrowserViewEvent;
type PageEvent = Extract<ViewEvent, { type: "page" }>;

const URL_MAX = 8_192;
const TITLE_MAX = 300;

/** The host's page as the wire carries it, field by field: the host renders pages agents wrote. */
const pageOf = (raw: unknown): BrowserViewPage | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r["url"] !== "string" || typeof r["title"] !== "string") return null;
  // A page chooses its own address and title, and each is sent to every watcher again and again.
  if (r["url"].length > URL_MAX) return null;
  const action = r["action"] as { summary?: unknown; at?: unknown } | undefined;
  return {
    url: r["url"],
    title: r["title"].slice(0, TITLE_MAX),
    loading: r["loading"] === true,
    canGoBack: r["canGoBack"] === true,
    canGoForward: r["canGoForward"] === true,
    ...(r["driver"] === "agent" || r["driver"] === "user" ? { driver: r["driver"] } : {}),
    ...(typeof action?.summary === "string" && typeof action.at === "number"
      ? { action: { summary: action.summary.slice(0, TITLE_MAX), at: action.at } }
      : {}),
    ...(r["recording"] === true ? { recording: true } : {}),
  };
};

const statusOf = (raw: unknown): PageEvent["status"] => {
  const r = raw as { kind?: unknown; message?: unknown } | undefined;
  if (r?.kind === "starting") return { kind: "starting" };
  return r?.kind === "failed" && typeof r.message === "string"
    ? { kind: "failed", message: r.message }
    : undefined;
};

export interface BrowserViews {
  /** Watches `threadId`'s page: what it is now at once, then each change and frame. Returns the end. */
  watch(threadId: string, listener: (event: ViewEvent) => void): () => void;
  input(threadId: string, inputs: ReadonlyArray<ViewInput>): void;
  control(threadId: string, op: ViewControl): void;
}

interface Watched {
  readonly listeners: Set<(event: ViewEvent) => void>;
  page: PageEvent;
  frame: Extract<ViewEvent, { type: "frame" }> | undefined;
  /** Whether the host has said anything of this thread's page since the watch began. */
  heard: boolean;
  renew: ReturnType<typeof setInterval>;
}

const NO_PAGE: PageEvent = { type: "page", page: null };

export const createBrowserViews = (
  port: PaneViewPort,
  renewMs: number = VIEW_RENEW_MS,
): BrowserViews => {
  const threads = new Map<string, Watched>();
  const tell = (watched: Watched, event: ViewEvent) => {
    for (const listener of Array.from(watched.listeners)) listener(event);
  };
  port.on((raw) => {
    const message = viewHostMessage(raw);
    if (message === undefined) return;
    const watched = threads.get(message.threadId);
    if (watched === undefined) return;
    watched.heard = true;
    if (message.type === "pane.view.page") {
      const page = pageOf(message.page);
      const status = page === null ? statusOf(message.status) : undefined;
      watched.page = { type: "page", page, ...(status === undefined ? {} : { status }) };
      if (page === null) watched.frame = undefined;
      tell(watched, watched.page);
      return;
    }
    const { jpeg, width, height } = message;
    watched.frame = { type: "frame", jpeg, width, height };
    tell(watched, watched.frame);
  });
  port.onStopped(() => {
    for (const watched of threads.values()) {
      watched.heard = false;
      watched.page = NO_PAGE;
      watched.frame = undefined;
      tell(watched, NO_PAGE);
    }
  });
  return {
    watch: (threadId, listener) => {
      let watched = threads.get(threadId);
      if (watched === undefined) {
        const ask = (fresh = false) =>
          port.post({ type: "pane.view.watch", threadId, ...(fresh ? { fresh } : {}) });
        const made: Watched = {
          listeners: new Set(),
          page: NO_PAGE,
          frame: undefined,
          heard: false,
          renew: setInterval(() => {
            // Fresh until the host has answered once: it may not have been running to hear.
            ask(!made.heard);
            // Said again, since a slow watcher's oldest events are dropped for its newest.
            tell(made, made.page);
          }, renewMs),
        };
        watched = made;
        threads.set(threadId, made);
        // Nothing is known of the page here yet, though the host may still be sending it from a
        // watch that ended a moment ago: it is asked to say it all again.
        ask(true);
      }
      const entry = watched;
      entry.listeners.add(listener);
      listener(entry.page);
      if (entry.frame !== undefined) listener(entry.frame);
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size > 0 || threads.get(threadId) !== entry) return;
        clearInterval(entry.renew);
        threads.delete(threadId);
      };
    },
    // Only what someone here is watching is driven from here.
    input: (threadId, inputs) => {
      if (threads.has(threadId)) port.post({ type: "pane.view.input", threadId, inputs });
    },
    control: (threadId, op) => {
      if (threads.has(threadId)) port.post({ type: "pane.view.control", threadId, op });
    },
  };
};
