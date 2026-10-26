import type { ThreadId } from "@gram/contracts";
import { useEffect } from "react";

import { useApi } from "@/api/context";

export interface PromptHistory {
  push(text: string): void;
  /** The next older prompt, or undefined at the oldest. `draft` is restored when stepping back. */
  previous(draft: string): string | undefined;
  /** The next newer prompt, the saved draft past the newest, or undefined when not navigating. */
  next(): string | undefined;
  readonly navigating: boolean;
  reset(): void;
  /** Older prompts from the server, newest first, below this session's; ignored while navigating. */
  seed(prompts: readonly string[]): void;
}

export function createPromptHistory(limit = 50): PromptHistory {
  /** Oldest first, each prompt once. */
  const entries: string[] = [];
  /** Steps back from the newest entry; -1 means not navigating. */
  let index = -1;
  let draft = "";

  return {
    push(text) {
      if (!text.trim()) return;
      const at = entries.indexOf(text);
      if (at !== -1) entries.splice(at, 1);
      entries.push(text);
      if (entries.length > limit) entries.splice(0, entries.length - limit);
      index = -1;
    },
    previous(current) {
      if (index + 1 >= entries.length) return undefined;
      if (index === -1) draft = current;
      index++;
      return entries[entries.length - 1 - index];
    },
    next() {
      if (index === -1) return undefined;
      index--;
      return index === -1 ? draft : entries[entries.length - 1 - index];
    },
    get navigating() {
      return index !== -1;
    },
    reset() {
      index = -1;
    },
    seed(prompts) {
      if (index !== -1) return;
      const older = prompts
        .toReversed()
        .filter((prompt) => prompt.trim() && !entries.includes(prompt));
      entries.unshift(...new Set(older));
      if (entries.length > limit) entries.splice(0, entries.length - limit);
    },
  };
}

const histories = new Map<string, PromptHistory>();

/** Per-thread prompt navigation for the window's lifetime. */
function historyFor(threadId: string): PromptHistory {
  let history = histories.get(threadId);
  if (!history) {
    history = createPromptHistory();
    histories.set(threadId, history);
  }
  return history;
}

/**
 * `historyFor(threadId)`, seeded from the prompts the server has stored, so ↑ reaches prompts sent
 * before a reload or restart. The server derives them from its messages; nothing is copied here.
 */
export function usePromptHistory(threadId: ThreadId): PromptHistory {
  const api = useApi();
  const history = historyFor(threadId);
  useEffect(() => {
    let cancelled = false;
    api.promptHistory(threadId).then(
      (prompts) => {
        if (!cancelled) history.seed(prompts);
      },
      () => {
        // Recall still works for this session's prompts.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, threadId, history]);
  return history;
}
