import { describe, expect, it } from "@effect/vitest";
import type {
  Thread,
  ThreadId,
  TurnId,
  UsageSummary,
  UserInput,
  WorkspaceId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import type { ComposerHold } from "../runtime/composer-presence.ts";
import type { DeliveryRest, SystemDelivery } from "../runtime/thread-runtimes.ts";
import {
  cacheTtlOf,
  IDLE_COMPACT_AFTER_MS,
  IDLE_COMPACT_LATEST_MS,
  IDLE_COMPACT_MIN_CONTEXT,
  IDLE_COMPACT_MIN_IDLE_MS,
  IDLE_COMPACT_RETRY_MS,
  idleCompactionCost,
  makeIdleCompactor,
  planIdleCompact,
  restHold,
  type IdleCompactHold,
  type IdleCompactScope,
} from "./idle-compact.ts";

// Synthetic only: an invented thread on an invented Claude model; no CLI, login or provider.
const threadId = "t-idle" as ThreadId;
const workspaceId = "w-idle" as WorkspaceId;
const claude = { model: { agent: "claude", model: "fake-opus" } } as Pick<Thread, "model">;
const thread = { id: threadId, ...claude } as Thread;
const scope: IdleCompactScope = {
  workspaceId,
  enabled: true,
  kind: "orchestrator",
  kinds: ["orchestrator"],
};
const MIN = 60_000;
const usageAt = (anchor: number, overrides: Partial<UsageSummary> = {}): UsageSummary => ({
  tokens: { inputTokens: 4, outputTokens: 900, cacheReadTokens: 400_000, cacheWriteTokens: 3_000 },
  contextTokens: 400_000,
  cacheWrites: { fiveMinute: 0, oneHour: 3_000 },
  lastRequestAt: anchor,
  ...overrides,
});
const ended = (at: number, turnId = "turn-1") => ({
  turnId: turnId as TurnId,
  reason: "completed" as const,
  synthesized: false,
  queueEmpty: true,
  endedAt: at,
});
const atRest: DeliveryRest = { status: "idle", background: 0, subagentsRunning: false, waiting: 0 };

const plan = (input: Partial<Parameters<typeof planIdleCompact>[0]> = {}) =>
  planIdleCompact({
    thread: claude,
    scope,
    usage: usageAt(0),
    end: ended(MIN),
    ...input,
  });

describe("planIdleCompact", () => {
  it("compacts 55 minutes after the anchor, before the cache can expire", () => {
    expect(plan()).toEqual({
      at: IDLE_COMPACT_AFTER_MS,
      deadline: IDLE_COMPACT_LATEST_MS,
      contextTokens: 400_000,
    });
  });

  it("waits at least ten idle minutes after a turn that ended late", () => {
    const end = 46 * MIN;
    expect(plan({ end: ended(end) })).toMatchObject({ at: end + IDLE_COMPACT_MIN_IDLE_MS });
    // Ending later still leaves no warm moment ten minutes on: skip, never compact cold.
    expect(plan({ end: ended(52 * MIN) })).toEqual({ skip: "tooLate" });
  });

  it("is off when the workspace turned it off, or for a kind it doesn't cover", () => {
    expect(plan({ scope: { ...scope, enabled: false } })).toEqual({ skip: "disabled" });
    expect(plan({ scope: undefined })).toEqual({ skip: "disabled" });
    expect(plan({ scope: { ...scope, kind: "worker" } })).toEqual({ skip: "kind" });
    expect(
      plan({ scope: { ...scope, kind: "worker", kinds: ["orchestrator", "worker"] } }),
    ).toEqual(expect.objectContaining({ contextTokens: 400_000 }));
  });

  it("runs for Claude only", () => {
    expect(plan({ thread: { model: { agent: "codex", model: "gpt" } } as never })).toEqual({
      skip: "agent",
    });
  });

  it(`needs at least ${IDLE_COMPACT_MIN_CONTEXT} tokens of context`, () => {
    expect(plan({ usage: usageAt(0, { contextTokens: IDLE_COMPACT_MIN_CONTEXT - 1 }) })).toEqual({
      skip: "small",
    });
    expect(plan({ usage: usageAt(0, { contextTokens: IDLE_COMPACT_MIN_CONTEXT }) })).toMatchObject({
      contextTokens: IDLE_COMPACT_MIN_CONTEXT,
    });
  });

  it("skips a five-minute or unknown TTL", () => {
    expect(
      plan({ usage: usageAt(0, { cacheWrites: { fiveMinute: 10, oneHour: 3_000 } }) }),
    ).toEqual({ skip: "ttl" });
    const { cacheWrites: _, ...noSplit } = usageAt(0);
    expect(plan({ usage: noSplit })).toEqual({ skip: "ttl" });
    expect(plan({ usage: usageAt(0, { cacheWrites: { fiveMinute: 0, oneHour: 0 } }) })).toEqual({
      skip: "ttl",
    });
  });

  it("needs the anchor, and never plans after its own compaction", () => {
    const { lastRequestAt: _, ...noAnchor } = usageAt(0);
    expect(plan({ usage: noAnchor })).toEqual({ skip: "noUsage" });
    expect(plan({ usage: undefined })).toEqual({ skip: "noUsage" });
    expect(plan({ end: { ...ended(MIN), idleCompaction: "completed" } })).toEqual({
      skip: "idleCompaction",
    });
  });

  it("tries again after one that didn't complete only once the context grew", () => {
    expect(plan({ lastAttempt: 400_000 })).toEqual({ skip: "attempted" });
    expect(plan({ lastAttempt: 360_000 })).toMatchObject({ contextTokens: 400_000 });
  });
});

describe("cost model", () => {
  it("pays at least twice its cost at the threshold, and never below about 85k tokens", () => {
    const at = idleCompactionCost(IDLE_COMPACT_MIN_CONTEXT);
    expect(at.saving / at.cost).toBeGreaterThanOrEqual(2);
    expect(idleCompactionCost(85_000).net).toBeLessThan(0);
    expect(idleCompactionCost(IDLE_COMPACT_MIN_CONTEXT).net).toBeGreaterThan(0);
  });

  it("reads the TTL only from writes that asked for an hour and nothing shorter", () => {
    expect(cacheTtlOf({ fiveMinute: 0, oneHour: 1 })).toBe("1h");
    expect(cacheTtlOf({ fiveMinute: 1, oneHour: 9 })).toBe("5m");
    expect(cacheTtlOf({ fiveMinute: 0, oneHour: 0 })).toBeUndefined();
    expect(cacheTtlOf(undefined)).toBeUndefined();
  });

  it("holds a thread that is not wholly at rest", () => {
    expect(restHold(atRest)).toBeUndefined();
    expect(restHold({ ...atRest, status: "error" })).toBe("notAtRest");
    expect(restHold({ ...atRest, background: 1 })).toBe("notAtRest");
    expect(restHold({ ...atRest, subagentsRunning: true })).toBe("notAtRest");
    expect(restHold({ ...atRest, waiting: 1 })).toBe("notAtRest");
  });
});

/** A compactor over stubs: the deliveries it asks for, and switches for each hold. */
const harness = Effect.gen(function* () {
  const requests: Array<SystemDelivery> = [];
  const compacted: Array<string> = [];
  const state = {
    usage: usageAt(0) as UsageSummary | undefined,
    presence: undefined as ComposerHold | undefined,
    held: undefined as IdleCompactHold | undefined,
    scope: scope as IdleCompactScope | undefined,
  };
  const compactor = yield* makeIdleCompactor({
    runtimes: {
      requestSystemDelivery: (_threadId, _key, delivery) =>
        Effect.sync(() => void requests.push(delivery)),
    },
    store: {
      lastTurnUsage: () => Effect.sync(() => state.usage),
      getThread: () => Effect.succeed(thread),
    },
    presence: { holdOf: () => Effect.sync(() => state.presence) },
    scope: () => Effect.sync(() => state.scope),
    held: () => Effect.sync(() => state.held),
    compacted: (t) => Effect.sync(() => void compacted.push(t.id)),
  });
  const build = (rest: DeliveryRest = atRest) =>
    requests.at(-1)!.build("turn-c" as TurnId, rest) as Effect.Effect<UserInput | undefined>;
  return { compactor, requests, compacted, state, build };
});

/** Plans one compaction from now and lets it fall due. */
const due = (h: Effect.Success<typeof harness>) =>
  Effect.gen(function* () {
    yield* h.compactor.onTurnEnd(thread, ended(MIN));
    yield* TestClock.adjust(IDLE_COMPACT_AFTER_MS);
    expect(h.requests).toHaveLength(1);
  });

describe("makeIdleCompactor", () => {
  it.effect("sends /compact with its notice at 55 minutes, not before", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.compactor.onTurnEnd(thread, ended(MIN));
      yield* TestClock.adjust(IDLE_COMPACT_AFTER_MS - 1);
      expect(h.requests).toHaveLength(0);
      yield* TestClock.adjust(1);
      expect(h.requests).toHaveLength(1);
      expect(yield* h.build()).toEqual({
        text: "/compact",
        notice: { kind: "idleCompact", contextTokens: 400_000, workspaceId },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("a new turn cancels the waiting compaction", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.compactor.onTurnEnd(thread, ended(MIN));
      yield* h.compactor.onTurnStart(threadId);
      yield* TestClock.adjust(IDLE_COMPACT_AFTER_MS);
      expect(h.requests).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  for (const hold of ["typing", "draft", "unknownWindow"] as const) {
    it.effect(`waits while the composers say ${hold}, and gives up at the deadline`, () =>
      Effect.gen(function* () {
        const h = yield* harness;
        h.state.presence = hold;
        yield* h.compactor.onTurnEnd(thread, ended(MIN));
        yield* TestClock.adjust(IDLE_COMPACT_AFTER_MS + IDLE_COMPACT_RETRY_MS);
        expect(h.requests).toHaveLength(0);
        // It passes before the deadline: sent then.
        h.state.presence = undefined;
        yield* TestClock.adjust(IDLE_COMPACT_RETRY_MS);
        expect(h.requests).toHaveLength(1);
      }).pipe(Effect.scoped),
    );
  }

  it.effect("never sends once the deadline passed while something held it", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.state.presence = "draft";
      yield* h.compactor.onTurnEnd(thread, ended(MIN));
      yield* TestClock.adjust(IDLE_COMPACT_LATEST_MS);
      h.state.presence = undefined;
      yield* TestClock.adjust(10 * MIN);
      expect(h.requests).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect("waits out an open question or a held thread like a draft", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.state.held = "question";
      yield* h.compactor.onTurnEnd(thread, ended(MIN));
      yield* TestClock.adjust(IDLE_COMPACT_AFTER_MS + IDLE_COMPACT_RETRY_MS);
      expect(h.requests).toHaveLength(0);
      h.state.held = undefined;
      yield* TestClock.adjust(IDLE_COMPACT_RETRY_MS);
      expect(h.requests).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("drops at send when the thread isn't wholly at rest", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* due(h);
      expect(yield* h.build({ ...atRest, background: 1 })).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("drops at send when a draft appeared after it fell due", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* due(h);
      h.state.presence = "draft";
      expect(yield* h.build()).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("drops at send once its deadline passed (a limit wait held it)", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* due(h);
      yield* TestClock.adjust(IDLE_COMPACT_LATEST_MS - IDLE_COMPACT_AFTER_MS + 1);
      expect(yield* h.build()).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("drops at send when a turn started after it was planned", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* due(h);
      yield* h.compactor.onTurnStart(threadId);
      expect(yield* h.build()).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("drops at send when the user turned it off meanwhile", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.compactor.onTurnEnd(thread, ended(MIN));
      yield* TestClock.adjust(IDLE_COMPACT_AFTER_MS);
      h.state.scope = { ...scope, enabled: false };
      expect(yield* h.build()).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("owes the boot context after a completed compaction, and plans no second one", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.compactor.onTurnEnd(thread, { ...ended(MIN), idleCompaction: "completed" });
      expect(h.compacted).toEqual([threadId]);
      yield* TestClock.adjust(2 * IDLE_COMPACT_AFTER_MS);
      expect(h.requests).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect("doesn't owe the boot context after one that failed or said nothing", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.compactor.onTurnEnd(thread, { ...ended(MIN), idleCompaction: "failed" });
      yield* h.compactor.onTurnEnd(thread, { ...ended(MIN), idleCompaction: "unknown" });
      expect(h.compacted).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("after one that didn't complete, waits for the context to grow", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.compactor.onTurnEnd(thread, ended(MIN));
      yield* TestClock.adjust(IDLE_COMPACT_AFTER_MS);
      expect(yield* h.build()).toBeDefined();
      yield* h.compactor.onTurnEnd(thread, { ...ended(MIN, "turn-c"), idleCompaction: "unknown" });
      // The next real turn, at the same context: nothing new to compact.
      yield* h.compactor.onTurnEnd(thread, ended(MIN, "turn-4"));
      yield* TestClock.adjust(IDLE_COMPACT_AFTER_MS);
      expect(h.requests).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
});
