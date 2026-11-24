import {
  effectiveCheckout,
  embeddingOn,
  type HostId,
  hostOf,
  isLocalHost,
  type ThreadId,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { TimersShape } from "../embedding/timers.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { DRAFT_WINDOW_FORGET_MS } from "../runtime/composer-presence.ts";
import { RemoteHosts, type RemoteHostsShape } from "./remote-hosts.ts";

/**
 * How long before a scheduled wake its thread's stopped machine is asked for. A cold start of a
 * machine with its disk kept, its host's dial-in and its resume take about a minute, so the wake
 * finds it back. Inside this lead a wake asks for it at once.
 */
export const PRE_WAKE_LEAD_MS = 90_000;
/** How long past its wake's time a machine asked for early is still waited for. */
export const PRE_WAKE_PAST_MS = 60_000;
/** How long a machine asked for by a fresh draft is waited for before the ask lapses. */
export const DRAFT_PRE_WAKE_MS = 3 * 60_000;
/** A keystroke this close to a thread's first draft says the draft is being typed, not restored. */
export const DRAFT_TYPED_WITHIN_MS = 10_000;
/** The least time between two draft asks for one thread's machine. */
export const DRAFT_PRE_WAKE_AGAIN_MS = 10 * 60_000;
const BACK_LOOK = "1 second";

export type PreWakeReason = "wake" | "draft";

export interface MachinePreWakeShape {
  /**
   * Asks for the thread's machine ahead of work that is coming to it, and returns at once: when
   * the hosted features are on and the machine is joined and away, it is wanted
   * (`StopMarks.wanting`), so whoever runs it starts it, until it is back or `until` (epoch ms)
   * has passed. It asks nothing of a machine that is there, and once it is back it lets go, so a
   * machine started early is stopped when idle like any other.
   */
  readonly ahead: (threadId: ThreadId, until: number, why: PreWakeReason) => Effect.Effect<void>;
}

export class MachinePreWake extends Context.Service<MachinePreWake, MachinePreWakeShape>()(
  "@gram/server/MachinePreWake",
) {
  /** Asks for nothing: as with no layer at all. */
  static readonly off: MachinePreWakeShape = { ahead: () => Effect.void };
  static readonly layer = Layer.effect(
    MachinePreWake,
    Effect.gen(function* () {
      const remote = yield* Effect.serviceOption(RemoteHosts);
      if (Option.isNone(remote)) return MachinePreWake.off;
      const store = yield* ThreadStore;
      return yield* makeMachinePreWake({ remote: remote.value, store });
    }),
  );
}

/** `MachinePreWake`, from the machines and the thread store it reads. Scoped: holds end with it. */
export const makeMachinePreWake = (deps: {
  readonly remote: Pick<RemoteHostsShape, "machines" | "connection" | "stops">;
  readonly store: Pick<ThreadStore["Service"], "getThread" | "getSettings">;
}) =>
  Effect.gen(function* () {
    const { remote, store } = deps;
    const holds = yield* FiberMap.make<HostId>();
    const isBack = (id: HostId) =>
      remote.connection(id).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
    const waitBack = (id: HostId, until: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        while ((yield* Clock.currentTimeMillis) < until) {
          if (yield* isBack(id)) return;
          yield* Effect.sleep(BACK_LOOK);
        }
      });
    const ahead: MachinePreWakeShape["ahead"] = (threadId, until, why) =>
      Effect.gen(function* () {
        if (!embeddingOn(yield* store.getSettings)) return;
        const thread = yield* store.getThread(threadId);
        const checkout = effectiveCheckout(thread);
        if (isLocalHost(checkout)) return;
        const id = hostOf(checkout);
        if (remote.machines.get(id)?.confirmedAt === undefined) return;
        if (yield* isBack(id)) return;
        const now = yield* Clock.currentTimeMillis;
        if (until <= now) return;
        yield* Effect.logInfo("a machine is asked for ahead of its work").pipe(
          Effect.annotateLogs({ hostId: id, threadId, why, aheadMs: until - now }),
        );
        yield* FiberMap.run(holds, id, remote.stops.wanting(id, waitBack(id, until)), {
          onlyIfMissing: true,
        });
      }).pipe(Effect.ignore);
    return MachinePreWake.of({ ahead });
  });

/**
 * When a thread's machine is asked for by a draft: a thread that gets a draft in some window, with
 * a keystroke within `DRAFT_TYPED_WITHIN_MS` of it, so a draft a window brings back on opening asks
 * for nothing. Once a thread per `DRAFT_PRE_WAKE_AGAIN_MS`.
 */
export const makeDraftPreWake = (preWake: MachinePreWakeShape) =>
  Effect.sync(() => {
    const windows = new Map<
      string,
      { readonly at: number; readonly threads: ReadonlySet<string> }
    >();
    const fresh = new Map<ThreadId, number>();
    const asked = new Map<ThreadId, number>();
    let typedAt = Number.NEGATIVE_INFINITY;
    const ask = (now: number) =>
      Effect.forEach(
        [...fresh].filter(([, at]) => Math.abs(typedAt - at) <= DRAFT_TYPED_WITHIN_MS),
        ([threadId]) => {
          fresh.delete(threadId);
          const last = asked.get(threadId);
          if (last !== undefined && now - last < DRAFT_PRE_WAKE_AGAIN_MS) return Effect.void;
          asked.set(threadId, now);
          return preWake.ahead(threadId, now + DRAFT_PRE_WAKE_MS, "draft");
        },
        { discard: true },
      );
    const forgetOld = (now: number) => {
      for (const [threadId, at] of fresh)
        if (now - at > DRAFT_TYPED_WITHIN_MS) fresh.delete(threadId);
      for (const [threadId, at] of asked)
        if (now - at >= DRAFT_PRE_WAKE_AGAIN_MS) asked.delete(threadId);
      for (const [windowId, report] of windows)
        if (now - report.at >= DRAFT_WINDOW_FORGET_MS) windows.delete(windowId);
    };
    return {
      /** The window's threads with a draft, all of them, as `composer.drafts` reports them. */
      drafts: (windowId: string, threadIds: ReadonlyArray<ThreadId>) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          forgetOld(now);
          const before = windows.get(windowId)?.threads ?? new Set<string>();
          for (const threadId of threadIds) if (!before.has(threadId)) fresh.set(threadId, now);
          if (threadIds.length === 0) windows.delete(windowId);
          else windows.set(windowId, { at: now, threads: new Set(threadIds) });
          yield* ask(now);
        }),
      /** The user typed in some composer just now. */
      typed: Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        typedAt = now;
        forgetOld(now);
        yield* ask(now);
      }),
    };
  });

/** The service in context, else `MachinePreWake.off`. */
export const preWakeOrOff: Effect.Effect<MachinePreWakeShape> = Effect.map(
  Effect.serviceOption(MachinePreWake),
  Option.getOrElse(() => MachinePreWake.off),
);

/** The scheduler key of a wake's ask for its thread's machine. */
export const preWakeKey = (wakeId: string) => `prewake:${wakeId}`;

/** A wake as its ask ahead reads it: waiting for its time unless it fired or its condition did. */
export interface PreWakeTarget {
  readonly threadId: ThreadId;
  readonly at: number;
  readonly fired?: unknown;
  readonly conditionState?: { readonly fired?: unknown } | undefined;
}

const waitingForItsTime = (wake: PreWakeTarget | undefined): wake is PreWakeTarget =>
  wake !== undefined && wake.fired === undefined && wake.conditionState?.fired === undefined;

/**
 * Arms a wake's ask for its thread's machine `PRE_WAKE_LEAD_MS` before it is due: in `alarms`
 * under `preWakeKey`, registered with the scheduler through `timers` so a control plane asleep
 * then is woken for it too. `current` reads the wake again at that time, and one that has fired
 * or gone by then asks for nothing. Once per wake: arming it again leaves the first.
 */
export const armWakeAhead = (
  deps: {
    readonly alarms: FiberMap.FiberMap<string>;
    readonly timers: TimersShape;
    readonly preWake: MachinePreWakeShape;
  },
  wake: PreWakeTarget & { readonly id: string },
  current: Effect.Effect<PreWakeTarget | undefined>,
): Effect.Effect<void> =>
  waitingForItsTime(wake)
    ? FiberMap.run(
        deps.alarms,
        preWakeKey(wake.id),
        deps.timers.until(preWakeKey(wake.id), wake.at - PRE_WAKE_LEAD_MS).pipe(
          Effect.andThen(current),
          Effect.flatMap((now) =>
            waitingForItsTime(now)
              ? deps.preWake.ahead(now.threadId, now.at + PRE_WAKE_PAST_MS, "wake")
              : Effect.void,
          ),
        ),
        { onlyIfMissing: true },
      ).pipe(Effect.asVoid)
    : Effect.void;

/** Takes back a wake's alarm, kept under its id in `alarms`, and its ask ahead. */
export const disarmWake = (alarms: FiberMap.FiberMap<string>, wakeId: string) =>
  Effect.andThen(FiberMap.remove(alarms, wakeId), FiberMap.remove(alarms, preWakeKey(wakeId)));
