import type { GramUIMessage, ThreadId, ThreadSummary } from "@gram/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useStore } from "zustand";

import { useApi } from "@/api/context";
import { isThreadNotFound } from "@/api/errors";
import type { Api, ApiServerEvent } from "@/api/types";
import { ledgerStreamLive } from "@/orchestration/use-orchestration";
import { pullServerSettings } from "@/settings-sync";

import { invalidateForEvent } from "./query-invalidation";
import { createFrameBatch } from "./frame-batch";
import {
  applyServerEvents,
  flushServerEvents,
  forgetClosedThread,
  setServerEventsFlush,
  useThreadsStore,
} from "./threads";
import { createThreadFeed, type ThreadFeed, type ThreadFeedState } from "./thread-feed";

/** A feed and the api its history pages come from, which a replaced connection replaces. */
interface Kept {
  feed: ThreadFeed;
  source: { api: Api };
}

interface Entry extends Kept {
  abort: AbortController;
  refs: number;
  evict: ReturnType<typeof setTimeout> | undefined;
  /** Set while a gone feed waits for its thread to come back. */
  unwatch: (() => void) | undefined;
}

/** Feeds stay subscribed briefly after the last viewer leaves, so switching back is instant. */
const KEEP_WARM_MS = 30_000;
/**
 * How many feeds are kept, unsubscribed, after that, most recently left last: reopening one shows
 * what it held at once and resumes from its revision rather than being sent the whole history.
 */
const KEEP_COLD = 8;
const entries = new Map<string, Entry>();
const cold = new Map<string, Kept>();

function keepCold(threadId: ThreadId, kept: Kept) {
  if (kept.feed.store.getState().phase !== "live") {
    kept.feed.dispose();
    return;
  }
  cold.set(threadId, kept);
  for (const [id, oldest] of cold) {
    if (cold.size <= KEEP_COLD) break;
    cold.delete(id);
    oldest.feed.dispose();
  }
}

function takeCold(threadId: ThreadId): Kept | undefined {
  const kept = cold.get(threadId);
  cold.delete(threadId);
  return kept;
}

function entryFor(api: Api, threadId: ThreadId): Entry {
  let entry = entries.get(threadId);
  if (entry) return entry;
  const source = { api };
  const revived = takeCold(threadId);
  // What it held may have moved on while nothing listened.
  revived?.feed.resubscribing();
  const kept = revived ?? {
    source,
    feed: createThreadFeed({
      onError: (error) => console.error("thread feed", threadId, error),
      history: (before) => source.api.threadHistory(threadId, before),
    }),
  };
  kept.source.api = api;
  entry = { ...kept, abort: new AbortController(), refs: 0, evict: undefined, unwatch: undefined };
  entries.set(threadId, entry);
  listen(api, threadId, entry);
  return entry;
}

function listen(api: Api, threadId: ThreadId, entry: Entry) {
  const { feed, abort } = entry;
  // Taken before subscribing: the events feed runs apart from this one, so a reopened thread's
  // summary can land before the refusal of the subscription made while it was closed.
  const before = useThreadsStore.getState().byId[threadId];
  void (async () => {
    try {
      for await (const event of api.threadFeed(threadId, abort.signal, feed.resume)) {
        // A cold feed lives on under a new subscription; this one's stragglers mustn't reach it.
        if (abort.signal.aborted) return;
        feed.apply(event);
      }
    } catch (error) {
      if (abort.signal.aborted) return;
      if (!isThreadNotFound(error)) {
        console.error("thread feed ended", threadId, error);
        return;
      }
      feed.gone();
      // Whatever the server sent about the thread before refusing it counts, held for a frame or not.
      flushServerEvents();
      // The summary held since before the refusal is one the server no longer has, so the lists
      // drop it rather than keep a row that opens onto this. One that came since is a reopen.
      if (before !== undefined && useThreadsStore.getState().byId[threadId] === before) {
        forgetClosedThread(threadId);
      }
      resubscribeOnReturn(api, threadId, entry, before);
    }
  })();
}

/**
 * A reopened thread keeps its id, so a gone feed subscribes again once the server sends the thread
 * anew: any summary other than `stale`, the one held before the refused subscription, whether an
 * upsert, a status or a snapshot after a reconnect that missed the removal. Not merely while the
 * list has it: the list can still hold a thread the server has just closed, and resubscribing then
 * would only fail again.
 */
function resubscribeOnReturn(
  api: Api,
  threadId: ThreadId,
  entry: Entry,
  stale: ThreadSummary | undefined,
) {
  const anew = (summary: ThreadSummary | undefined) =>
    summary !== undefined && summary !== stale && !entry.abort.signal.aborted;
  if (anew(useThreadsStore.getState().byId[threadId])) {
    listen(api, threadId, entry);
    return;
  }
  entry.unwatch = useThreadsStore.subscribe((state) => {
    if (!anew(state.byId[threadId])) return;
    entry.unwatch?.();
    entry.unwatch = undefined;
    listen(api, threadId, entry);
  });
}

/** Pages older history into a mounted thread's feed (`ThreadFeed.loadEarlier`). */
export function loadEarlier(
  threadId: ThreadId,
  options?: Parameters<ThreadFeed["loadEarlier"]>[0],
): Promise<void> {
  return entries.get(threadId)?.feed.loadEarlier(options) ?? Promise.resolve();
}

/** The messages a mounted view of the thread has folded, read once without subscribing. */
export function feedMessages(threadId: ThreadId): ThreadFeedState["messages"] {
  return entries.get(threadId)?.feed.store.getState().messages ?? [];
}

/**
 * A message of a mounted view of the thread, paged in when it is older than what is loaded
 * (`ThreadFeed.find`); rejects when no view of the thread is mounted.
 */
export function findMessage(
  threadId: ThreadId,
  messageId: string,
): Promise<GramUIMessage | undefined> {
  const entry = entries.get(threadId);
  if (entry === undefined) return Promise.reject(new Error(`thread ${threadId} isn't open`));
  return entry.feed.find(messageId);
}

/** Holds the thread's feed open, subscribing it if nothing else holds it. */
function hold(api: Api, threadId: ThreadId): Entry {
  const entry = entryFor(api, threadId);
  entry.refs++;
  clearTimeout(entry.evict);
  return entry;
}

/** Lets go of a feed `hold` gave; the last to let go leaves it warm for a while, then cold. */
function release(threadId: ThreadId, entry: Entry) {
  entry.refs--;
  if (entry.refs > 0) return;
  entry.evict = setTimeout(() => {
    entry.abort.abort();
    entry.unwatch?.();
    entries.delete(threadId);
    keepCold(threadId, entry);
  }, KEEP_WARM_MS);
}

/**
 * A message of the thread, open or not: a mounted view's feed is read as `findMessage` reads it,
 * and a thread no view has open gets its feed subscribed for the read and let go after, as a
 * viewer leaving would. Copy reads a draft's reply through it from lists outside the thread.
 */
export async function readMessage(
  api: Api,
  threadId: ThreadId,
  messageId: string,
): Promise<GramUIMessage | undefined> {
  const entry = hold(api, threadId);
  try {
    return await entry.feed.find(messageId);
  } finally {
    release(threadId, entry);
  }
}

/** Whether a mounted view of the thread has its messages in yet, read once without subscribing. */
export function feedLoaded(threadId: ThreadId): boolean {
  return entries.get(threadId)?.feed.store.getState().phase === "live";
}

/** Subscribes to a thread's message feed while mounted and selects from its store. */
export function useThreadFeed<T>(threadId: ThreadId, selector: (state: ThreadFeedState) => T): T {
  const api = useApi();
  const entry = entryFor(api, threadId);

  useEffect(() => {
    const current = hold(api, threadId);
    return () => release(threadId, current);
  }, [api, threadId]);

  return useStore(entry.feed.store, selector);
}

/**
 * Feeds the global threads store from `events.subscribe` while mounted, and invalidates the queries
 * an event makes stale. Events wait for the next frame and then apply in the order they came, each
 * on its own as before, in one task: every store subscriber still sees each one, and React renders
 * the lot once (`createFrameBatch`).
 */
export function useServerEvents() {
  const api = useApi();
  const queryClient = useQueryClient();
  useEffect(() => {
    const abort = new AbortController();
    const { applyEvent } = useThreadsStore.getState();
    const batch = createFrameBatch<ApiServerEvent>(
      (event) => {
        applyEvent(event);
        invalidateForEvent(queryClient, event, (workspaceId) => ledgerStreamLive(api, workspaceId));
        // A change no window made (an approved `settings_propose`): every window takes it.
        if (event.type === "settings.changed") void pullServerSettings();
      },
      undefined,
      applyServerEvents,
    );
    const unregister = setServerEventsFlush(batch.flush);
    void (async () => {
      try {
        for await (const event of api.events(abort.signal)) batch.push(event);
      } catch (error) {
        if (!abort.signal.aborted) console.error("event feed ended", error);
      } finally {
        // What came before the feed ended or was replaced still lands.
        batch.flush();
      }
    })();
    return () => {
      abort.abort();
      unregister();
      batch.flush();
    };
    // A replaced connection brings a new `api`, which must resubscribe, and the query client is used
    // inside; the rule treats both as stable context values and can't see that.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [api, queryClient]);
}
