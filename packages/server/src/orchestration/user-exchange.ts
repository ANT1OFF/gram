// Whether the user is in the middle of an exchange with a thread: it is running a turn that the
// user's own typed message opened, or that they steered into. A message from the orchestration
// then waits its turn behind them rather than cutting in; it is never refused for it.

import { type GramUIMessage, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { findUserMessages, type ThreadStoreShape } from "../persistence/thread-store.ts";

/** A message the user typed: not another thread's (`data-thread-origin`), and not Gram's own. */
export const typedByUser = (message: GramUIMessage): boolean =>
  message.metadata?.author !== "server" &&
  !message.parts.some(
    (part) =>
      part.type === "data-thread-origin" ||
      part.type === "data-orchestration-digest" ||
      part.type === "data-idle-compact" ||
      part.type === "data-human-review-notice" ||
      part.type === "data-review-notice",
  );

/**
 * Whether `threadId`, `running` now, is answering what the user typed: its newest user message is
 * theirs. Reads one message; a thread at rest never is.
 */
export const userMidExchange = (
  store: Pick<ThreadStoreShape, "userMessagePage">,
  threadId: ThreadId,
  running: boolean,
): Effect.Effect<boolean> =>
  running
    ? findUserMessages(store, threadId, { from: "newest", count: 1 }).pipe(
        Effect.map((newest) => newest.length > 0 && typedByUser(newest.at(-1)!)),
      )
    : Effect.succeed(false);
