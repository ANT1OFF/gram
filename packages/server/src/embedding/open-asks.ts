// The cards open now, as a `sink.started` that isn't the server's start lists them.

import * as Effect from "effect/Effect";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";

/** A card open now, as `sink.started` lists it: its id, and its key where it has one. */
export interface OpenAsk {
  readonly id: string;
  readonly shown?: string;
}

/** Every thread's open cards, each with its key, for a relay to answer naming the card. */
export const openAsksOf = (
  store: Pick<ThreadStoreShape, "listThreads" | "listRequests">,
): Effect.Effect<ReadonlyArray<OpenAsk>> =>
  store.listThreads.pipe(
    Effect.flatMap(Effect.forEach((thread) => store.listRequests(thread.id), { concurrency: 8 })),
    Effect.map((lists) =>
      lists
        .flat()
        .map((request) =>
          request.shown === undefined
            ? { id: request.id }
            : { id: request.id, shown: request.shown },
        ),
    ),
  );
