/*
 * Idle compaction (docs/AGENTS_AND_FEATURES.md#idle-compaction): a large thread that has sat idle
 * is compacted with its agent's own `/compact` just before its prompt cache expires, so the next
 * wake starts from a summary instead of rewriting the whole conversation into the cache. It is a turn nobody asked
 * for, so it runs only for Claude, on a thread wholly at rest, when the cache's lifetime is known
 * to be an hour, and never while the user may be about to type into it.
 */
import type {
  CacheWriteSplit,
  IdleCompactKind,
  Thread,
  ThreadId,
  TurnId,
  UsageSummary,
  UserInput,
  WorkspaceId,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import type * as Scope from "effect/Scope";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import type { ComposerHold, ComposerPresenceShape } from "../runtime/composer-presence.ts";
import type {
  DeliveryRest,
  ObservedTurnEnd,
  ThreadRuntimesShape,
} from "../runtime/thread-runtimes.ts";

/** The delivery key: one idle compaction waits per thread at most. */
const IDLE_COMPACT_KEY = "idle-compact";
/** Below this much context compaction can't pay for itself; see `idleCompactionSaving`. */
export const IDLE_COMPACT_MIN_CONTEXT = 150_000;
/** The one-hour TTL Claude Code asks for while usage is within a subscription's limits. */
const ONE_HOUR_TTL_MS = 60 * 60_000;
/** Compact this long after the anchor: five minutes before the cache entry can expire. */
export const IDLE_COMPACT_AFTER_MS = 55 * 60_000;
/** And never sooner than this after the turn ended. */
export const IDLE_COMPACT_MIN_IDLE_MS = 10 * 60_000;
/** The last moment to start: later, the compaction itself may read an expired cache. */
export const IDLE_COMPACT_LATEST_MS = ONE_HOUR_TTL_MS - 60_000;
/** While the user types or a draft waits, look again this often until `IDLE_COMPACT_LATEST_MS`. */
export const IDLE_COMPACT_RETRY_MS = 30_000;
/** After one that didn't complete, another needs the context to have grown by this share. */
const IDLE_COMPACT_REGROWTH = 1.1;

/**
 * The cost model in input-token equivalents, at Anthropic's ratios to the uncached input price for a
 * one-hour cache: reads 0.1× (0.05× on Opus 5.5; 0.1× is the conservative case), writes 2×, output
 * 5×. `S` is the context left after compaction, `O` the summary written and `A` the request.
 */
const COST = {
  read: 0.1,
  write: 2,
  output: 5,
  after: 50_000,
  summary: 12_000,
  request: 2_000,
  /** Idle periods over 45 minutes that ended with another turn, measured 14–20 October 2026. */
  returnRate: 0.97,
} as const;

/** What compacting a `contextTokens` context costs, and what a later cold wake saves by it. */
export const idleCompactionCost = (contextTokens: number) => {
  const cost = COST.read * contextTokens + COST.write * COST.request + COST.output * COST.summary;
  const saving = COST.returnRate * COST.write * (contextTokens - COST.after);
  return { cost, saving, net: saving - cost };
};

/** The TTL a turn's cache writes asked for: only an hour that nothing shorter shares is known. */
export const cacheTtlOf = (writes: CacheWriteSplit | undefined): "1h" | "5m" | undefined =>
  writes === undefined
    ? undefined
    : writes.fiveMinute > 0
      ? "5m"
      : writes.oneHour > 0
        ? "1h"
        : undefined;

export type IdleCompactSkip =
  | "disabled"
  | "kind"
  | "agent"
  | "noUsage"
  | "small"
  | "ttl"
  | "tooLate"
  | "idleCompaction"
  | "attempted";

export interface IdleCompactScope {
  readonly workspaceId: WorkspaceId;
  readonly enabled: boolean;
  readonly kind: IdleCompactKind;
  readonly kinds: ReadonlyArray<IdleCompactKind>;
}

export interface IdleCompactPlan {
  /** Epoch ms to compact. */
  readonly at: number;
  /** Epoch ms after which it must not start. */
  readonly deadline: number;
  readonly contextTokens: number;
}

/**
 * When to compact the thread whose turn just ended, or why not. Pure, so every rule has a test.
 * `lastAttempt` is the context a compaction of this thread started from that didn't complete.
 */
export const planIdleCompact = (input: {
  readonly thread: Pick<Thread, "model">;
  readonly scope: IdleCompactScope | undefined;
  readonly usage: UsageSummary | undefined;
  readonly end: Pick<ObservedTurnEnd, "endedAt" | "idleCompaction">;
  readonly lastAttempt?: number | undefined;
}): IdleCompactPlan | { readonly skip: IdleCompactSkip } => {
  const { thread, scope, usage, end } = input;
  if (scope === undefined || !scope.enabled) return { skip: "disabled" };
  if (!scope.kinds.includes(scope.kind)) return { skip: "kind" };
  if (thread.model.agent !== "claude") return { skip: "agent" };
  // The compaction's own end: its context is the summary, and this generation is done.
  if (end.idleCompaction !== undefined) return { skip: "idleCompaction" };
  const context = usage?.contextTokens;
  if (usage === undefined || context === undefined || usage.lastRequestAt === undefined) {
    return { skip: "noUsage" };
  }
  if (context < IDLE_COMPACT_MIN_CONTEXT) return { skip: "small" };
  if (input.lastAttempt !== undefined && context < input.lastAttempt * IDLE_COMPACT_REGROWTH) {
    return { skip: "attempted" };
  }
  if (cacheTtlOf(usage.cacheWrites) !== "1h") return { skip: "ttl" };
  const anchor = usage.lastRequestAt;
  const endedAt = end.endedAt ?? anchor;
  const at = Math.max(anchor + IDLE_COMPACT_AFTER_MS, endedAt + IDLE_COMPACT_MIN_IDLE_MS);
  const deadline = anchor + IDLE_COMPACT_LATEST_MS;
  if (at > deadline) return { skip: "tooLate" };
  return { at, deadline, contextTokens: context };
};

/** Why a due compaction doesn't go now; `undefined` when nothing holds it. */
export type IdleCompactHold = ComposerHold | "notAtRest" | "user" | "question" | "turn";

/** The runtime's word at the moment it can send: a thread wholly at rest, or what isn't. */
export const restHold = (rest: DeliveryRest): IdleCompactHold | undefined =>
  rest.status !== "idle" || rest.background > 0 || rest.subagentsRunning || rest.waiting > 0
    ? "notAtRest"
    : undefined;

export interface IdleCompactDeps {
  readonly runtimes: Pick<ThreadRuntimesShape, "requestSystemDelivery">;
  readonly store: Pick<ThreadStoreShape, "lastTurnUsage" | "getThread">;
  readonly presence: Pick<ComposerPresenceShape, "holdOf">;
  /** The thread's workspace setting and kind; `undefined` for a thread in none. */
  readonly scope: (thread: Thread) => Effect.Effect<IdleCompactScope | undefined>;
  /**
   * What the user holds of it: a paused workspace, a held worker (`user`), or an open question
   * of the thread or its workspace (`question`). Reads the store only: it runs in a delivery.
   */
  readonly held: (thread: Thread) => Effect.Effect<IdleCompactHold | undefined>;
  /** A completed compaction: the orchestrator is owed its boot context (charter, memory) again. */
  readonly compacted: (thread: Thread, scope: IdleCompactScope) => Effect.Effect<void>;
}

const log = (message: string, threadId: ThreadId, fields: Record<string, unknown> = {}) =>
  Effect.logInfo(message).pipe(Effect.annotateLogs({ threadId, ...fields }));

export interface IdleCompactor {
  readonly onTurnStart: (threadId: ThreadId) => Effect.Effect<void>;
  readonly onTurnEnd: (thread: Thread, end: ObservedTurnEnd) => Effect.Effect<void>;
}

export const makeIdleCompactor = (
  deps: IdleCompactDeps,
): Effect.Effect<IdleCompactor, never, Scope.Scope> =>
  Effect.gen(function* () {
    const timers = yield* FiberMap.make<ThreadId>();
    /** The turn each thread's waiting compaction was planned after. */
    const planned = new Map<ThreadId, TurnId>();
    /** The context each thread's last compaction that didn't complete started from. */
    const attempts = new Map<ThreadId, number>();

    /** Everything but the runtime's own state, which only the delivery sees under its lock. */
    const holdNow = (threadId: ThreadId, after: TurnId) =>
      Effect.gen(function* () {
        if (planned.get(threadId) !== after) return "turn" as const;
        const thread = yield* deps.store.getThread(threadId).pipe(Effect.option);
        if (thread._tag === "None") return "turn" as const;
        const scope = yield* deps.scope(thread.value);
        if (scope === undefined || !scope.enabled || !scope.kinds.includes(scope.kind)) {
          return "user" as const;
        }
        return (yield* deps.presence.holdOf(threadId)) ?? (yield* deps.held(thread.value));
      });

    const dispatch = (
      thread: Thread,
      scope: IdleCompactScope,
      plan: IdleCompactPlan,
      after: TurnId,
    ) =>
      deps.runtimes
        .requestSystemDelivery(thread.id, IDLE_COMPACT_KEY, {
          build: (_turnId, rest) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              const hold =
                now > plan.deadline
                  ? "late"
                  : (restHold(rest) ?? (yield* holdNow(thread.id, after)));
              if (hold !== undefined) {
                yield* log("idle compaction dropped at send", thread.id, { hold });
                planned.delete(thread.id);
                return undefined;
              }
              const input: UserInput = {
                text: "/compact",
                notice: {
                  kind: "idleCompact",
                  contextTokens: plan.contextTokens,
                  workspaceId: scope.workspaceId,
                },
              };
              attempts.set(thread.id, plan.contextTokens);
              return input;
            }),
          accepted: () =>
            log("idle compaction started", thread.id, { context: plan.contextTokens }),
          failed: (_turnId, reason) =>
            Effect.sync(() => planned.delete(thread.id)).pipe(
              Effect.andThen(log("idle compaction not sent", thread.id, { reason })),
            ),
        })
        .pipe(Effect.ignore);

    /** Waits for `plan.at`, then sends unless something holds it; a passing hold is waited out. */
    const arm = (thread: Thread, scope: IdleCompactScope, plan: IdleCompactPlan, after: TurnId) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.sleep(Math.max(0, plan.at - now));
        for (;;) {
          const hold = yield* holdNow(thread.id, after);
          if (hold === undefined) return yield* dispatch(thread, scope, plan, after);
          if (hold === "turn" || hold === "user") {
            yield* log("idle compaction skipped", thread.id, { hold });
            return;
          }
          const at = yield* Clock.currentTimeMillis;
          if (at + IDLE_COMPACT_RETRY_MS > plan.deadline) {
            yield* log("idle compaction skipped", thread.id, { hold, reason: "deadline" });
            planned.delete(thread.id);
            return;
          }
          yield* Effect.sleep(IDLE_COMPACT_RETRY_MS);
        }
      });

    return {
      onTurnStart: (threadId) =>
        Effect.gen(function* () {
          planned.delete(threadId);
          yield* FiberMap.remove(timers, threadId);
        }),
      onTurnEnd: (thread, end) =>
        Effect.gen(function* () {
          yield* FiberMap.remove(timers, thread.id);
          planned.delete(thread.id);
          const scope = yield* deps.scope(thread);
          if (end.idleCompaction !== undefined) {
            if (end.idleCompaction === "completed") {
              attempts.delete(thread.id);
              if (scope !== undefined) yield* deps.compacted(thread, scope);
            }
            yield* log("idle compaction ended", thread.id, { outcome: end.idleCompaction });
          }
          const usage = yield* deps.store.lastTurnUsage(thread.id);
          const plan = planIdleCompact({
            thread,
            scope,
            usage,
            end,
            lastAttempt: attempts.get(thread.id),
          });
          if ("skip" in plan || scope === undefined) {
            if ("skip" in plan && plan.skip !== "disabled" && plan.skip !== "agent") {
              yield* Effect.logDebug("idle compaction not planned").pipe(
                Effect.annotateLogs({ threadId: thread.id, skip: plan.skip }),
              );
            }
            return;
          }
          planned.set(thread.id, end.turnId);
          yield* FiberMap.run(timers, thread.id, arm(thread, scope, plan, end.turnId));
        }),
    };
  });
