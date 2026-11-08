import type { AgentEvent } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Pull from "effect/Pull";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

/** An agent event numbered in the order its session emitted it, from 1. */
export interface SequencedEvent {
  readonly seq: number;
  readonly event: AgentEvent;
}

/**
 * A session's events, numbered and kept until their consumer confirms them. A consumer that stops
 * and subscribes again picks up after the last event it confirmed, so nothing it had not yet
 * handled is lost. In one process that is a reconnecting subscriber; across machines it is the
 * replay a host sends after a dropped connection.
 */
export interface EventLog {
  /**
   * The events after `afterSeq` (by default after the last confirmed one): those still kept, then
   * each new one as it comes. Ends once the session's events have ended and every one was sent.
   */
  subscribe(afterSeq?: number): Stream.Stream<SequencedEvent>;
  /** Confirms every event up to `seq`, which the log then lets go. A lower `seq` changes nothing. */
  ack(seq: number): Effect.Effect<void>;
  /** The highest confirmed `seq`, 0 before any. */
  readonly acked: Effect.Effect<number>;
}

/**
 * Numbers `source` and keeps each event until it is confirmed. The log reads the source only when a
 * subscriber asks for the next event, in that subscriber's fiber, so it adds no fiber or buffer of
 * its own: events are handled exactly when they were before, and a consumer that stops reading
 * holds the session back. What it keeps is only what was read and not yet confirmed.
 */
export const sequenceEvents = (
  source: Stream.Stream<AgentEvent>,
): Effect.Effect<EventLog, never, Scope.Scope> =>
  Effect.gen(function* () {
    const pull = yield* Stream.toPull(source);
    /** One reader of `source` at a time, so two subscribers can't number a chunk twice. */
    const reading = yield* Semaphore.make(1);
    /** Read and not yet confirmed, oldest first; `kept[i].seq === acked + 1 + i`. */
    let kept: Array<SequencedEvent> = [];
    let acked = 0;
    let last = 0;
    let ended = false;

    /** Reads the next chunk into `kept`, unless another reader already moved the log on. */
    const readMore = (seen: number) =>
      reading.withPermits(1)(
        Effect.suspend(() => {
          if (ended || last > seen) return Effect.void;
          return pull.pipe(
            Effect.map((chunk) => {
              for (const event of chunk) kept.push({ seq: ++last, event });
            }),
            Pull.catchDone(() =>
              Effect.sync(() => {
                ended = true;
              }),
            ),
          );
        }),
      );

    /** The next event after `cursor`, reading one if needed; undefined once there will be none. */
    const after = (cursor: number): Effect.Effect<SequencedEvent | undefined> =>
      Effect.suspend(() => {
        // Confirmed events are gone; a cursor behind them resumes at the oldest kept one.
        const next = kept[Math.max(0, cursor - acked)];
        if (next !== undefined) return Effect.succeed(next);
        if (ended) return Effect.succeed(undefined);
        return readMore(last).pipe(Effect.andThen(after(cursor)));
      });

    return {
      subscribe: (afterSeq) =>
        Stream.suspend(() =>
          Stream.unfold(afterSeq ?? acked, (cursor) =>
            after(cursor).pipe(
              Effect.map((next) => (next === undefined ? undefined : ([next, next.seq] as const))),
            ),
          ),
        ),
      ack: (seq) =>
        Effect.sync(() => {
          const upTo = Math.min(seq, last);
          if (upTo <= acked) return;
          kept = kept.slice(upTo - acked);
          acked = upTo;
        }),
      acked: Effect.sync(() => acked),
    } satisfies EventLog;
  });
