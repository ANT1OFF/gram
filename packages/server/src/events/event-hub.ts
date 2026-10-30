import type { ServerEvent, ThreadFeedEvent, ThreadId } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { BacklogGauge } from "./backlog.ts";
import { ClientBuffer, serverEventKey, serverEventOrder } from "./client-buffer.ts";

/** The live part of a thread feed: in-flight chunks and whole-message upserts. */
export type LiveFeedEvent = Extract<
  ThreadFeedEvent,
  { type: "chunk" | "message" | "messages" | "caughtUp" }
>;

/** A live feed event of one thread. `seq` is monotonic per thread. */
export interface ThreadFeedItem {
  readonly threadId: ThreadId;
  readonly seq: number;
  readonly event: LiveFeedEvent;
}

/** What `thread.subscribe` replays before going live. */
export interface ThreadReplay {
  readonly messages: ThreadFeedEvent extends infer E
    ? E extends { type: "messages"; messages: infer M }
      ? M
      : never
    : never;
  /** `messages` holds only what changed since the `afterRev` asked for, sent as `resumed`. */
  readonly resumed?: boolean | undefined;
  /** The thread has older messages than the window `messages` holds. */
  readonly earlier?: boolean | undefined;
  /** The in-flight message from its first chunk. */
  readonly inFlight: ReadonlyArray<ThreadFeedItem>;
  /** The highest `seq` the replay covers; live items at or below it are duplicates. */
  readonly lastSeq: number;
  /** The thread's feed revision the stored messages were read at, sent with `caughtUp`. */
  readonly rev: number;
}

/** The `internalEvents` selector for a thread's removal, which most server cleanup waits on. */
export const isThreadRemoved = (
  event: ServerEvent,
): event is Extract<ServerEvent, { type: "thread.removed" }> => event.type === "thread.removed";

export interface EventHubShape {
  publish(event: ServerEvent): Effect.Effect<void>;
  publishFeed(item: ThreadFeedItem): Effect.Effect<void>;
  /**
   * Subscribes, then emits `snapshot` (one event, or several in order), then live events. A client
   * that falls behind past its buffer gets a fresh `snapshot` in place of the backlog it missed.
   */
  serverEvents(
    snapshot: Effect.Effect<ServerEvent | ReadonlyArray<ServerEvent>>,
  ): Stream.Stream<ServerEvent>;
  /**
   * Every event published while the stream runs that `select` keeps, in order, none ever dropped:
   * for the server's own consumers, whose cleanup a snapshot can't redo. Unbounded behind a slow
   * consumer, so `select` keeps rare events, or the consumer only hands them on. A backlog past
   * `BACKLOG_LOG_FLOOR` is logged under `name`.
   */
  internalEvents<A extends ServerEvent>(
    select: (event: ServerEvent) => event is A,
    name?: string,
  ): Stream.Stream<A>;
  internalEvents(
    select: (event: ServerEvent) => boolean,
    name?: string,
  ): Stream.Stream<ServerEvent>;
  /**
   * Subscribes before running `replay`, so items published while the replay is read are buffered
   * rather than lost, then emits stored messages, the in-flight replay, `caughtUp`, and live items.
   * A client that falls behind past its buffer gets `resync`'s replay and `caughtUp` instead, which
   * must be a full one: what it was sent since `replay` is not known.
   */
  threadFeed<E>(
    threadId: ThreadId,
    replay: Effect.Effect<ThreadReplay, E>,
    resync?: Effect.Effect<ThreadReplay, E>,
  ): Stream.Stream<ThreadFeedEvent, E>;
}

export interface EventHubOptions {
  /** Server events one client may have queued before full-state events coalesce or it resyncs. */
  readonly serverEventCapacity?: number;
  /** Feed items one client may have queued before it resyncs. */
  readonly feedCapacity?: number;
}

interface Client<I> {
  readonly accept: (item: I) => boolean;
  readonly buffer: ClientBuffer<I>;
  /**
   * Tells the client's stream its buffer has something to take. A PubSub, not a Queue, so a waiting
   * stream sees the item on the publisher's turn; sliding at 1, since only the latest wake matters.
   */
  readonly wake: PubSub.PubSub<true>;
}

/**
 * Publishing writes straight into each client's bounded buffer, so there's no per-client backlog
 * anywhere else. Suspended, so a publish effect built ahead of time reaches the clients registered
 * when it runs rather than when it was built.
 */
const deliver = <I>(clients: ReadonlySet<Client<I>>, item: I) =>
  Effect.suspend(() =>
    Effect.forEach(
      [...clients],
      (client) =>
        client.accept(item)
          ? Effect.sync(() => client.buffer.offer(item)).pipe(
              Effect.andThen(PubSub.publish(client.wake, true)),
            )
          : Effect.void,
      { discard: true },
    ),
  );

/**
 * A client registered for the stream's lifetime before `start` runs, so nothing published meanwhile
 * is missed. Emits `start`'s events, then whatever each wake finds buffered, with `resync`'s events
 * in place of a backlog an overflow dropped.
 */
const clientStream = <I, A, E>(
  clients: Set<Client<I>>,
  options: {
    readonly buffer: ClientBuffer<I>;
    readonly accept: (item: I) => boolean;
    readonly start: Effect.Effect<Iterable<A>, E>;
    /** The event to send for `item`, or `undefined` to skip it; applied when it's taken. */
    readonly emit: (item: I) => A | undefined;
    readonly resync: Effect.Effect<Iterable<A>, E>;
  },
): Stream.Stream<A, E> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const client: Client<I> = {
        accept: options.accept,
        buffer: options.buffer,
        wake: yield* PubSub.sliding<true>(1),
      };
      const wakes = yield* PubSub.subscribe(client.wake);
      yield* Effect.acquireRelease(
        Effect.sync(() => clients.add(client)),
        () => Effect.sync(() => clients.delete(client)),
      );
      const head = yield* options.start;
      const live = Stream.fromSubscription(wakes).pipe(
        Stream.mapEffect(() =>
          Effect.gen(function* () {
            const { items, overflowed } = client.buffer.take();
            const events: Array<A> = overflowed ? [...(yield* options.resync)] : [];
            for (const item of items) {
              const event = options.emit(item);
              if (event !== undefined) events.push(event);
            }
            return events;
          }),
        ),
        Stream.flattenIterable,
      );
      return Stream.concat(Stream.fromIterable(head), live);
    }),
  );

export class EventHub extends Context.Service<EventHub, EventHubShape>()("@gram/server/EventHub") {
  static readonly layerWith = (options: EventHubOptions = {}): Layer.Layer<EventHub> =>
    Layer.sync(EventHub, () => {
      const eventClients = new Set<Client<ServerEvent>>();
      /**
       * Each `internalEvents` stream's offer, which queues only what it selects, and returns the log
       * line its backlog is owed, if any.
       */
      const internalClients = new Set<(event: ServerEvent) => Effect.Effect<void> | undefined>();
      const feedClients = new Set<Client<ThreadFeedItem>>();
      const serverEventCapacity = options.serverEventCapacity ?? 1_000;
      const feedCapacity = options.feedCapacity ?? 10_000;

      const internalEvents = (
        select: (event: ServerEvent) => boolean,
        name = "internal events",
      ): Stream.Stream<ServerEvent> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const queue = yield* Queue.unbounded<ServerEvent>();
            const gauge = new BacklogGauge(name);
            const offer = (event: ServerEvent) => {
              if (!select(event)) return undefined;
              Queue.offerUnsafe(queue, event);
              return gauge.observe(Queue.sizeUnsafe(queue));
            };
            yield* Effect.acquireRelease(
              Effect.sync(() => internalClients.add(offer)),
              () => Effect.sync(() => internalClients.delete(offer)),
            );
            // One at a time rather than `fromQueue`'s batches, so the depth read after a take is what
            // the consumer has yet to handle, and a backlog's drain is logged as it happens.
            return Stream.fromEffectRepeat(
              Queue.take(queue).pipe(
                Effect.tap(() => gauge.observe(Queue.sizeUnsafe(queue)) ?? Effect.void),
              ),
            );
          }),
        );

      return EventHub.of({
        publish: (event) =>
          Effect.suspend(() => {
            const logs: Array<Effect.Effect<void>> = [];
            for (const offer of internalClients) {
              const log = offer(event);
              if (log !== undefined) logs.push(log);
            }
            const delivered = deliver(eventClients, event);
            return logs.length === 0 ? delivered : Effect.andThen(Effect.all(logs), delivered);
          }),
        publishFeed: (item) => deliver(feedClients, item),

        serverEvents: (snapshot) => {
          const head = snapshot.pipe(
            Effect.map((events): ReadonlyArray<ServerEvent> =>
              "type" in events ? [events] : events,
            ),
          );
          return clientStream(eventClients, {
            buffer: new ClientBuffer(serverEventCapacity, serverEventKey, serverEventOrder),
            accept: () => true,
            start: head,
            emit: (event) => event,
            resync: head,
          });
        },

        // One body for both overloads: what reaches the queue passed `select`, guard or not.
        internalEvents: internalEvents as EventHubShape["internalEvents"],

        threadFeed: (threadId, replay, resync = replay) => {
          let lastSeq = 0;
          const headOf = (current: ThreadReplay): Array<ThreadFeedEvent> => {
            lastSeq = current.lastSeq;
            return [
              current.resumed === true
                ? { type: "resumed", messages: current.messages }
                : {
                    type: "messages",
                    messages: current.messages,
                    ...(current.earlier === true ? { earlier: true } : {}),
                  },
              ...current.inFlight.map((item) => item.event),
              { type: "caughtUp", rev: current.rev },
            ];
          };
          return clientStream(feedClients, {
            buffer: new ClientBuffer<ThreadFeedItem>(feedCapacity),
            accept: (item) => item.threadId === threadId,
            start: replay.pipe(Effect.map(headOf)),
            emit: (item) => (item.seq > lastSeq ? item.event : undefined),
            resync: resync.pipe(Effect.map(headOf)),
          });
        },
      });
    });

  static readonly layer: Layer.Layer<EventHub> = EventHub.layerWith();
}
