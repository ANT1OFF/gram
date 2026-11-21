import type { GramUIMessage, ThreadId, ThreadSummary, WorkspaceId } from "@gram/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { useStore } from "zustand";

import { useApi } from "@/api/context";
import { isThreadNotFound } from "@/api/errors";
import type { Api, ApiServerEvent } from "@/api/types";
import { loadKeybindings } from "@/keyboard/use-keybindings-sync";
import { ledgerStreamLive } from "@/orchestration/use-orchestration";
import { pullServerSettings } from "@/settings-sync";

import { invalidateAfterResync, invalidateForEvent } from "./query-invalidation";
import { createFrameBatch } from "./frame-batch";
import {
  applyServerEvents,
  flushServerEvents,
  forgetClosedThread,
  setServerEventsFlush,
  useThreadsStore,
} from "./threads";
import { createThreadFeed, type ThreadFeed, type ThreadFeedState } from "./thread-feed";

interface Kept {
  feed: ThreadFeed;
  source: { api: Api };
}

interface Entry extends Kept {
  abort: AbortController;
  refs: number;
  evict: ReturnType<typeof setTimeout> | undefined;
  unwatch: (() => void) | undefined;
}

const FEED_QUIET_MS = 12_000;
const FEED_QUIET_MAX_MS = 60_000;

const KEEP_WARM_MS = 30_000;
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

function listen(api: Api, threadId: ThreadId, entry: Entry, quiet = FEED_QUIET_MS) {
  const { feed, abort } = entry;
  const before = useThreadsStore.getState().byId[threadId];
  let heard = false;
  const again = () => {
    if (entry.abort !== abort || abort.signal.aborted) return;
    clearTimeout(watch);
    abort.abort();
    entry.abort = new AbortController();
    feed.slow();
    feed.resubscribing();
    listen(api, threadId, entry, Math.min(quiet * 2, FEED_QUIET_MAX_MS));
  };
  const watch = setTimeout(() => {
    if (!heard && feed.store.getState().phase === "loading") again();
  }, quiet);
  void (async () => {
    try {
      for await (const event of api.threadFeed(threadId, abort.signal, feed.resume)) {
        if (abort.signal.aborted) return;
        heard = true;
        clearTimeout(watch);
        feed.apply(event);
      }
    } catch (error) {
      clearTimeout(watch);
      if (abort.signal.aborted) return;
      if (!isThreadNotFound(error)) {
        console.error("thread feed ended", threadId, error);
        if (feed.store.getState().phase === "loading") setTimeout(again, Math.min(quiet, 5_000));
        return;
      }
      feed.gone();
      flushServerEvents();
      if (before !== undefined && useThreadsStore.getState().byId[threadId] === before) {
        forgetClosedThread(threadId);
      }
      resubscribeOnReturn(api, threadId, entry, before);
    }
  })();
}

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

function hold(api: Api, threadId: ThreadId): Entry {
  const entry = entryFor(api, threadId);
  entry.refs++;
  clearTimeout(entry.evict);
  return entry;
}

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

const EMPTY_FEED = createThreadFeed().store.getInitialState();

/** Subscribes to a thread's message feed while mounted and selects from its store. */
export function useThreadFeed<T>(threadId: ThreadId, selector: (state: ThreadFeedState) => T): T {
  const api = useApi();
  const store = useMemo(
    () => ({
      getState: () =>
        entries.get(threadId)?.feed.store.getState() ??
        cold.get(threadId)?.feed.store.getState() ??
        EMPTY_FEED,
      getInitialState: () => EMPTY_FEED,
      subscribe: (changed: (state: ThreadFeedState, previous: ThreadFeedState) => void) => {
        const entry = hold(api, threadId);
        const unsubscribe = entry.feed.store.subscribe(changed);
        return () => {
          unsubscribe();
          release(threadId, entry);
        };
      },
    }),
    [api, threadId],
  );
  return useStore(store, selector);
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
    const ledgerLive = (workspaceId: WorkspaceId) => ledgerStreamLive(api, workspaceId);
    let snapshots = 0;
    const batch = createFrameBatch<ApiServerEvent>(
      (event) => {
        applyEvent(event);
        invalidateForEvent(queryClient, event, ledgerLive);
        if (event.type === "threads.snapshot" && snapshots++ > 0) {
          invalidateAfterResync(queryClient, ledgerLive);
          void pullServerSettings();
          void loadKeybindings(api, () => abort.signal.aborted);
        }
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
        batch.flush();
      }
    })();
    return () => {
      abort.abort();
      unregister();
      batch.flush();
    };
  }, [api, queryClient]);
}
