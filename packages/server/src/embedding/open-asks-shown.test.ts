// A `sink.started` that lists the cards open now lists each with its key, so a relay that picks up
// from it can answer one naming the card (`asks/answer`'s `shown`).

import { describe, expect, it } from "@effect/vitest";
import type { RequestId, SinkBatch, SinkEvent } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { ThreadStore } from "../persistence/thread-store.ts";
import {
  endpoint,
  eventually,
  serverLayer,
  sessionOf,
  setHosted,
  startThread,
} from "./acceptance-harness.ts";

describe("the sink's opening snapshot", () => {
  it.live("lists each open card with its key", () =>
    Effect.gen(function* () {
      const held: Array<SinkEvent> = [];
      const sink = yield* endpoint<SinkBatch>((batch) => {
        for (const event of batch.events) if (event.seq === held.length + 1) held.push(event);
        return { json: { ack: held.length } };
      });
      yield* Effect.gen(function* () {
        const store = yield* ThreadStore;
        // Off while the card goes up, so turning it on sends a snapshot that lists it.
        const thread = yield* startThread("look /approve{echo hi}");
        const card = yield* eventually(
          "the card",
          store.listRequests(thread.id).pipe(Effect.map((requests) => requests[0])),
        );
        yield* sessionOf(thread.id);
        expect(card.shown).toBeDefined();
        yield* setHosted(true);
        const started = yield* eventually(
          "the turn-on's snapshot",
          Effect.sync(() =>
            held.find(
              (event) =>
                event.type === "sink.started" &&
                Array.isArray(event.data["openAsks"]) &&
                event.data["openAsks"].length > 0,
            ),
          ),
        );
        expect(started.data["openAsks"]).toEqual([{ id: card.id as RequestId, shown: card.shown }]);
      }).pipe(Effect.provide(serverLayer(undefined, sink.url)));
    }),
  );
});
