import { ThreadId } from "@gram/contracts";
import * as Schema from "effect/Schema";
import { useEffect } from "react";

import { useApi } from "@/api/context";
import { useDraftStore } from "@/stores/drafts";

const DRAFT_REPORT_MS = 30_000;

const isThreadId = Schema.is(ThreadId);

/** The threads whose composer holds more than whitespace. */
export const draftedThreads = (text: Readonly<Record<string, string>>): ThreadId[] =>
  Object.entries(text)
    .flatMap(([threadId, value]) => (isThreadId(threadId) && value.trim() !== "" ? [threadId] : []))
    .toSorted();

/**
 * Tells the server which threads this window has drafts on: on every change, every
 * `DRAFT_REPORT_MS` while there are any, and once more, empty, as it goes. Idle compaction never
 * runs on a thread with one. Thread ids only; the text stays in the window.
 */
export function draftPresenceReporter<Id extends string>(
  send: (threadIds: readonly Id[]) => Promise<void>,
) {
  let last: string | undefined;
  const report = (threadIds: readonly Id[], force = false) => {
    const key = threadIds.join("\n");
    if (!force && key === last) return;
    if (force && threadIds.length === 0 && last === "") return;
    last = key;
    Promise.resolve()
      .then(() => send(threadIds))
      .catch((error: unknown) => console.warn("draft presence", error));
  };
  return { report };
}

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
    const reporter = draftPresenceReporter((threadIds: readonly ThreadId[]) =>
      api.composerDrafts(id, threadIds),
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
