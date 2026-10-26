import {
  HELPER_RESOLVE_UNDO_MS,
  MAX_OPEN_WAITS,
  NotFound,
  WaitId,
  waitData,
  waitIsKept,
  type MessageId,
  type GramUIMessageChunk,
  type ThreadId,
  type ThreadNotFound,
  type WaitItem,
  type WaitKind,
  type WaitListState,
  type WaitSource,
  waitNoteText,
} from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { randomUUID } from "node:crypto";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore, type WaitResolution } from "../persistence/thread-store.ts";

/** What an item is made of, as whoever adds it writes it; plain and within limits already. */
export interface WaitDraft {
  readonly kind: WaitKind;
  readonly title: string;
  readonly body?: string | undefined;
  readonly copy?: string | undefined;
  readonly link?: string | undefined;
  /** An open item of the thread to update in place rather than add one. */
  readonly id?: WaitId | undefined;
  /**
   * The message to anchor to, as the user's "Add to Waiting on you" names it: the chip lands in it
   * rather than in the reply streaming now.
   */
  readonly anchor?: MessageId | undefined;
}

/**
 * Where items draw their chips: the runtimes' transcript writer, bound once they are built, since
 * they read this service and can't be read by it.
 */
interface WaitTranscript {
  emitChunk(
    threadId: ThreadId,
    chunk: GramUIMessageChunk,
  ): Effect.Effect<MessageId, ThreadNotFound>;
  updateDataPart(
    threadId: ThreadId,
    messageId: string,
    chunk: GramUIMessageChunk,
  ): Effect.Effect<void, ThreadNotFound>;
}

/** A thread already has `MAX_OPEN_WAITS` open items. */
class WaitsFull extends Data.TaggedError("WaitsFull")<{ readonly open: number }> {}

/** What `put` did: the item as stored, and the one it replaced when it updated in place. */
interface WaitPut {
  readonly item: WaitItem;
  readonly previous?: WaitItem | undefined;
  /** The thread's open items after it. */
  readonly open: number;
}

export interface ThreadWaitsShape {
  /** The thread's open items, suggestions among them, oldest first. */
  open(threadId: ThreadId): Effect.Effect<ReadonlyArray<WaitItem>>;
  /** What the helper resolved within `HELPER_RESOLVE_UNDO_MS`, newest first, suggestions aside. */
  helperResolved(threadId: ThreadId): Effect.Effect<ReadonlyArray<WaitItem>>;
  /**
   * Adds an item, or updates the open one `draft.id` names, anchored where its chip lands: the
   * message `draft.anchor` names, else the reply streaming now, or a message of its own. An update
   * that lands elsewhere marks the chip it left `revised`. Refuses a new item past `MAX_OPEN_WAITS`
   * before anything is drawn, and an `id` that names no open item. What the agent writes is no news
   * to it; what another `source` writes goes in its next note.
   */
  put(
    threadId: ThreadId,
    draft: WaitDraft,
    source: WaitSource,
  ): Effect.Effect<WaitPut, WaitsFull | NotFound | ThreadNotFound>;
  /**
   * Resolves an item, or with `undefined` reopens it, restyling its chip, and answers it as it then
   * is with whether this call changed it: resolving one already resolved keeps the first resolution.
   * Reopening is refused while `MAX_OPEN_WAITS` are open, as adding one is. With `revision`, an item
   * revised since (`waitRevision`) is left as it is: the resolver read another version of it.
   */
  resolve(
    threadId: ThreadId,
    id: WaitId,
    resolution: WaitResolution | undefined,
    revision?: number,
  ): Effect.Effect<{ readonly item: WaitItem; readonly changed: boolean }, NotFound | WaitsFull>;
  /**
   * Adds the helper's suggestion, anchored to `messageId` and drawn as no chip. `false`, adding
   * nothing, when the message already has, or had, an item from the helper, which is how a dismissed
   * suggestion stays dismissed, or when the thread is full, or `fresh` says it came too late; that
   * is asked under the write lock `lapse` takes too, so a suggestion can't land past a lapse.
   */
  suggest(
    threadId: ThreadId,
    draft: Omit<WaitDraft, "id">,
    messageId: MessageId,
    fresh?: Effect.Effect<boolean>,
  ): Effect.Effect<boolean>;
  /**
   * Keeps an open suggestion: it counts from now on, and its chip is drawn in the reply it came
   * from. Refused as adding an item is while the thread is full.
   */
  keep(threadId: ThreadId, id: WaitId): Effect.Effect<WaitItem, NotFound | WaitsFull>;
  /** The user sent to the thread: suggestions they didn't keep are resolved, by the helper. */
  lapse(threadId: ThreadId): Effect.Effect<number>;
  /**
   * The note for the next message the agent reads (`waitNoteText`), and the items it tells of;
   * `undefined` with no news. Leaves out the helper's suggestions, kept ones aside, and what
   * `pending` already tells, as it was then. Records nothing: `heard` does, once the agent has the
   * message.
   */
  draftNote(
    threadId: ThreadId,
    pending: ReadonlyArray<WaitItem>,
  ): Effect.Effect<{ readonly note: string; readonly news: ReadonlyArray<WaitItem> } | undefined>;
  /** Records that the agent heard of `items` as they were in the note it took. */
  heard(threadId: ThreadId, items: ReadonlyArray<WaitItem>): Effect.Effect<void>;
  /**
   * The thread's items, open or `all`, for `list_waits`, without the helper's suggestions: the agent
   * has heard of those it answers.
   */
  listForAgent(threadId: ThreadId, which: WaitListState): Effect.Effect<ReadonlyArray<WaitItem>>;
  /** Late-bound by the runtimes, which depend on this service. */
  bindTranscript(transcript: WaitTranscript): Effect.Effect<void>;
}

/** Which version of an item this is: any change to it, Done and Undo included, moves it on. */
export const waitRevision = (item: Pick<WaitItem, "revision">): number => item.revision ?? 0;

/** How many of `open` count against `MAX_OPEN_WAITS`: suggestions don't. */
const fullAt = (open: ReadonlyArray<WaitItem>) => open.filter(waitIsKept).length;

const newWaitId = (): WaitId => Schema.decodeSync(WaitId)(`w-${randomUUID().slice(0, 8)}`);

/** The `data-wait` part an item draws where it was added, in its state or `revised`. */
const waitChunk = (item: WaitItem, state?: "revised"): GramUIMessageChunk => ({
  type: "data-wait",
  id: item.id,
  data: waitData(item, state),
});

/**
 * The one writer of `wait_items`: every change is stored and then
 * published as the thread's open items in full (`thread.waits`), one at a time, so the last event a
 * client sees is the last write.
 */
export class ThreadWaits extends Context.Service<ThreadWaits, ThreadWaitsShape>()(
  "@gram/server/ThreadWaits",
) {
  static readonly layer: Layer.Layer<ThreadWaits, never, ThreadStore | EventHub> = Layer.effect(
    ThreadWaits,
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const hub = yield* EventHub;
      const writes = yield* Semaphore.make(1);
      let transcript: WaitTranscript | undefined;

      /**
       * The item's chip in `state`; the item is stored either way, so a chip out of reach is logged.
       * A suggestion has none: restyling one would append it to the reply.
       */
      const restyle = (threadId: ThreadId, item: WaitItem, state?: "revised") =>
        item.messageId === undefined || transcript === undefined || item.suggested === true
          ? Effect.void
          : transcript
              .updateDataPart(threadId, item.messageId, waitChunk(item, state))
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("couldn't restyle a Waiting on you chip").pipe(
                    Effect.annotateLogs({ threadId, waitId: item.id, cause: Cause.pretty(cause) }),
                  ),
                ),
              );

      const helperResolved = (threadId: ThreadId) =>
        Effect.map(
          Effect.suspend(() =>
            store.listResolvedWaits(threadId, Date.now() - HELPER_RESOLVE_UNDO_MS),
          ),
          (resolved) =>
            resolved
              .filter((item) => item.resolvedBy === "helper" && item.suggested !== true)
              .toSorted((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0)),
        );

      const publish = (threadId: ThreadId) =>
        Effect.gen(function* () {
          const waits = yield* store.listWaits(threadId);
          const resolved = yield* helperResolved(threadId);
          yield* hub.publish({
            type: "thread.waits",
            threadId,
            waits,
            ...(resolved.length === 0 ? {} : { helperResolved: resolved }),
          });
        });

      return ThreadWaits.of({
        open: (threadId) => store.listWaits(threadId),
        helperResolved,
        put: (threadId, draft, source) =>
          writes.withPermits(1)(
            Effect.gen(function* () {
              const open = yield* store.listWaits(threadId);
              const previous =
                draft.id === undefined ? undefined : open.find((item) => item.id === draft.id);
              if (draft.id !== undefined && previous === undefined) {
                return yield* new NotFound({
                  entity: "wait",
                  id: draft.id,
                  message: `no open item ${draft.id} in this thread`,
                });
              }
              const kept = fullAt(open);
              // Updating a suggestion keeps it, so it counts as an item added.
              const adds = previous === undefined || previous.suggested === true;
              if (adds && kept >= MAX_OPEN_WAITS) return yield* new WaitsFull({ open: kept });
              const now = Date.now();
              const drawn: WaitItem = {
                id: previous?.id ?? newWaitId(),
                kind: draft.kind,
                title: draft.title,
                ...(draft.body === undefined ? {} : { body: draft.body }),
                ...(draft.copy === undefined ? {} : { copy: draft.copy }),
                ...(draft.link === undefined ? {} : { link: draft.link }),
                source: previous?.source ?? source,
                createdAt: previous?.createdAt ?? now,
                ...(previous === undefined
                  ? {}
                  : { updatedAt: now, revision: waitRevision(previous) + 1 }),
              };
              const messageId =
                draft.anchor !== undefined
                  ? draft.anchor
                  : transcript === undefined
                    ? undefined
                    : yield* transcript.emitChunk(threadId, waitChunk(drawn));
              const item: WaitItem = {
                ...drawn,
                ...(messageId === undefined ? {} : { messageId }),
              };
              yield* store.putWait(threadId, item, source === "agent" ? now : undefined);
              if (draft.anchor !== undefined) yield* restyle(threadId, item);
              yield* publish(threadId);
              if (previous?.messageId !== undefined && previous.messageId !== item.messageId) {
                yield* restyle(threadId, previous, "revised");
              }
              return {
                item,
                previous,
                open: kept + (adds ? 1 : 0),
              } satisfies WaitPut;
            }),
          ),
        resolve: (threadId, id, resolution, revision) =>
          writes.withPermits(1)(
            Effect.gen(function* () {
              const before = yield* store.getWait(threadId, id);
              if (revision !== undefined && waitRevision(before) !== revision) {
                return { item: before, changed: false };
              }
              if (
                resolution === undefined &&
                before.resolvedAt !== undefined &&
                before.suggested !== true
              ) {
                const open = fullAt(yield* store.listWaits(threadId));
                if (open >= MAX_OPEN_WAITS) return yield* new WaitsFull({ open });
              }
              const item = yield* store.resolveWait(threadId, id, resolution);
              const changed = before.resolvedAt !== item.resolvedAt;
              if (changed) {
                yield* publish(threadId);
                yield* restyle(threadId, item);
              }
              return { item, changed };
            }),
          ),
        suggest: (threadId, draft, messageId, fresh = Effect.succeed(true)) =>
          writes.withPermits(1)(
            Effect.gen(function* () {
              if (!(yield* fresh)) return false;
              const all = yield* store.listWaits(threadId, "all");
              const seen = all.some(
                (item) => item.source === "helper" && item.messageId === messageId,
              );
              if (seen || fullAt(all) >= MAX_OPEN_WAITS) return false;
              const item: WaitItem = {
                id: newWaitId(),
                kind: draft.kind,
                title: draft.title,
                ...(draft.body === undefined ? {} : { body: draft.body }),
                ...(draft.copy === undefined ? {} : { copy: draft.copy }),
                ...(draft.link === undefined ? {} : { link: draft.link }),
                source: "helper",
                createdAt: Date.now(),
                messageId,
                suggested: true,
              };
              yield* store.putWait(threadId, item);
              yield* publish(threadId);
              return true;
            }),
          ),
        keep: (threadId, id) =>
          writes.withPermits(1)(
            Effect.gen(function* () {
              const before = yield* store.getWait(threadId, id);
              if (before.suggested !== true || before.resolvedAt !== undefined) {
                return yield* new NotFound({
                  entity: "wait",
                  id,
                  message: `no open suggestion ${id} in this thread`,
                });
              }
              const open = fullAt(yield* store.listWaits(threadId));
              if (open >= MAX_OPEN_WAITS) return yield* new WaitsFull({ open });
              const { suggested: _, ...rest } = before;
              const item: WaitItem = { ...rest, revision: waitRevision(before) + 1 };
              yield* store.putWait(threadId, item);
              yield* publish(threadId);
              yield* restyle(threadId, item);
              return item;
            }),
          ),
        lapse: (threadId) =>
          writes.withPermits(1)(
            Effect.gen(function* () {
              const open = yield* store.listWaits(threadId);
              const lapsed = open.filter((item) => item.suggested === true);
              const at = Date.now();
              for (const item of lapsed) {
                // Read under the same permit, so only a row gone since could be missing.
                yield* store
                  .resolveWait(threadId, item.id, { by: "helper", at, note: "lapsed" })
                  .pipe(Effect.ignore);
              }
              if (lapsed.length > 0) yield* publish(threadId);
              return lapsed.length;
            }),
          ),
        // Not under `writes`: the runtimes ask with a thread's lock held, which `put` and `resolve`
        // take under `writes` to draw a chip. A row changed since it was read stays news instead.
        draftNote: (threadId, pending) =>
          Effect.gen(function* () {
            const told = new Set(pending.map((item) => `${item.id}:${item.resolvedAt ?? ""}`));
            // A suggestion is the helper's, not the user's, until kept, and goes untold dismissed.
            const news = (yield* store.listWaitNews(threadId)).filter(
              (item) => item.suggested !== true && !told.has(`${item.id}:${item.resolvedAt ?? ""}`),
            );
            const note = waitNoteText(news, (yield* store.listWaits(threadId)).filter(waitIsKept));
            return note === undefined ? undefined : { note, news };
          }),
        heard: (threadId, items) => store.markWaitsTold(threadId, items, Date.now()),
        listForAgent: (threadId, which) =>
          Effect.gen(function* () {
            const items = (yield* store.listWaits(threadId, which)).filter(
              (item) => item.suggested !== true,
            );
            const news = new Set((yield* store.listWaitNews(threadId)).map((item) => item.id));
            yield* store.markWaitsTold(
              threadId,
              items.filter((item) => news.has(item.id)),
              Date.now(),
            );
            return items;
          }),
        bindTranscript: (bound) =>
          Effect.sync(() => {
            transcript = bound;
          }),
      });
    }),
  );
}
