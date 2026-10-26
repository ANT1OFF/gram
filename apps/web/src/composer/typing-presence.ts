import { useCallback } from "react";

import { useApi } from "@/api/context";
import type { Api } from "@/api/types";

/** The server holds background helper jobs for a little longer than this after each report. */
const TYPING_REPORT_MS = 2_000;

/**
 * A keystroke reporter that tells the server the user is typing at most once per
 * `TYPING_REPORT_MS`, however fast they type.
 */
export function typingReporter(
  send: () => Promise<void>,
  now: () => number = Date.now,
): () => void {
  let last = Number.NEGATIVE_INFINITY;
  return () => {
    const at = now();
    if (at - last < TYPING_REPORT_MS) return;
    last = at;
    Promise.resolve()
      .then(send)
      .catch((error: unknown) => console.warn("helper presence", error));
  };
}

/** One reporter per connection, shared by every composer, so two windows' panes throttle as one. */
const reporters = new WeakMap<Api, () => void>();

/** Call on every edit of a composer's text: background helper jobs wait while the user types. */
export function useTypingPresence(): () => void {
  const api = useApi();
  return useCallback(() => {
    let report = reporters.get(api);
    if (report === undefined) {
      report = typingReporter(() => api.helperPresence(true));
      reporters.set(api, report);
    }
    report();
  }, [api]);
}
