import type { ThreadId } from "@gram/contracts";
import { useEffect } from "react";

import { useApi } from "@/api/context";
import { useDraftStore } from "@/stores/drafts";

/** While a draft waits, the server hears of it at least this often (`DRAFT_REPORT_MS` there). */
const DRAFT_REPORT_MS = 30_000;

/** The threads whose composer holds more than whitespace. */
export const draftedThreads = (text: Readonly<Record<string, string>>): string[] =>
  Object.entries(text)
    .filter(([, value]) => value.trim() !== "")
    .map(([threadId]) => threadId)
    .toSorted();

/**
 * Tells the server which threads this window has drafts on: on every change, every
 * `DRAFT_REPORT_MS` while there are any, and once more, empty, as it goes. Idle compaction never
 * runs on a thread with one. Thread ids only; the text stays in the window.
 */
export function draftPresenceReporter(send: (threadIds: readonly string[]) => Promise<void>) {
  let last: string | undefined;
  const report = (threadIds: readonly string[], force = false) => {
    const key = threadIds.join("\n");
    // Nothing to repeat for a window with no drafts: the server forgets it once it says so.
    if (!force && key === last) return;
    if (force && threadIds.length === 0 && last === "") return;
    last = key;
    Promise.resolve()
      .then(() => send(threadIds))
      .catch((error: unknown) => console.warn("draft presence", error));
  };
  return { report };
}

/** A window's own id for its draft reports, kept across reloads of the window. */
const windowId = (): string => {
  const key = "gram.composer.windowId";
  try {
    const known = sessionStorage.getItem(key);
    if (known !== null) return known;
    const made = crypto.randomUUID();
    sessionStorage.setItem(key, made);
    return made;
  } catch {
    return crypto.randomUUID();
  }
};

/** Mounted once per window: reports its drafts to the server as `draftPresenceReporter` says. */
export function useDraftPresence(): void {
  const api = useApi();
  useEffect(() => {
    const id = windowId();
    const reporter = draftPresenceReporter((threadIds) =>
      api.composerDrafts(id, threadIds as readonly ThreadId[]),
    );
    const current = () => draftedThreads(useDraftStore.getState().text);
    reporter.report(current());
    const unsubscribe = useDraftStore.subscribe((state) =>
      reporter.report(draftedThreads(state.text)),
    );
    const heartbeat = setInterval(() => {
      const threadIds = current();
      if (threadIds.length > 0) reporter.report(threadIds, true);
    }, DRAFT_REPORT_MS);
    const leave = () => reporter.report([], true);
    window.addEventListener("pagehide", leave);
    return () => {
      unsubscribe();
      clearInterval(heartbeat);
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [api]);
}
