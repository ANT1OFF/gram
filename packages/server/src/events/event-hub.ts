import { type ServerEvent, type ThreadFeedEvent, type ThreadId, waitsFor } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { signedInPerson } from "../embedding/person.ts";
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

/**
 * What only the server's own consumers hear (`ownEvents`), never a window: a stored message that
 * is whole, or a thread whose stored messages were all written at once.
 */
export type OwnEvent =
  /**
   * `messageId` was stored and isn't streaming: a person's message or another written whole, or a
   * reply once it finished (`runtime/feed-writer.ts`).
   */
  | { readonly type: "message.settled"; readonly threadId: ThreadId; readonly messageId: string }
  /** Every message the thread holds was put there together: a fork's copies, a reopened history. */
  | { readonly type: "messages.replaced"; readonly threadId: ThreadId };

const OWN_TYPES: ReadonlySet<string> = new Set(["message.settled", "messages.replaced"]);

/** Whether an `ownEvents` item is one only the server's own consumers hear. */
export const isOwnEvent = (event: ServerEvent | OwnEvent): event is OwnEvent =>
  OWN_TYPES.has(event.type);

export interface EventHubShape {
  publish(event: ServerEvent): Effect.Effect<void>;
  /** Tells the `ownEvents` streams, in order with what `publish` tells them, and no window. */
  publishOwn(event: OwnEvent): Effect.Effect<void>;
  /**
   * `event` to the clients `serverEvents` was opened for `person`, and to nobody else: what is one
   * person's own (a change to their own settings). The server's own consumers don't see it.
   */
  publishTo(person: string, event: ServerEvent): Effect.Effect<void>;
  publishFeed(item: ThreadFeedItem): Effect.Effect<void>;
  /**
   * Subscribes, then emits `snapshot` (one event, or several in order), then live events. A client
   * that falls behind past its buffer gets a fresh `snapshot` in place of the backlog it missed.
   */
  serverEvents(
    snapshot: Effect.Effect<ServerEvent | ReadonlyArray<ServerEvent>>,
    /** Whose connection this is, for `publishTo`. */
    person?: string,
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
  /** `internalEvents`, with what `publishOwn` tells in its place among them. */
  ownEvents(
    select: (event: ServerEvent | OwnEvent) => boolean,
    name?: string,
  ): Stream.Stream<ServerEvent | OwnEvent>;
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
  /** Whose connection this is, where the subscriber said. */
  readonly person?: string | undefined;
  readonly buffer: ClientBuffer<I>;
  /**
   * Tells the client's stream its buffer has something to take. A PubSub, not a Queue, so a waiting
   * stream sees the item on the publisher's turn; sliding at 1, since only the latest wake matters.
   */
  readonly wake: PubSub.PubSub<true>;
}

/**
 * `event` as the connections opened for `person` are sent it: Waiting on you holds a signed-in
 * person's own items and the ones for anyone (`waitsFor`), wherever the items came from. The same
 * event when nothing of it is another person's, which is always so where nobody signs in.
 */
export const eventFor = (event: ServerEvent, person: string | undefined): ServerEvent => {
  const reader = signedInPerson(person);
  if (reader === undefined) return event;
  if (event.type === "thread.waits") {
    const waits = waitsFor(event.waits, reader);
    const helperResolved =
      event.helperResolved === undefined ? undefined : waitsFor(event.helperResolved, reader);
    if (waits === event.waits && helperResolved === event.helperResolved) return event;
    return {
      type: "thread.waits",
      threadId: event.threadId,
      waits,
      ...(helperResolved === undefined || helperResolved.length === 0 ? {} : { helperResolved }),
    };
  }
  if (event.type === "threads.snapshot") {
    let changed = false;
    const threads = event.threads.map((summary) => {
      const waits = summary.waits === undefined ? undefined : waitsFor(summary.waits, reader);
      const helperResolved =
        summary.helperResolved === undefined ? undefined : waitsFor(summary.helperResolved, reader);
      if (waits === summary.waits && helperResolved === summary.helperResolved) return summary;
      changed = true;
      const { waits: _, helperResolved: __, ...rest } = summary;
      return {
        ...rest,
        ...(waits === undefined || waits.length === 0 ? {} : { waits }),
        ...(helperResolved === undefined || helperResolved.length === 0 ? {} : { helperResolved }),
      };
    });
    return changed ? { type: "threads.snapshot", threads } : event;
  }
  return event;
};

/**
 * Publishing writes straight into each client's bounded buffer, so there's no per-client backlog
 * anywhere else. Suspended, so a publish effect built ahead of time reaches the clients registered
 * when it runs rather than when it was built.
 */
const deliver = <I>(
  clients: ReadonlySet<Client<I>>,
  item: I,
  reaches: (client: Client<I>) => boolean = () => true,
) =>
  Effect.suspend(() =>
    Effect.forEach(
      [...clients],
      (client) =>
        reaches(client) && client.accept(item)
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
    readonly person?: string | undefined;
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
        person: options.person,
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
      const internalClients = new Set<
        (event: ServerEvent | OwnEvent) => Effect.Effect<void> | undefined
      >();
      const feedClients = new Set<Client<ThreadFeedItem>>();
      const serverEventCapacity = options.serverEventCapacity ?? 1_000;
      const feedCapacity = options.feedCapacity ?? 10_000;

      const ownEvents = (
        select: (event: ServerEvent | OwnEvent) => boolean,
        name = "internal events",
      ): Stream.Stream<ServerEvent | OwnEvent> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const queue = yield* Queue.unbounded<ServerEvent | OwnEvent>();
            const gauge = new BacklogGauge(name);
            const offer = (event: ServerEvent | OwnEvent) => {
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

      /** Offers `event` to every internal stream; the log lines their backlogs are owed. */
      const offerInternal = (event: ServerEvent | OwnEvent) => {
        const logs: Array<Effect.Effect<void>> = [];
        for (const offer of internalClients) {
          const log = offer(event);
          if (log !== undefined) logs.push(log);
        }
        return logs;
      };

      return EventHub.of({
        publish: (event) =>
          Effect.suspend(() => {
            const logs = offerInternal(event);
            const delivered = deliver(eventClients, event);
            return logs.length === 0 ? delivered : Effect.andThen(Effect.all(logs), delivered);
          }),
        publishOwn: (event) =>
          Effect.suspend(() => Effect.all(offerInternal(event), { discard: true })),
        publishTo: (person, event) =>
          deliver(eventClients, event, (client) => client.person === person),
        publishFeed: (item) => deliver(feedClients, item),

        serverEvents: (snapshot, person) => {
          const head = snapshot.pipe(
            Effect.map((events): ReadonlyArray<ServerEvent> =>
              ("type" in events ? [events] : events).map((event) => eventFor(event, person)),
            ),
          );
          return clientStream(eventClients, {
            buffer: new ClientBuffer(serverEventCapacity, serverEventKey, serverEventOrder),
            accept: () => true,
            person,
            start: head,
            emit: (event) => eventFor(event, person),
            resync: head,
          });
        },

        // One body for both overloads: what reaches the queue passed `select`, guard or not.
        internalEvents: ((select: (event: ServerEvent) => boolean, name?: string) =>
          ownEvents(
            (event) => !isOwnEvent(event) && select(event),
            name,
          )) as EventHubShape["internalEvents"],
        ownEvents,

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
