import { FeedCursor, type GramUIMessage, type ThreadHistoryPage } from "@gram/contracts";
import { createStore, type StoreApi } from "zustand/vanilla";

import type { ApiThreadFeedEvent, FeedResume } from "@/api/types";

import { createMessageFold, type MessageFold } from "./message-fold";

/** Schedules `cb` once; returns a cancel function. rAF in the app, a manual queue in tests. */
export type Scheduler = (cb: () => void) => () => void;

const rafScheduler: Scheduler = (cb) => {
  const id = requestAnimationFrame(cb);
  return () => cancelAnimationFrame(id);
};

/** Runs immediately; for consumers that don't render (the mock api's own fold). */
export const syncScheduler: Scheduler = (cb) => {
  cb();
  return () => {};
};

export interface ThreadFeedState {
  /**
   * `loading` until the server's first `caughtUp`; nothing is published before then. `gone` once
   * the server says the thread doesn't exist, until a new subscription starts.
   */
  phase: "loading" | "live" | "gone";
  messages: readonly GramUIMessage[];
  /** Messages currently receiving chunks (a parent and its subagents can stream at once). */
  streamingMessageIds: readonly string[];
  /** The thread has older history than `messages`, which `loadEarlier` pages in. */
  earlier: boolean;
  /** A `loadEarlier` page is on its way. */
  loadingEarlier: boolean;
  /**
   * The last page failed; `loadEarlier` asks again only when `retry` says so, or once a new
   * subscription starts.
   */
  earlierFailed: boolean;
}

export interface ThreadFeed {
  readonly store: StoreApi<ThreadFeedState>;
  apply(event: ApiThreadFeedEvent): void;
  /**
   * Where a new subscription can resume from, or `undefined` for the recent history: the last
   * revision the server said this feed holds everything up to, lowered to cover the messages still
   * streaming, whose stored rows can be written after it, and the oldest message it holds.
   */
  resume(): FeedResume | undefined;
  /**
   * Prepends pages of older history while there is some, until one holds `until` or, without it,
   * once; a call while pages are on their way runs after them. A new full history arriving
   * meanwhile drops the page. After a failed page it does nothing unless `retry`, which a person
   * asking again passes.
   */
  loadEarlier(options?: {
    readonly until?: string | undefined;
    readonly retry?: boolean;
  }): Promise<void>;
  /**
   * The message `messageId`, paging older history in for it as a person asking again does, without
   * waiting for the frame that publishes it, and for the subscription's first catch-up when it is
   * still loading. `undefined` only once the whole history is in without it; rejects when a page
   * fails or is dropped before it got there, or the feed ends.
   */
  find(messageId: string): Promise<GramUIMessage | undefined>;
  /**
   * A new subscription is on its way to a feed that had stopped, kept cold: until it catches up,
   * `find` waits for it rather than answer from what the feed held, which may be stale by now.
   */
  resubscribing(): void;
  /** The server has no such thread: the feed ended for good, and the state says so. */
  gone(): void;
  /** Resolves once every chunk applied so far has been folded into a message. */
  whenSettled(): Promise<void>;
  dispose(): void;
}

const ENDS_MESSAGE = new Set(["finish", "abort"]);

/**
 * Applies a `thread.subscribe` feed to a store. Chunks are folded into messages one `MessageFold`
 * per message id, synchronously, and store updates are coalesced to one per scheduler frame: a
 * replay of thousands of chunks costs one fold pass and one publish.
 *
 * Every subscription (including a resubscription after a dropped connection) starts with
 * `messages`, or `resumed` when it passed `resumeRev()`, replays the in-flight chunks from their
 * first chunk, then sends `caughtUp`. So `messages` resets the fold, `resumed` updates it, and the
 * last published state stays visible until `caughtUp`.
 */
export function createThreadFeed(
  options: {
    scheduler?: Scheduler;
    onError?: (error: unknown) => void;
    /** Reads the page before a message (`Api.threadHistory`); without it nothing pages in. */
    history?: (before: string) => Promise<ThreadHistoryPage>;
  } = {},
): ThreadFeed {
  const scheduler = options.scheduler ?? rafScheduler;
  const store = createStore<ThreadFeedState>()(() => ({
    phase: "loading",
    messages: [],
    streamingMessageIds: [],
    earlier: false,
    loadingEarlier: false,
    earlierFailed: false,
  }));

  let working: GramUIMessage[] = [];
  const active = new Map<string, MessageFold>();
  /** Folds whose message changed since the last flush, by the id they were opened under. */
  const dirty = new Set<string>();
  const parsing = new Set<Promise<void>>();
  let caughtUp = false;
  /** Revived from cold: what it holds may be behind until the new subscription catches up. */
  let stale = false;
  /** `find`s waiting for the subscription to catch up before they can tell what history holds. */
  let catchingUp: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  const untilCaughtUp = () =>
    caughtUp
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => catchingUp.push({ resolve, reject }));
  const endWaits = (error?: Error) => {
    const waiting = catchingUp;
    catchingUp = [];
    for (const wait of waiting) {
      if (error === undefined) wait.resolve();
      else wait.reject(error);
    }
  };
  let flushPending = false;
  let cancelFlush: (() => void) | undefined;
  let disposed = false;
  /** Bumped by each subscription, so a parse that outlives its subscription publishes nothing. */
  let generation = 0;
  const cursor = new FeedCursor();
  let earlier = false;
  /** Bumped when the history is replaced whole, so a page read before then isn't prepended. */
  let replacements = 0;
  let paging: Promise<void> | undefined;
  let failed = false;

  const upsert = (message: GramUIMessage) => {
    // The streaming message is almost always the last one, so search from the end.
    const index = working.findLastIndex((m) => m.id === message.id);
    if (index !== -1 && working[index] === message) return;
    working = index === -1 ? [...working, message] : working.with(index, message);
  };

  /** Moves what the dirty folds have folded into `working`; once per flush, not per chunk. */
  const collect = (folds: ReadonlyMap<string, MessageFold>) => {
    for (const id of dirty) {
      const fold = folds.get(id);
      if (!fold) continue;
      const snapshot = fold.snapshot();
      upsert(snapshot.id ? snapshot : { ...snapshot, id });
    }
    dirty.clear();
  };

  /** Fills in the input of tool calls still streaming it, then publishes again if any changed. */
  const parsePartialInputs = () => {
    const current = generation;
    for (const [id, fold] of active) {
      const task: Promise<void> = fold
        .parsePartialInputs()
        .then((changed) => {
          if (!changed || disposed || current !== generation || active.get(id) !== fold) return;
          dirty.add(id);
          scheduleFlush();
        })
        .catch((error: unknown) => options.onError?.(error))
        .finally(() => parsing.delete(task));
      parsing.add(task);
    }
  };

  const flush = () => {
    flushPending = false;
    cancelFlush = undefined;
    if (disposed) return;
    collect(active);
    // The same ids keep their array, so a frame that only grew a message doesn't re-render what
    // reads which messages stream.
    const held = store.getState().streamingMessageIds;
    const streaming =
      held.length === active.size && [...active.keys()].every((id, i) => held[i] === id)
        ? held
        : [...active.keys()];
    store.setState({
      phase: "live",
      messages: working,
      streamingMessageIds: streaming,
      earlier,
    });
    parsePartialInputs();
  };

  const scheduleFlush = () => {
    if (!caughtUp || flushPending || disposed) return;
    flushPending = true;
    // A synchronous scheduler flushes before returning; don't keep its stale cancel handle.
    const cancel = scheduler(flush);
    if (flushPending) cancelFlush = cancel;
  };

  const close = (id: string) => {
    const fold = active.get(id);
    if (!fold) return;
    // Its last chunks are folded but not collected yet; take them before the fold is forgotten.
    collect(active);
    active.delete(id);
    cursor.closed(id);
    scheduleFlush();
  };

  /** Drops every in-flight fold without publishing; a new subscription replays them. */
  const reset = () => {
    generation++;
    active.clear();
    dirty.clear();
    cancelFlush?.();
    cancelFlush = undefined;
    flushPending = false;
    caughtUp = false;
  };

  const open = (id: string): MessageFold => {
    const held = working.findLast((m) => m.id === id);
    const fold = createMessageFold(id, {
      base: cursor.opened(id, held !== undefined) ? held : undefined,
      onError: (error) => options.onError?.(error),
    });
    active.set(id, fold);
    return fold;
  };

  const page = async (until: string | undefined) => {
    const history = options.history;
    if (history === undefined) return;
    for (;;) {
      if (!earlier || disposed || working.length === 0) return;
      if (until !== undefined && working.some((m) => m.id === until)) return;
      store.setState({ loadingEarlier: true });
      const current = replacements;
      const subscription = generation;
      let result: ThreadHistoryPage;
      try {
        result = await history(working[0]!.id);
      } catch (error) {
        // A request from before a resubscription or a new history says nothing about now.
        if (disposed || current !== replacements || subscription !== generation) return;
        failed = true;
        store.setState({ earlierFailed: true });
        throw error;
      }
      if (disposed || current !== replacements) return;
      const held = new Set(working.map((m) => m.id));
      working = [...result.messages.filter((m) => !held.has(m.id)), ...working];
      earlier = result.earlier && result.messages.length > 0;
      scheduleFlush();
      if (until === undefined) return;
    }
  };

  return {
    store,
    apply(event) {
      if (disposed) return;
      switch (event.type) {
        case "subscribed":
          cursor.subscribed();
          reset();
          // A new subscription is a connection back, worth asking for history again.
          failed = false;
          if (store.getState().phase === "gone") store.setState({ phase: "loading" });
          if (store.getState().earlierFailed) store.setState({ earlierFailed: false });
          return;
        case "messages":
          cursor.replaced();
          replacements++;
          earlier = event.earlier === true;
          // A failed page belonged to the history this replaces.
          failed = false;
          if (store.getState().earlierFailed) store.setState({ earlierFailed: false });
          if (caughtUp) {
            // A live replace-all (after a rewind): swap the history and publish without waiting.
            reset();
            caughtUp = true;
            working = [...event.messages];
            scheduleFlush();
            return;
          }
          working = [...event.messages];
          return;
        case "resumed":
          cursor.resumed(event.messages.map((m) => m.id));
          for (const message of event.messages) upsert(message);
          return;
        case "message":
          // Chunks folded before it must land first, or a later collect would undo the order.
          collect(active);
          upsert(event.message);
          cursor.message(event.rev);
          scheduleFlush();
          return;
        case "chunk": {
          const fold = active.get(event.messageId) ?? open(event.messageId);
          fold.apply(event.chunk);
          dirty.add(event.messageId);
          if (ENDS_MESSAGE.has(event.chunk.type)) close(event.messageId);
          else scheduleFlush();
          return;
        }
        case "caughtUp": {
          const lost = cursor.caughtUp(event.rev);
          if (lost.length > 0) working = working.filter((m) => !lost.includes(m.id));
          caughtUp = true;
          stale = false;
          scheduleFlush();
          endWaits();
          return;
        }
        default:
          // A new feed event must be handled here rather than silently dropped.
          event satisfies never;
      }
    },
    resume() {
      const afterRev = cursor.resumeRev();
      if (afterRev === undefined) return undefined;
      return { afterRev, from: working[0]?.id };
    },
    loadEarlier({ until, retry = false } = {}) {
      if (failed && !retry) return Promise.resolve();
      if (retry && failed) {
        failed = false;
        store.setState({ earlierFailed: false });
      }
      // A plain call is answered by any page on its way; one with a target goes after it.
      if (paging !== undefined && until === undefined) return paging;
      const next = (paging ?? Promise.resolve())
        .catch(() => {})
        .then(() => (failed ? undefined : page(until)));
      paging = next;
      next
        .finally(() => {
          if (paging !== next) return;
          paging = undefined;
          if (!disposed) store.setState({ loadingEarlier: false });
        })
        .catch(() => {});
      return next;
    },
    async find(messageId) {
      // A reply still streaming, or replayed unfinished, is in its fold until a frame collects it.
      const held = () => {
        collect(active);
        return working.find((m) => m.id === messageId);
      };
      if (!stale && held() !== undefined) return held();
      // Before the first catch-up the feed holds nothing yet, which would read as all of history;
      // revived from cold, it holds what may have moved on since.
      await untilCaughtUp();
      if (held() !== undefined) return held();
      await this.loadEarlier({ until: messageId, retry: true });
      const found = held();
      if (found !== undefined || !earlier) return found;
      throw new Error(`history stopped paging before message ${messageId}`);
    },
    resubscribing() {
      caughtUp = false;
      stale = true;
    },
    gone() {
      if (disposed) return;
      endWaits(new Error("the thread is gone"));
      reset();
      cursor.clear();
      earlier = false;
      replacements++;
      working = [];
      store.setState({ phase: "gone", messages: working, streamingMessageIds: [], earlier });
    },
    async whenSettled() {
      // Folding is synchronous; only a streaming tool call's input is parsed after the fact.
      while (parsing.size > 0) await Promise.all(parsing);
    },
    dispose() {
      disposed = true;
      endWaits(new Error("the thread's feed closed"));
      cancelFlush?.();
      active.clear();
      dirty.clear();
    },
  };
}
