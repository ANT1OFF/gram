import { PROMPT_HISTORY_LIMIT, PROMPT_HISTORY_THREADS, promptsFromMessages } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { ThreadStore } from "../../persistence/thread-store.ts";
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
        // each time a thread opened.
        const transcripts = yield* Effect.forEach([thread, ...others], (t) =>
          store.listUserMessages(t.id),
        );
        const cap = Math.max(0, Math.min(limit ?? PROMPT_HISTORY_LIMIT, PROMPT_HISTORY_LIMIT));
        return { prompts: promptsFromMessages(transcripts, cap) };
      }),
  } satisfies Partial<Handlers>;
});
