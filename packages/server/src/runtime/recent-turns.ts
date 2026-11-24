import * as Effect from "effect/Effect";
import { fromStoredMessages } from "../orchestration/transcripts.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import type { Runtime } from "./runtime-state.ts";
import { HANDOFF_TURNS_TOKENS, renderRecentTurns } from "./switch-handoff.ts";

/** How many of a thread's last messages a session that lost its conversation is given from. */
export const LOST_SESSION_MESSAGES = 200;

/**
 * A thread's recent turns as a session that doesn't have its conversation reads them, or
 * `undefined` when there are none. Input not yet sent to an agent (the queue, a launch, an input on
 * its way) is left out: it follows as itself. Reads the last `LOST_SESSION_MESSAGES` messages and
 * the first, never all.
 */
export const recentTurnsOf = (
  store: Pick<ThreadStoreShape, "listQueue" | "lastMessages" | "firstMessages">,
  rt: Pick<Runtime, "threadId" | "launch" | "inFlight">,
) =>
  Effect.gen(function* () {
    const unsent = new Set<string>(
      (yield* store.listQueue(rt.threadId)).map((item) => item.id as string),
    );
    for (const item of [rt.launch, rt.inFlight]) if (item !== undefined) unsent.add(item.id);
    const last = yield* store.lastMessages(rt.threadId, LOST_SESSION_MESSAGES);
    const first = yield* store.firstMessages(rt.threadId, 1);
    const messages = [
      ...first.filter((message) => !last.some((each) => each.id === message.id)),
      ...last,
    ].filter((message) => !unsent.has(message.id));
    const turns = renderRecentTurns(
      fromStoredMessages(messages.map((message, seq) => ({ seq, message }))),
      HANDOFF_TURNS_TOKENS,
      "this thread",
    );
    return turns.kept === 0 ? undefined : turns.text;
  });
