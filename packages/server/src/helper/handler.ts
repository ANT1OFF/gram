import * as Effect from "effect/Effect";
import { ThreadStore } from "../persistence/thread-store.ts";
import type { Handlers } from "../rpc/handlers/common.ts";
import { ThreadAssist } from "./assist.ts";

/**
 * `thread.recap`, `thread.catchUp`, `thread.whyStuck`, `thread.suggestions`, `request.replies`,
 * `request.noticeTitle`, `helper.recordEvent` and `orchestrator.featureSummary`.
 */
export const assistHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const assist = yield* ThreadAssist;

  return {
    "palette.filters": ({ threadId, query }) =>
      store.getThread(threadId).pipe(
        Effect.andThen(assist.paletteFilters(threadId, query)),
        Effect.map((filters) => [...filters]),
      ),
    "thread.recap": ({ threadId }) =>
      store.getThread(threadId).pipe(
        Effect.andThen(assist.recap(threadId)),
        Effect.map((view) => view ?? null),
      ),
    "thread.catchUp": ({ threadId }) =>
      store.getThread(threadId).pipe(
        Effect.andThen(assist.catchUp(threadId)),
        Effect.map((view) => view ?? null),
      ),
    "thread.whyStuck": ({ threadId }) =>
      store.getThread(threadId).pipe(
        Effect.andThen(assist.whyStuck(threadId)),
        Effect.map((view) => view ?? null),
      ),
    "thread.suggestions": ({ threadId }) =>
      store.getThread(threadId).pipe(
        Effect.andThen(assist.suggestions(threadId)),
        Effect.map((s) => s ?? null),
      ),
    "request.replies": ({ threadId, requestId }) =>
      store.getThread(threadId).pipe(
        Effect.andThen(assist.askReplies(threadId, requestId)),
        Effect.map((replies) => [...replies]),
      ),
    "request.noticeTitle": ({ threadId, requestId, count }) =>
      store.getThread(threadId).pipe(
        Effect.andThen(assist.noticeTitle(threadId, requestId, count)),
        Effect.map((title) => title ?? null),
      ),
    "helper.recordEvent": (payload) => assist.recordEvent(payload),
    "orchestrator.featureSummary": ({ workspaceId, feature }) =>
      assist.featureSummary(workspaceId, feature).pipe(Effect.map((summary) => summary ?? null)),
  } satisfies Partial<Handlers>;
});
