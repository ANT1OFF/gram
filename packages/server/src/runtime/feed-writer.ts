// A thread's transcript as it streams: the messages still open, what is stored of them, and the
// live feed subscribers hear. Every function is called with the runtime lock held.

import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as FiberMap from "effect/FiberMap";
import {
  type Runtime,
  feedLocked,
  type InFlight,
  SLOW_PERSIST_MS,
  PERSIST_SPACING,
  openReply,
  locked,
  withDataPart,
  RESUME_MAX_MESSAGES,
  type GetRuntime,
} from "./runtime-state.ts";
import type { LiveFeedEvent, ThreadFeedItem, EventHubShape } from "../events/event-hub.ts";
import {
  type GramUIMessage,
  type TurnEnd,
  type TurnId,
  FEED_WINDOW_TURNS,
  type GramUIMessageChunk,
  type MessageId,
  type ThreadId,
} from "@gram/contracts";
import { chunkOutput } from "../outputs/observed.ts";
import { MessageAccumulator } from "./message-accumulator.ts";
import { randomUUID } from "node:crypto";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import type { NotifyObservers } from "./runtime-observer.ts";
import type { ThreadRuntimesShape } from "./thread-runtimes-shape.ts";

/** How stale a streaming message's search index row may get. */
export const SEARCH_REFRESH_MS = 5_000;

/** The waits between a timed refresh's tries while another connection holds the write lock. */
export const SEARCH_REFRESH_RETRY_MS = [100, 200, 400, 800, 1_600, 3_200] as const;

/** Elapsed time, which a change of the wall clock doesn't move. */
const monotonicMs = Effect.map(Clock.monotonicTimeNanos, (nanos) => Number(nanos / 1_000_000n));

/** What the feed writer reads: the stored transcript, the live feed and the runtime's observers. */
export interface FeedWriterDeps {
  readonly store: ThreadStoreShape;
  readonly hub: EventHubShape;
  readonly notifyObservers: NotifyObservers;
  /** The pending search refreshes, one per message (`persist`); the runtimes' scope stops them. */
  readonly searchRefreshes: FiberMap.FiberMap<string>;
}

/**
 * `chunk` folded into the replay's last item, when both are deltas of one text or reasoning part
 * and neither carries provider metadata: replayed, the one delta reads as the run it stands for.
 * `undefined` when they don't fold.
 */
export const mergedDelta = (
  last: ThreadFeedItem | undefined,
  chunk: GramUIMessageChunk,
): GramUIMessageChunk | undefined => {
  if (chunk.type !== "text-delta" && chunk.type !== "reasoning-delta") return undefined;
  const previous = last?.event.type === "chunk" ? last.event.chunk : undefined;
  if (
    previous?.type !== chunk.type ||
    previous.id !== chunk.id ||
    previous.providerMetadata !== undefined ||
    chunk.providerMetadata !== undefined
  )
    return undefined;
  return { ...chunk, delta: `${previous.delta}${chunk.delta}` };
};

/** The transcript writer `ThreadRuntimes` streams every thread's messages through. */
export const makeFeedWriter = ({
  store,
  hub,
  notifyObservers,
  searchRefreshes,
}: FeedWriterDeps) => {
  const publishFeed = (rt: Runtime, event: LiveFeedEvent) =>
    Effect.suspend(() => {
      const item: ThreadFeedItem = { threadId: rt.threadId, seq: ++rt.seq, event };
      return hub.publishFeed(item).pipe(Effect.as(item));
    });

  /** Stores a whole message and pushes it to live subscribers. */
  const publishMessage = (rt: Runtime, message: GramUIMessage, turnId?: TurnId) =>
    feedLocked(
      rt,
      store
        .upsertMessage(rt.threadId, message, turnId)
        .pipe(Effect.flatMap((rev) => publishFeed(rt, { type: "message", message, rev }))),
    );

  /** Called with the feed lock held. Sends live subscribers the stored feed in place of theirs. */
  const replaceFeed = (rt: Runtime) =>
    Effect.gen(function* () {
      const { messages, earlier } = yield* store.recentMessages(rt.threadId, FEED_WINDOW_TURNS);
      const rev = (yield* store.feedRevision(rt.threadId))?.rev ?? 0;
      // A live replacement follows the subscribe shape: history, (no in-flight replay), caughtUp.
      yield* publishFeed(rt, { type: "messages", messages, ...(earlier ? { earlier } : {}) });
      yield* publishFeed(rt, { type: "caughtUp", rev });
    });

  /** Takes a message no agent got out of the feed. */
  const withdrawMessage = (rt: Runtime, messageId: string) =>
    feedLocked(
      rt,
      Effect.gen(function* () {
        if (yield* store.deleteMessage(rt.threadId, messageId)) yield* replaceFeed(rt);
      }),
    );

  /** When each open message's search index row was last refreshed (`monotonicMs`). */
  const searchIndexedAt = new WeakMap<InFlight, number>();

  /**
   * Refreshes the message's index row at the monotonic deadline `at`, when `SEARCH_REFRESH_MS` has
   * passed since the last one. Outside the feed lock, so a refresh waiting out another connection's
   * write lock holds up no save; one that finds the lock held is tried again after each of
   * `SEARCH_REFRESH_RETRY_MS`.
   */
  const refreshLater = (rt: Runtime, inFlight: InFlight, at: number) =>
    Effect.gen(function* () {
      // A slow save or a delayed fiber start already spent part of the interval.
      const delayMs = Math.max(0, at - (yield* monotonicMs));
      for (const waitMs of [delayMs, ...SEARCH_REFRESH_RETRY_MS]) {
        yield* Effect.sleep(waitMs);
        if (yield* store.refreshSearch(rt.threadId, inFlight.messageId)) {
          searchIndexedAt.set(inFlight, yield* monotonicMs);
          return;
        }
      }
      yield* Effect.logWarning("search: the write lock stayed held; a streaming message waits");
    }).pipe(
      // Left behind, the row is the next save's, the settle's or the startup sweep's to refresh.
      Effect.catchCause((cause) =>
        Effect.logWarning("search: couldn't refresh a streaming message").pipe(
          Effect.annotateLogs({ threadId: rt.threadId, cause: String(cause) }),
        ),
      ),
    );

  /**
   * Re-indexing a long reply for search is most of a save's cost, so a streaming message's index
   * row is refreshed on its first save, then at most every `SEARCH_REFRESH_MS`, and always once it
   * settles: finished, with no tool output still to replace. A save that skips it sets a timer for
   * the rest of that interval, so a reply that pauses mid-stream (a stall, a long tool call) is
   * still indexed by then: search lags what is stored by `SEARCH_REFRESH_MS` at most.
   */
  const persist = (rt: Runtime, inFlight: InFlight) =>
    Effect.gen(function* () {
      const settled = inFlight.finished && inFlight.accumulator.preliminaryTools().length === 0;
      const now = yield* monotonicMs;
      const last = searchIndexedAt.get(inFlight);
      const refresh = settled || last === undefined || now - last >= SEARCH_REFRESH_MS;
      const key = `${rt.threadId} ${inFlight.messageId}`;
      if (refresh) {
        searchIndexedAt.set(inFlight, now);
        yield* FiberMap.remove(searchRefreshes, key);
      }
      const rev = yield* store.upsertMessage(
        rt.threadId,
        inFlight.accumulator.snapshot(),
        inFlight.turnId,
        { streaming: !refresh },
      );
      if (!refresh) {
        yield* FiberMap.run(
          searchRefreshes,
          key,
          refreshLater(rt, inFlight, (last ?? now) + SEARCH_REFRESH_MS),
          { onlyIfMissing: true },
        );
      }
      return rev;
    });

  /** Tells observers of a file `chunk` says the thread produced, if it says so. */
  const noteOutput = (
    rt: Runtime,
    chunk: GramUIMessageChunk,
    toolPart: Parameters<typeof chunkOutput>[1],
  ) => {
    const output = chunkOutput(chunk, toolPart);
    return output === undefined
      ? Effect.void
      : notifyObservers(rt.threadId, "onOutput", (observer) =>
          observer.onOutput?.(rt.threadId, output),
        );
  };

  /** Called with the feed lock held. */
  const appendChunkLocked = (rt: Runtime, messageId: MessageId, incoming: GramUIMessageChunk) =>
    Effect.gen(function* () {
      let chunk = incoming;
      let inFlight = rt.open.get(messageId);
      if (inFlight === undefined) {
        // No agent dates its replies, so the transcript's hover time for one is when it began
        // streaming, stamped on the chunk that opens it so live subscribers see it too.
        if (chunk.type === "start" && chunk.messageMetadata?.createdAt === undefined) {
          chunk = {
            ...chunk,
            messageMetadata: {
              ...chunk.messageMetadata,
              createdAt: yield* Clock.currentTimeMillis,
            },
          };
        }
        const parentToolUseId =
          chunk.type === "start" ? chunk.messageMetadata?.parentToolUseId : undefined;
        inFlight = {
          messageId,
          turnId: rt.turn?.id,
          accumulator: new MessageAccumulator(messageId),
          imageSources: new Set(),
          imageReads: new Map(),
          items: [],
          retainedToolOutput: false,
          parentToolUseId,
          nested: parentToolUseId !== undefined,
          finished: false,
          nextPersistAt: 0,
          unsaved: false,
        };
        rt.open.set(messageId, inFlight);
        if (rt.turn !== undefined && !inFlight.nested) rt.turn.reply = messageId;
      }
      const completed = inFlight.accumulator.apply(chunk);
      if (chunk.type === "finish" || chunk.type === "abort") inFlight.finished = true;
      const folded = inFlight.accumulator;
      yield* noteOutput(rt, chunk, (id) => folded.toolPart(id));
      // Stored before anyone hears of it, or else held in `rt.open`: a client asks
      // `attachment.read` for a file or tool image the moment its part arrives, and that is
      // authorized against the stored messages and `liveMessages`.
      if (completed && (inFlight.finished || performance.now() >= inFlight.nextPersistAt)) {
        const started = performance.now();
        yield* persist(rt, inFlight);
        const tookMs = performance.now() - started;
        inFlight.unsaved = false;
        inFlight.nextPersistAt =
          tookMs < SLOW_PERSIST_MS ? 0 : performance.now() + tookMs * PERSIST_SPACING;
      } else if (completed) {
        inFlight.unsaved = true;
      }
      if (chunk.type === "tool-output-available" && chunk.preliminary === true)
        inFlight.retainedToolOutput = true;
      if (
        inFlight.retainedToolOutput &&
        (chunk.type === "tool-output-available" ||
          chunk.type === "tool-output-error" ||
          chunk.type === "tool-output-denied")
      ) {
        // Each snapshot replaces the same tool's output. Replaying superseded snapshots costs
        // quadratic space in the output length; keep only the newest at its original sequence.
        for (let i = inFlight.items.length - 1; i >= 0; i--) {
          const previous = inFlight.items[i]!;
          const event = previous.event;
          if (
            event.type === "chunk" &&
            event.chunk.type === "tool-output-available" &&
            event.chunk.preliminary === true &&
            event.chunk.toolCallId === chunk.toolCallId
          )
            inFlight.items.splice(i, 1);
          else if (event.type === "chunk" && event.chunk.type === "finish") {
            // Reconnect can interleave between this output and its follow-up finish. Keep the
            // previous finish's metadata without closing a fold before the newest output.
            const metadata = event.chunk.messageMetadata;
            if (metadata === undefined) inFlight.items.splice(i, 1);
            else
              inFlight.items[i] = {
                ...previous,
                event: {
                  type: "chunk",
                  messageId,
                  chunk: { type: "message-metadata", messageMetadata: metadata },
                },
              };
          }
        }
      }
      let replayChunk = chunk;
      if (inFlight.retainedToolOutput && chunk.type === "finish") {
        // One finish closes the replay. Carry accumulated metadata onto it so removing an older
        // finish loses no metadata and never reopens an empty fold halfway through reconnect.
        for (let i = inFlight.items.length - 1; i >= 0; i--) {
          const event = inFlight.items[i]!.event;
          if (
            event.type === "chunk" &&
            (event.chunk.type === "finish" || event.chunk.type === "message-metadata")
          )
            inFlight.items.splice(i, 1);
        }
        const metadata = inFlight.accumulator.snapshot().metadata;
        replayChunk = {
          ...chunk,
          ...(metadata === undefined ? {} : { messageMetadata: metadata }),
        };
      }
      const published = yield* publishFeed(rt, { type: "chunk", messageId, chunk });
      const merged = mergedDelta(inFlight.items.at(-1), replayChunk);
      if (merged !== undefined) {
        // One replay item per run of a part's deltas, not one per delta: a long reply's replay
        // grows with its text, not with how finely the agent streamed it.
        inFlight.items[inFlight.items.length - 1] = {
          ...published,
          event: { type: "chunk", messageId, chunk: merged },
        };
      } else {
        inFlight.items.push(
          replayChunk === chunk
            ? published
            : { ...published, event: { type: "chunk", messageId, chunk: replayChunk } },
        );
      }
      if (
        inFlight.retainedToolOutput &&
        !inFlight.nested &&
        (chunk.type === "finish" || chunk.type === "abort") &&
        inFlight.accumulator.preliminaryTools().length === 0
      )
        rt.open.delete(messageId);
    });

  /**
   * Stores every open message holding a completed part it skipped. A background subagent's
   * transcript outlives its turn, so a session that ends between turns ends no turn that would.
   */
  const flushUnsaved = (rt: Runtime) =>
    feedLocked(
      rt,
      Effect.gen(function* () {
        for (const inFlight of rt.open.values()) {
          if (!inFlight.unsaved) continue;
          yield* persist(rt, inFlight);
          inFlight.unsaved = false;
        }
      }),
    );

  const appendChunk = (rt: Runtime, messageId: MessageId, chunk: GramUIMessageChunk) =>
    feedLocked(rt, appendChunkLocked(rt, messageId, chunk));

  const appendDataPart = (rt: Runtime, chunk: GramUIMessageChunk) =>
    Effect.gen(function* () {
      const reply = openReply(rt);
      if (reply !== undefined) {
        yield* appendChunk(rt, reply.messageId, chunk);
        return reply.messageId;
      }
      const messageId = `app-${randomUUID()}` as MessageId;
      const accumulator = new MessageAccumulator(messageId);
      const createdAt = yield* Clock.currentTimeMillis;
      accumulator.apply({ type: "start", messageId, messageMetadata: { createdAt } });
      accumulator.apply(chunk);
      yield* publishMessage(rt, accumulator.snapshot());
      yield* noteOutput(rt, chunk, () => undefined);
      return messageId;
    });

  /** Finishes and stores every message still streaming, as a turn's end does. */
  const closeOpenMessages = (rt: Runtime) =>
    feedLocked(
      rt,
      Effect.gen(function* () {
        for (const inFlight of rt.open.values()) {
          // Close a reply the adapter never finished, so clients stop showing it as streaming. A
          // subagent transcript stays open: a background subagent streams on after the turn.
          if (!inFlight.finished && !inFlight.nested) {
            yield* appendChunkLocked(rt, inFlight.messageId, { type: "finish" });
          }
          yield* persist(rt, inFlight);
          inFlight.unsaved = false;
          // Codex unified exec can exit after its parent reply finishes. Keep that accumulator
          // until its authoritative output arrives, so it updates the original stored card.
          if (inFlight.finished && inFlight.accumulator.preliminaryTools().length === 0)
            rt.open.delete(inFlight.messageId);
        }
      }),
    );

  /**
   * Stamps how a turn ended on its reply. A whole-message write: the stored row keeps its place, and
   * unlike a chunk it doesn't read as the reply streaming again. Only the transcript hears of it.
   */
  const stampTurnEnd = (rt: Runtime, messageId: MessageId, turnEnd: TurnEnd) =>
    feedLocked(
      rt,
      Effect.gen(function* () {
        // A reply held for a tool's late output is saved from here again, so that keeps it too.
        rt.open.get(messageId)?.accumulator.apply({
          type: "message-metadata",
          messageMetadata: { turnEnd },
        });
        const reply = yield* store.getMessage(rt.threadId, messageId);
        if (reply === undefined) return;
        const message = { ...reply, metadata: { ...reply.metadata, turnEnd } };
        const rev = yield* store.upsertMessage(rt.threadId, message);
        yield* publishFeed(rt, { type: "message", message, rev });
      }),
    );

  /**
   * Finishes and stores every subagent transcript still streaming, for a session that is gone and
   * took its background subagents with it: left open, the next session's replay would show each
   * stopped subagent running for good.
   */
  const closeLanes = (rt: Runtime) =>
    feedLocked(
      rt,
      Effect.gen(function* () {
        for (const inFlight of rt.open.values()) {
          if (!inFlight.nested) continue;
          if (!inFlight.finished) {
            yield* appendChunkLocked(rt, inFlight.messageId, { type: "finish" });
          }
          yield* persist(rt, inFlight);
          inFlight.unsaved = false;
          rt.open.delete(inFlight.messageId);
        }
      }),
    );

  return {
    publishMessage,
    replaceFeed,
    withdrawMessage,
    appendChunkLocked,
    flushUnsaved,
    appendChunk,
    appendDataPart,
    closeOpenMessages,
    stampTurnEnd,
    closeLanes,
  };
};

/** What `makeFeedWriter` gives the rest of `ThreadRuntimes`. */
export type FeedWriter = ReturnType<typeof makeFeedWriter>;

/** What the feed's `ThreadRuntimes` methods read beside the stored transcript. */
export interface FeedMethodsDeps {
  readonly store: ThreadStoreShape;
  readonly runtimes: ReadonlyMap<ThreadId, Runtime>;
  readonly getRuntime: GetRuntime;
  readonly appendChunk: FeedWriter["appendChunk"];
  readonly appendDataPart: FeedWriter["appendDataPart"];
  readonly publishMessage: FeedWriter["publishMessage"];
}

/** The `ThreadRuntimes` methods that read a thread's transcript or add to it. */
export const makeFeedMethods = ({
  store,
  runtimes,
  getRuntime,
  appendChunk,
  appendDataPart,
  publishMessage,
}: FeedMethodsDeps): Pick<
  ThreadRuntimesShape,
  "emitChunk" | "updateDataPart" | "replay" | "liveMessages" | "history"
> => ({
  emitChunk: (threadId, chunk) =>
    getRuntime(threadId).pipe(Effect.flatMap((rt) => locked(rt, appendDataPart(rt, chunk)))),
  updateDataPart: (threadId, messageId, chunk) =>
    Effect.gen(function* () {
      const rt = yield* getRuntime(threadId);
      yield* locked(
        rt,
        Effect.gen(function* () {
          const open = rt.open.get(messageId as MessageId);
          if (open !== undefined) return yield* appendChunk(rt, open.messageId, chunk);
          const message = yield* store.getMessage(threadId, messageId);
          if (message !== undefined) yield* publishMessage(rt, withDataPart(message, chunk));
        }),
      );
    }),
  replay: (threadId, afterRev, from) =>
    Effect.gen(function* () {
      const rt = yield* getRuntime(threadId);
      // Not `locked`: a thread opened as its turn starts or ends would wait out the turn's git
      // checkpoint, which took seconds with the sweep running.
      return yield* feedLocked(
        rt,
        Effect.gen(function* () {
          // Every write to the thread's messages holds the feed lock, so the revision and the
          // rows read under it agree.
          const revision = yield* store.feedRevision(threadId);
          const since =
            afterRev !== undefined &&
            revision !== undefined &&
            afterRev >= revision.resetRev &&
            afterRev <= revision.rev
              ? yield* store.messagesSince(threadId, afterRev, RESUME_MAX_MESSAGES, from)
              : undefined;
          const recent =
            since === undefined
              ? yield* store.recentMessages(threadId, FEED_WINDOW_TURNS)
              : undefined;
          const messages = since ?? recent!.messages;
          return {
            messages: messages.filter((m) => !rt.open.has(m.id as MessageId)),
            ...(since === undefined ? {} : { resumed: true }),
            ...(recent?.earlier === true ? { earlier: true } : {}),
            inFlight: [...rt.open.values()]
              .flatMap((inFlight) => inFlight.items)
              .toSorted((a, b) => a.seq - b.seq),
            lastSeq: rt.seq,
            rev: revision?.rev ?? 0,
          };
        }),
      );
    }),
  liveMessages: (threadId) =>
    Effect.sync(() => {
      const rt = runtimes.get(threadId);
      return rt === undefined
        ? []
        : [...rt.open.values()].map((inFlight) => inFlight.accumulator.snapshot());
    }),
  history: (threadId, before) =>
    getRuntime(threadId).pipe(
      Effect.andThen(store.recentMessages(threadId, FEED_WINDOW_TURNS, before)),
    ),
});
