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
import { agentOwnsPrEvents } from "@gram/contracts";
import { create } from "zustand";

import type { ApiServerEvent, CloseThreadOptions } from "@/api/types";
import { useBindingsStore } from "@/keyboard/bindings-store";
import { endWebRtcWhereAgentsWork } from "@/panels/preview-webrtc";
import { limitPercent, resetText, windowWord } from "@/usage/limit-format";

import { useNotificationHistory } from "./notifications";
import { useLapsedDismissals } from "./lapsed-connectors";
import { useMachines } from "./machines";
import { useSuggestionsStore } from "./suggestions";
import { useThreadHistory } from "./thread-history";
import { useUsageLimits } from "./usage-limits";

type Notify = Extract<ServerEvent, { type: "notify" }> & { at: number };
type RateLimit = Extract<ServerEvent, { type: "rateLimit" }>;
type ShowPanel = Extract<ServerEvent, { type: "ui.showPanel" }>;

/**
 * Whether a recorded notice also toasts. An `info` start-up diagnostic is about the machine or its
 * harness (a CLI's version, an MCP server, the shell probe), not the thread that happened to start:
 * it goes to Notification history, whose unread count says it's there, and toasts only when it
 * offers something to do (`action`). Everything else, about a thread or the user's own action,
 * toasts as before.
 */
export const toasts = (event: Pick<Notify, "kind" | "startupDiagnostic" | "action">): boolean =>
  event.kind !== "info" || event.startupDiagnostic === undefined || event.action !== undefined;

/**
 * The toast list with `next` added, the same notice already in it (kind, title and body) taken
 * out: a repeat, from this thread or another, shows once, as the latest, not stacked.
 */
export const withToast = (list: readonly Notify[], next: Notify): readonly Notify[] => [
  ...list
    .filter((n) => n.kind !== next.kind || n.title !== next.title || n.body !== next.body)
    .slice(-19),
  next,
];

const VERDICT_TITLE: Record<ReviewVerdict, string> = {
  approved: "approved",
  changesRequested: "changes requested",
  commented: "commented",
};

const reviewRoundTitle = (round: ReviewRound) =>
  `Review round ${round.number}${round.verdict ? `: ${VERDICT_TITLE[round.verdict]}` : " finished"}`;

const reviewRoundBody = ({ blockers, unresolved }: ReviewRound["counts"]) =>
  unresolved === 0 ? "No unresolved findings" : `${blockers} blocking, ${unresolved} unresolved`;

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

const sameCompaction = (a: CompactionActivity | undefined, b: CompactionActivity | undefined) =>
  a === b ||
  (a?.startedAt === b?.startedAt && a?.trigger === b?.trigger && a?.preTokens === b?.preTokens);

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
  get?: () => ThreadsState,
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
        useSuggestionsStore.getState().reset();
        useLapsedDismissals
          .getState()
          .reconcile(
            Object.fromEntries(event.threads.map((t) => [t.thread.id, t.lapsedConnectors ?? []])),
          );
        set(() => ({
          ready: true,
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
        endWebRtcWhereAgentsWork(Object.fromEntries(event.threads.map((t) => [t.thread.id, t])));
        return;
      case "thread.upsert":
        set((s) => {
          const current = s.byId[event.thread.id];
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
        if (event.status === "starting" || event.status === "running") {
          useSuggestionsStore.getState().clear(event.threadId);
        }
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
        if (get !== undefined) endWebRtcWhereAgentsWork(get().byId, [event.threadId]);
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
          byId: patch(s.byId, event.threadId, (t) => ({
            ...t,
            identity: event.identity,
            ...(event.capabilities === undefined ? {} : { capabilities: event.capabilities }),
          })),
        }));
        return;
      case "thread.usage":
        set((s) =>
          s.byId[event.threadId] ? { usage: { ...s.usage, [event.threadId]: event.usage } } : {},
        );
        return;
      case "thread.plan":
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
        if (!useNotificationHistory.getState().record(event) || !toasts(event)) return;
        set((s) => ({ notifications: withToast(s.notifications, { ...event, at: Date.now() }) }));
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
        set((s) => ({ notifications: withToast(s.notifications, notify) }));
        return;
      }
      case "usageLimit":
        useUsageLimits.getState().record(event);
        return;
      case "usageLimits.snapshot":
        useUsageLimits.getState().replace(event.limits);
        return;
      case "machines.snapshot":
        useMachines.getState().replace(event.machines);
        return;
      case "ui.showPanel":
        set(() => ({ showPanel: event }));
        return;
      case "pr.reviewRound": {
        const owner = get?.().byId[event.threadId]?.thread;
        if (owner !== undefined && agentOwnsPrEvents(owner)) return;
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
        set((s) => ({ notifications: withToast(s.notifications, notify) }));
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
      case "routines.changed":
      case "outputs.changed":
      case "docs.changed":
      case "pages.changed":
        return;
      default:
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

export const useThreadsStore = create<ThreadsState>()((set, get) => createThreadsSlice(set, get));

let flushPending: (() => void) | undefined;

/**
 * Applies at once the server events `useServerEvents` holds for the next frame. A read that must
 * see every event the server sent before an answer it just gave (`closeThread`) flushes first.
 */
export const flushServerEvents = () => flushPending?.();

let applying = 0;
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
    const result = await (options === undefined
      ? api.closeThread(threadId)
      : api.closeThread(threadId, options));
    flushServerEvents();
    const now = useThreadsStore.getState().byId[threadId]?.thread.createdAt;
    if (!removed && now === lifetime) forgetClosedThread(threadId);
    return result;
  } finally {
    unsubscribe();
  }
};

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
