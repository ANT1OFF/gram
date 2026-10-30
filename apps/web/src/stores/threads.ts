import type {
  CompactionActivity,
  PlanItem,
  QueuedInput,
  QueueItemId,
  ReviewRound,
  ReviewVerdict,
  ServerEvent,
  ThreadId,
  ThreadPlan,
  ThreadSummary,
  UsageSummary,
  UserInput,
  WorktreeRemoval,
} from "@gram/contracts";
import { create } from "zustand";

import type { ApiServerEvent, CloseThreadOptions } from "@/api/types";
import { useBindingsStore } from "@/keyboard/bindings-store";
import { limitPercent, resetText, windowWord } from "@/usage/limit-format";

import { useNotificationHistory } from "./notifications";
import { useLapsedDismissals } from "./lapsed-connectors";
import { useSuggestionsStore } from "./suggestions";
import { useThreadHistory } from "./thread-history";
import { useUsageLimits } from "./usage-limits";

type Notify = Extract<ServerEvent, { type: "notify" }> & { at: number };
type RateLimit = Extract<ServerEvent, { type: "rateLimit" }>;
type ShowPanel = Extract<ServerEvent, { type: "ui.showPanel" }>;

const VERDICT_TITLE: Record<ReviewVerdict, string> = {
  approved: "approved",
  changesRequested: "changes requested",
  commented: "commented",
};

const reviewRoundTitle = (round: ReviewRound) =>
  `Review round ${round.number}${round.verdict ? `: ${VERDICT_TITLE[round.verdict]}` : " finished"}`;

const reviewRoundBody = ({ blockers, unresolved }: ReviewRound["counts"]) =>
  unresolved === 0
    ? "No unresolved findings"
    : `${blockers} blocker${blockers === 1 ? "" : "s"}, ${unresolved} unresolved`;

/**
 * The toast for a rate limit, in the limits' own words: the window by its one name (`windowWord`),
 * the share as the meter rounds it (`limitPercent`, so never 100% short of the limit) and the reset
 * on the limits' clock (`resetText`). One already past isn't shown. `intl` pins the locale and
 * zone, for tests.
 */
export const rateLimitTitle = (
  limit: Pick<RateLimit, "status" | "window" | "utilization" | "resetsAt">,
  now: number,
  intl: { readonly locale?: string; readonly timeZone?: string } = {},
) => {
  const window = windowWord(limit.window);
  const at = limit.resetsAt;
  const resets = at === undefined || at <= now ? "" : `, resets ${resetText(at, now, intl)}`;
  if (limit.status === "rejected") return `Rate limited (${window}${resets})`;
  const pct = limit.utilization === undefined ? "" : ` ${limitPercent(limit.utilization)}%`;
  return `Approaching rate limit:${pct} of ${window}${resets}`;
};

export interface ThreadsState {
  /** False until the first `threads.snapshot`. */
  ready: boolean;
  /** Each thread's summary, its `usage` left out: that lives in `usage`. */
  byId: Readonly<Record<string, ThreadSummary>>;
  /**
   * Each thread's latest usage report. It is kept apart from `byId` because a working thread reports
   * every couple of seconds and the sidebar shows none of it: in `byId`, each report re-rendered the
   * sidebar, the board and everything else that reads the thread map.
   */
  usage: Readonly<Record<string, UsageSummary>>;
  /** `detail` of each thread's last status event; the sidebar's live activity line. */
  statusDetail: Readonly<Record<string, string>>;
  /** Each thread's latest agent plan (todo list), from `thread.plan`. */
  plans: Readonly<Record<string, readonly PlanItem[]>>;
  notifications: readonly Notify[];
  /** The last `ui.showPanel` request, consumed by the right panel. */
  showPanel: ShowPanel | undefined;

  applyEvent(event: ApiServerEvent): void;
  setQueue(threadId: ThreadId, queue: readonly QueuedInput[]): void;
  /**
   * Sets many threads' manual positions in one update (`undefined` unplaces one), so a reorder shows
   * at once instead of shuffling as the server's per-thread upserts arrive.
   */
  setSortOrders(orders: Readonly<Record<string, number | undefined>>): void;
}

const samePlan = (a: ThreadPlan | undefined, b: ThreadPlan | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b));

/** `byId` with one thread replaced by `fn`; the same map when `fn` changes nothing, so nobody re-renders. */
const sameCompaction = (a: CompactionActivity | undefined, b: CompactionActivity | undefined) =>
  a === b ||
  (a?.startedAt === b?.startedAt && a?.trigger === b?.trigger && a?.preTokens === b?.preTokens);

/** How many background shells' last output a thread keeps, running or ended. */
const BACKGROUND_OUTPUTS_KEPT = 8;

const patch = (
  byId: ThreadsState["byId"],
  threadId: string,
  fn: (s: ThreadSummary) => ThreadSummary,
): ThreadsState["byId"] => {
  const current = byId[threadId];
  if (!current) return byId;
  const next = fn(current);
  return next === current ? byId : { ...byId, [threadId]: next };
};

export const createThreadsSlice = (
  set: (fn: (s: ThreadsState) => Partial<ThreadsState>) => void,
): ThreadsState => ({
  ready: false,
  byId: {},
  usage: {},
  statusDetail: {},
  plans: {},
  notifications: [],
  showPanel: undefined,

  applyEvent(event) {
    switch (event.type) {
      case "threads.snapshot":
        // A snapshot stands in for events missed while disconnected, turns that started among
        // them: what was suggested may answer a turn that's gone. Focus asks again.
        useSuggestionsStore.getState().reset();
        // It also stands in for a lapsed connector's return, which forgets its dismissal.
        useLapsedDismissals
          .getState()
          .reconcile(
            Object.fromEntries(event.threads.map((t) => [t.thread.id, t.lapsedConnectors ?? []])),
          );
        set(() => ({
          ready: true,
          // Live details override snapshot activity only until the next snapshot. It accounts
          // for statuses missed while disconnected, including background work starting/stopping.
          statusDetail: {},
          byId: Object.fromEntries(
            event.threads.map(({ usage: _usage, turnPlan: _turnPlan, ...t }) => [t.thread.id, t]),
          ),
          usage: Object.fromEntries(
            event.threads.flatMap((t) => (t.usage ? [[t.thread.id, t.usage]] : [])),
          ),
          plans: Object.fromEntries(
            event.threads.flatMap((t) => (t.turnPlan ? [[t.thread.id, t.turnPlan]] : [])),
          ),
        }));
        return;
      case "thread.upsert":
        set((s) => {
          const current = s.byId[event.thread.id];
          // Publishes can land out of commit order; the higher revision is the later write.
          const held = current?.thread.revision;
          const revision = event.thread.revision;
          if (held !== undefined && revision !== undefined && revision < held) return s;
          const next: ThreadSummary = current
            ? { ...current, thread: event.thread }
            : { thread: event.thread, status: "cold", pendingRequests: [], queue: [] };
          return { byId: { ...s.byId, [event.thread.id]: next } };
        });
        return;
      case "thread.removed": {
        // The server keeps the closed thread for ⌘⇧T.
        useThreadHistory.getState().forget(event.threadId);
        useSuggestionsStore.getState().clear(event.threadId);
        useLapsedDismissals.getState().prune(event.threadId, []);
        set((s) => {
          const { [event.threadId]: _removed, ...rest } = s.byId;
          const { [event.threadId]: _plan, ...plans } = s.plans;
          const { [event.threadId]: _usage, ...usage } = s.usage;
          const { [event.threadId]: _detail, ...statusDetail } = s.statusDetail;
          return { byId: rest, plans, usage, statusDetail };
        });
        return;
      }
      case "thread.status":
        // A turn under way makes the last one's suggested replies stale.
        if (event.status === "starting" || event.status === "running") {
          useSuggestionsStore.getState().clear(event.threadId);
        }
        // Most of these only move the activity line, several a second per working thread; that
        // leaves `byId` alone, so the sidebar and every `byId` subscriber sit it out. Every one
        // states the compaction under way, so one without it says none is.
        set((s) => {
          const detail = event.detail ?? "";
          return {
            byId: patch(s.byId, event.threadId, (t) => {
              if (t.status === event.status && sameCompaction(t.compaction, event.compaction)) {
                return t;
              }
              const { compaction: _was, ...rest } = t;
              return {
                ...rest,
                status: event.status,
                ...(event.compaction === undefined ? {} : { compaction: event.compaction }),
              };
            }),
            statusDetail:
              s.statusDetail[event.threadId] === detail
                ? s.statusDetail
                : { ...s.statusDetail, [event.threadId]: detail },
          };
        });
        return;
      case "thread.request":
        set((s) => ({
          byId: patch(s.byId, event.threadId, (t) => ({
            ...t,
            pendingRequests: [
              ...t.pendingRequests.filter((r) => r.id !== event.request.id),
              event.request,
            ],
          })),
        }));
        return;
      case "thread.requestResolved":
        set((s) => ({
          byId: patch(s.byId, event.threadId, (t) => ({
            ...t,
            pendingRequests: t.pendingRequests.filter((r) => r.id !== event.requestId),
          })),
        }));
        return;
      case "thread.queue":
        set((s) => ({
          byId: patch(s.byId, event.threadId, (t) => ({ ...t, queue: event.queue })),
        }));
        return;
      case "thread.identity":
        set((s) => ({
          byId: patch(s.byId, event.threadId, (t) => ({ ...t, identity: event.identity })),
        }));
        return;
      case "thread.usage":
        set((s) =>
          s.byId[event.threadId] ? { usage: { ...s.usage, [event.threadId]: event.usage } } : {},
        );
        return;
      case "thread.plan":
        // The todo list moves with every step the agent ticks off, and the sidebar shows none of it,
        // so only a change to the thread's plan touches `byId`.
        // A late plan for a thread already removed would come back with it if it were reopened.
        set((s) => ({
          plans: s.byId[event.threadId] ? { ...s.plans, [event.threadId]: event.items } : s.plans,
          byId: patch(s.byId, event.threadId, (t) => {
            if (samePlan(t.plan, event.plan)) return t;
            const { plan: _old, ...rest } = t;
            return event.plan === undefined ? rest : { ...rest, plan: event.plan };
          }),
        }));
        return;
      case "thread.waits":
        set((s) => ({
          byId: patch(s.byId, event.threadId, (t) => {
            const { waits: _old, helperResolved: _resolved, ...rest } = t;
            return {
              ...rest,
              ...(event.waits.length === 0 ? {} : { waits: event.waits }),
              ...(event.helperResolved === undefined || event.helperResolved.length === 0
                ? {}
                : { helperResolved: event.helperResolved }),
            };
          }),
        }));
        return;
      case "git.state":
        set((s) => ({
          byId: patch(s.byId, event.threadId, (t) => ({ ...t, git: event.state })),
        }));
        return;
      case "thread.ports":
        set((s) => ({
          byId: patch(s.byId, event.threadId, (t) => ({ ...t, ports: event.ports })),
        }));
        return;
      case "thread.background":
        set((s) => ({
          byId: patch(s.byId, event.threadId, (t) => ({ ...t, background: event.tasks })),
        }));
        return;
      case "thread.backgroundOutput": {
        const { type: _type, threadId: _threadId, ...output } = event;
        set((s) => ({
          byId: patch(s.byId, event.threadId, (t) => ({
            ...t,
            // Kept past the task's end, so a finished shell still shows what it last wrote; only
            // the newest few, as the server sends each running task's whole tail again.
            backgroundOutput: [
              ...(t.backgroundOutput ?? []).filter((each) => each.taskId !== output.taskId),
              output,
            ].slice(-BACKGROUND_OUTPUTS_KEPT),
          })),
        }));
        return;
      }
      case "thread.pendingRestart":
        set((s) => ({
          byId: patch(s.byId, event.threadId, (t) => {
            const { pendingRestart: _, ...rest } = t;
            return event.reason === undefined ? rest : { ...rest, pendingRestart: event.reason };
          }),
        }));
        return;
      case "thread.lapsedConnectors": {
        useLapsedDismissals.getState().prune(event.threadId, event.names);
        set((s) => ({
          byId: patch(s.byId, event.threadId, (t) => {
            const { lapsedConnectors: _, ...rest } = t;
            return event.names.length === 0 ? rest : { ...rest, lapsedConnectors: event.names };
          }),
        }));
        return;
      }
      case "thread.terminalProcesses":
        set((s) => ({
          byId: patch(s.byId, event.threadId, (t) => ({
            ...t,
            terminalProcesses: event.processes,
          })),
        }));
        return;
      case "thread.suggestions":
        useSuggestionsStore.getState().offer(event);
        return;
      case "notify":
        if (!useNotificationHistory.getState().record(event)) return;
        set((s) => ({
          notifications: [...s.notifications.slice(-19), { ...event, at: Date.now() }],
        }));
        return;
      case "rateLimit": {
        const at = Date.now();
        const notify: Notify = {
          type: "notify",
          kind: "info",
          title: rateLimitTitle(event, at),
          threadId: event.threadId,
          at,
        };
        useNotificationHistory.getState().record(notify, notify.at);
        set((s) => ({ notifications: [...s.notifications.slice(-19), notify] }));
        return;
      }
      case "usageLimit":
        useUsageLimits.getState().record(event);
        return;
      case "usageLimits.snapshot":
        useUsageLimits.getState().replace(event.limits);
        return;
      case "ui.showPanel":
        set(() => ({ showPanel: event }));
        return;
      case "pr.reviewRound": {
        // The Review tab refetches through the `git.state` that accompanies a round; this is the toast.
        // Approval or changes requested on head is the user's cue, so it notifies natively too.
        const verdict = event.round.verdictOnHead;
        const notify: Notify = {
          type: "notify",
          kind:
            verdict === "approved"
              ? "done"
              : verdict === "changesRequested"
                ? "needsInput"
                : "info",
          title: reviewRoundTitle(event.round),
          body: reviewRoundBody(event.round.counts),
          threadId: event.threadId,
          at: Date.now(),
        };
        useNotificationHistory.getState().record(notify, notify.at);
        set((s) => ({ notifications: [...s.notifications.slice(-19), notify] }));
        return;
      }
      case "keybindings.changed":
        useBindingsStore.getState().apply(event.keybindings);
        return;
      case "profiles.changed":
      case "settings.changed":
      case "reviewRequests.changed":
      case "openPrs.changed":
      case "threadWakes.changed":
      case "workspaces.changed":
      case "orchestration.changed":
      case "memory.changed":
      case "dreams.changed":
      case "outputs.changed":
        // Only query caches hold these, and `useServerEvents` invalidates them; it also pulls the
        // settings again on `settings.changed`.
        return;
      default:
        // A new server event must be handled here rather than silently dropped.
        event satisfies never;
    }
  },

  setQueue(threadId, queue) {
    set((s) => ({ byId: patch(s.byId, threadId, (t) => ({ ...t, queue })) }));
  },

  setSortOrders(orders) {
    set((s) => {
      let byId = s.byId;
      for (const [threadId, sortOrder] of Object.entries(orders)) {
        byId = patch(byId, threadId, (t) => {
          if (t.thread.sortOrder === sortOrder) return t;
          const { sortOrder: _previous, ...rest } = t.thread;
          return { ...t, thread: sortOrder === undefined ? rest : { ...rest, sortOrder } };
        });
      }
      return { byId };
    });
  },
});

export const useThreadsStore = create<ThreadsState>()((set) => createThreadsSlice(set));

/** Applies the server events still waiting for their frame, set while `useServerEvents` runs. */
let flushPending: (() => void) | undefined;

/**
 * Applies at once the server events `useServerEvents` holds for the next frame. A read that must
 * see every event the server sent before an answer it just gave (`closeThread`) flushes first.
 */
export const flushServerEvents = () => flushPending?.();

/** How deep in applying a batch of server events we are; 0 outside one. */
let applying = 0;
/** What waits for the batch being applied to end, each once however often it was asked for. */
const settling = new Set<() => void>();

/**
 * Runs `apply`, a batch of server events applied one by one, then whatever asked meanwhile to run
 * once it ends (`whenServerEventsSettle`).
 */
export const applyServerEvents = (apply: () => void) => {
  applying++;
  try {
    apply();
  } finally {
    applying--;
    if (applying === 0) {
      for (const run of settling) {
        settling.delete(run);
        try {
          run();
        } catch (error) {
          console.error("deriving after server events failed", error);
        }
      }
    }
  }
};

/**
 * Runs `run` now, or, while a batch of server events is being applied, once at its end: a
 * derivation from the stores that every event of a burst would otherwise run again. It still runs
 * before React renders the batch, which happens after the task that applies it.
 */
export const whenServerEventsSettle = (run: () => void) => {
  if (applying === 0) run();
  else settling.add(run);
};

/** Registers the flush `flushServerEvents` runs; the returned function takes it back. */
export const setServerEventsFlush = (flush: () => void) => {
  flushPending = flush;
  return () => {
    if (flushPending === flush) flushPending = undefined;
  };
};

// ---------------------------------------------------------------------------------------------
// Closing: the store follows the server's answer, not only its event.

/**
 * Drops a thread the server has said is closed. Every list, the Workspaces tree and its Done row
 * included, holds a summary until `thread.removed` takes it out, and nothing else did: a client
 * that missed that event kept the row for good, opening onto "This thread no longer exists".
 */
export const forgetClosedThread = (threadId: ThreadId) => {
  const { byId, applyEvent } = useThreadsStore.getState();
  if (byId[threadId] !== undefined) applyEvent({ type: "thread.removed", threadId });
};

/**
 * Closes a thread and, once the server says it did, drops it here (`forgetClosedThread`), unless
 * what holds its id now is a reopen from another window, which keeps the id. The server publishes
 * `thread.removed` before the close answers, so a summary seen gone since is a reopen; and since a
 * resync snapshot can bring one back unseen, so is one with a later `createdAt`, which the server
 * sets anew on reopening.
 */
export const closeThread = async (
  api: { closeThread(threadId: ThreadId, options?: CloseThreadOptions): Promise<WorktreeRemoval> },
  threadId: ThreadId,
  options?: CloseThreadOptions,
): Promise<WorktreeRemoval> => {
  const lifetime = useThreadsStore.getState().byId[threadId]?.thread.createdAt;
  let removed = lifetime === undefined;
  const unsubscribe = useThreadsStore.subscribe((state) => {
    if (state.byId[threadId] === undefined) removed = true;
  });
  try {
    // Called as the caller would, so an absent `options` isn't passed as `undefined`.
    const result = await (options === undefined
      ? api.closeThread(threadId)
      : api.closeThread(threadId, options));
    // The removal the server sent before answering may still be waiting for its frame.
    flushServerEvents();
    const now = useThreadsStore.getState().byId[threadId]?.thread.createdAt;
    if (!removed && now === lifetime) forgetClosedThread(threadId);
    return result;
  } finally {
    unsubscribe();
  }
};

// ---------------------------------------------------------------------------------------------
// Queue operations: optimistic locally, rolled back if the server rejects.

interface QueueApi {
  queueEdit(threadId: ThreadId, itemId: QueueItemId, input: UserInput): Promise<void>;
  queueReorder(threadId: ThreadId, itemIds: readonly QueueItemId[]): Promise<void>;
  queueRemove(threadId: ThreadId, itemId: QueueItemId): Promise<void>;
  queueSteer(threadId: ThreadId, itemId: QueueItemId): Promise<void>;
}

type QueueStore = Pick<ThreadsState, "byId" | "setQueue">;

async function optimistic(
  getState: () => QueueStore,
  threadId: ThreadId,
  next: (queue: readonly QueuedInput[]) => readonly QueuedInput[],
  commit: () => Promise<void>,
) {
  const previous = getState().byId[threadId]?.queue;
  if (!previous) return;
  const guessed = next(previous);
  getState().setQueue(threadId, guessed);
  try {
    await commit();
  } catch (error) {
    // Only over the guess: a queue the server sent meanwhile (a turn took an item, another window
    // added one) is what the queue is now, and putting `previous` back would undo it.
    if (getState().byId[threadId]?.queue === guessed) getState().setQueue(threadId, previous);
    throw error;
  }
}

export const queueOps = {
  edit: (
    api: QueueApi,
    getState: () => QueueStore,
    threadId: ThreadId,
    itemId: QueueItemId,
    input: UserInput,
  ) =>
    optimistic(
      getState,
      threadId,
      (q) => q.map((item) => (item.id === itemId ? { ...item, input } : item)),
      () => api.queueEdit(threadId, itemId, input),
    ),
  remove: (api: QueueApi, getState: () => QueueStore, threadId: ThreadId, itemId: QueueItemId) =>
    optimistic(
      getState,
      threadId,
      (q) => q.filter((item) => item.id !== itemId),
      () => api.queueRemove(threadId, itemId),
    ),
  /**
   * Sends the item into the running turn, or with none running as the next one; the server drops
   * it from the queue once it lands.
   */
  steer: (api: QueueApi, getState: () => QueueStore, threadId: ThreadId, itemId: QueueItemId) =>
    optimistic(
      getState,
      threadId,
      (q) => q.filter((item) => item.id !== itemId),
      () => api.queueSteer(threadId, itemId),
    ),
  /** Moves `itemId` by `delta` positions, clamped to the queue bounds. */
  move: (
    api: QueueApi,
    getState: () => QueueStore,
    threadId: ThreadId,
    itemId: QueueItemId,
    delta: number,
  ) => {
    const queue = getState().byId[threadId]?.queue ?? [];
    const from = queue.findIndex((item) => item.id === itemId);
    if (from === -1) return Promise.resolve();
    const to = Math.max(0, Math.min(queue.length - 1, from + delta));
    if (to === from) return Promise.resolve();
    const reordered = [...queue];
    const [item] = reordered.splice(from, 1);
    reordered.splice(to, 0, item!);
    return optimistic(
      getState,
      threadId,
      () => reordered,
      () =>
        api.queueReorder(
          threadId,
          reordered.map((i) => i.id),
        ),
    );
  },
};
