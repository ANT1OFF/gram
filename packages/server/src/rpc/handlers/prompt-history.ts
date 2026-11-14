import {
  PROMPT_HISTORY_LIMIT,
  PROMPT_HISTORY_THREADS,
  promptsFromMessages,
  promptText,
  type GramUIMessage,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { findUserMessages, ThreadStore } from "../../persistence/thread-store.ts";
import type { Handlers } from "./common.ts";

/** `thread.promptHistory`: ↑/↓ recall from the user messages already stored, never a copy. */
export const promptHistoryHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;

  return {
    "thread.promptHistory": ({ threadId, limit }) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId);
        const others = (yield* store.listThreads)
          .filter((other) => other.id !== threadId && other.projectId === thread.projectId)
          .toSorted((a, b) => b.lastActivityAt - a.lastActivityAt)
          .slice(0, PROMPT_HISTORY_THREADS);
        // Only the prompts: a project's replies run to tens of MB, all decoded on the event loop
        // each time a thread opened. And of those only as many as ↑ walks, newest first: an
        // orchestrator's thousands of digests are user messages too.
        const cap = Math.max(0, Math.min(limit ?? PROMPT_HISTORY_LIMIT, PROMPT_HISTORY_LIMIT));
        const seen = new Set<string>();
        const transcripts: Array<ReadonlyArray<GramUIMessage>> = [];
        for (const t of [thread, ...others]) {
          if (seen.size >= Math.max(1, cap)) break;
          transcripts.push(
            yield* findUserMessages(store, t.id, {
              from: "newest",
              count: Math.max(1, cap) - seen.size,
              // What `promptsFromMessages` would take: typed, and not recalled already.
              keep: (message) => {
                const text = promptText(message);
                if (text === "" || seen.has(text)) return false;
                seen.add(text);
                return true;
              },
            }),
          );
        }
        return { prompts: promptsFromMessages(transcripts, cap) };
      }),
  } satisfies Partial<Handlers>;
});
