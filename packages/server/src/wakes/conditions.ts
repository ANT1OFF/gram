/**
 * Condition wakes: a `schedule_wake` that waits for something to happen beside its time, such as a
 * branch getting a new head or another thread finishing. The condition is a member of the closed
 * `WakeCondition` union (`@gram/contracts`); each kind has a source here that takes its baseline
 * when the wake is set and looks whether it is met, on a poll and whenever its event source says
 * something may have changed.
 *
 * The wakes themselves stay where every wake lives: a plain thread's in `thread_wakes`
 * (`ThreadWakes`), a workspace thread's in its outbox. Each of those registers as a host: it lists
 * its pending condition wakes, keeps what a look saw, and, once one is met, keeps that and delivers
 * it through its own path, the same one a due time or a PR's event takes. So a met condition
 * survives a restart and waits out a parked thread or a paused workspace like any wake, and the
 * wake's time stays its fallback.
 *
 * Adding a kind: a member of `WakeCondition` with its words (`wakeConditionWhen`), and a
 * `WakeConditionSource` for it in `WakeConditionSourcesLive`. Nothing else changes.
 */
import {
  AppToolError,
  WAKE_CONDITION_VERSION,
  type StoredWakeCondition,
  type Thread,
  type ThreadId,
  type WakeCondition,
  type WakeConditionFired,
  type WakeConditionKind,
  type WakeConditionSeen,
} from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { makeKeyedLock } from "../git/keyed-lock.ts";

/** The member of `WakeCondition` of kind `K`. */
export type ConditionOf<K extends WakeConditionKind> = Extract<WakeCondition, { readonly kind: K }>;

/** A pending wake on a condition, as a host lists it for a look. */
export interface ConditionWake<C extends WakeCondition = WakeCondition> {
  readonly id: string;
  /** The thread that set it. */
  readonly threadId: ThreadId;
  /** Epoch ms it was set: what happened before it doesn't count. */
  readonly setAt: number;
  readonly spec: C;
  readonly seen?: WakeConditionSeen | undefined;
}

/**
 * One look at a condition: met, with the facts its notice shows, or not yet, with what it saw now
 * when that should replace the baseline. `undefined` when the look couldn't tell (GitHub
 * unreachable, out of allowance): the next one tries again.
 */
export type ConditionLook =
  | { readonly met: true; readonly facts: Readonly<Record<string, string>> }
  | { readonly met: false; readonly seen?: WakeConditionSeen | undefined };

/**
 * What a kind implements. `arm` runs in `schedule_wake`, for the calling thread: it checks the
 * condition makes sense, fills in what was left to default, and takes the baseline; it refuses one
 * already met or with nothing to wait for. `look` must not fail and must be cheap enough to run every
 * `pollEvery` for every pending wake of its kind; `changes`, when it has one, asks for a look sooner.
 * A met look fires only once a later look, `debounce` on, still finds it met (with zero, at once),
 * and the facts of that later look are the ones told.
 */
export interface WakeConditionSource<K extends WakeConditionKind = WakeConditionKind> {
  readonly kind: K;
  readonly pollEvery: Duration.Duration;
  readonly debounce: Duration.Duration;
  readonly arm: (
    caller: Thread,
    spec: ConditionOf<K>,
  ) => Effect.Effect<
    { readonly spec: ConditionOf<K>; readonly seen?: WakeConditionSeen | undefined },
    AppToolError
  >;
  readonly look: (wake: ConditionWake<ConditionOf<K>>) => Effect.Effect<ConditionLook | undefined>;
  readonly changes?: Stream.Stream<unknown> | undefined;
}

/** Any kind's source, as the registry holds them. */
// oxlint-disable-next-line typescript/no-explicit-any -- each source is typed by its own kind
export type AnyWakeConditionSource = WakeConditionSource<any>;

/**
 * A store of wakes: the plain threads' (`ThreadWakes`) and each workspace's outbox. `fire` keeps
 * the finding on the wake before anything else, then delivers it the way the store delivers a due
 * wake; a store that hasn't started yet only keeps it, and its start delivers it.
 */
export interface WakeConditionHost {
  readonly name: string;
  /** Its pending wakes on a condition that no look has found met yet. */
  readonly pending: Effect.Effect<ReadonlyArray<ConditionWake>>;
  readonly saveSeen: (id: string, seen: WakeConditionSeen) => Effect.Effect<void>;
  readonly fire: (id: string, fired: WakeConditionFired) => Effect.Effect<void>;
}

/** The sources of every kind, which `WakeConditionsLive` runs. */
export class WakeConditionSources extends Context.Service<
  WakeConditionSources,
  ReadonlyArray<AnyWakeConditionSource>
>()("@gram/server/WakeConditionSources") {}

export interface WakeConditionsShape {
  /** `schedule_wake`'s condition, checked by its kind's source: the stored form, or a refusal. */
  readonly arm: (
    caller: Thread,
    spec: WakeCondition,
  ) => Effect.Effect<StoredWakeCondition, AppToolError>;
  /** A store whose wakes the sources look at; the stores register once, as they are built. */
  readonly register: (host: WakeConditionHost) => Effect.Effect<void>;
  /** Asks for a look at the kind's wakes now rather than at its next poll. */
  readonly nudge: (kind: WakeConditionKind) => Effect.Effect<void>;
  /** One look at every pending wake of the kind; the loops run it, and tests call it. */
  readonly sweep: (kind: WakeConditionKind) => Effect.Effect<void>;
}

export class WakeConditions extends Context.Service<WakeConditions, WakeConditionsShape>()(
  "@gram/server/WakeConditions",
) {}

/** The stored form of a condition its source armed. */
export const storedCondition = (armed: {
  readonly spec: WakeCondition;
  readonly seen?: WakeConditionSeen | undefined;
}): StoredWakeCondition => ({
  v: WAKE_CONDITION_VERSION,
  spec: armed.spec,
  ...(armed.seen === undefined ? {} : { seen: armed.seen }),
});

/** A stored wake's condition as a host lists it, or `undefined` once found met. */
export const conditionWakeOf = (wake: {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly setAt: number;
  readonly conditionState?: StoredWakeCondition | undefined;
}): ConditionWake | undefined =>
  wake.conditionState === undefined || wake.conditionState.fired !== undefined
    ? undefined
    : {
        id: wake.id,
        threadId: wake.threadId,
        setAt: wake.setAt,
        spec: wake.conditionState.spec,
        ...(wake.conditionState.seen === undefined ? {} : { seen: wake.conditionState.seen }),
      };

const sameSeen = (a: WakeConditionSeen | undefined, b: WakeConditionSeen | undefined) =>
  JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});

export const WakeConditionsLive = Layer.effect(
  WakeConditions,
  Effect.gen(function* () {
    const sources = yield* WakeConditionSources;
    const byKind = new Map<string, AnyWakeConditionSource>(sources.map((s) => [s.kind, s]));
    const hosts: Array<WakeConditionHost> = [];
    /** Per kind, the nudges its loop waits on beside its poll; one pending is enough. */
    const nudges = new Map<string, Queue.Queue<void>>();
    /** Per kind, one sweep at a time. */
    const sweeping = makeKeyedLock<string>();
    /** Per wake id, when a look first found it met; a look that doesn't drops it. */
    const metSince = new Map<string, number>();
    /** Per wake id, the look its debounce asks for. */
    const debounces = yield* FiberMap.make<string>();

    for (const source of sources) {
      nudges.set(source.kind, yield* Queue.sliding<void>(1));
    }

    const nudge: WakeConditionsShape["nudge"] = (kind) =>
      Effect.sync(() => {
        const queue = nudges.get(kind);
        if (queue !== undefined) Queue.offerUnsafe(queue, undefined);
      });

    const lookAt = (source: AnyWakeConditionSource, host: WakeConditionHost, wake: ConditionWake) =>
      Effect.gen(function* () {
        const look = yield* source.look(wake);
        if (look === undefined) return;
        if (!look.met) {
          metSince.delete(wake.id);
          yield* FiberMap.remove(debounces, wake.id);
          if (look.seen !== undefined && !sameSeen(look.seen, wake.seen)) {
            yield* host.saveSeen(wake.id, look.seen);
          }
          return;
        }
        const now = yield* Clock.currentTimeMillis;
        const debounce = Duration.toMillis(source.debounce);
        const since = metSince.get(wake.id);
        if (debounce > 0 && (since === undefined || now - since < debounce)) {
          if (since === undefined) metSince.set(wake.id, now);
          const wait = debounce - (now - (since ?? now));
          yield* FiberMap.run(
            debounces,
            wake.id,
            Effect.sleep(Duration.millis(wait)).pipe(Effect.andThen(nudge(source.kind))),
            { onlyIfMissing: true },
          );
          return;
        }
        metSince.delete(wake.id);
        yield* host.fire(wake.id, { kind: source.kind, at: now, facts: { ...look.facts } });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("condition wake look failed").pipe(
            Effect.annotateLogs({ kind: source.kind, wakeId: wake.id, cause: Cause.pretty(cause) }),
          ),
        ),
      );

    const sweep: WakeConditionsShape["sweep"] = (kind) =>
      Effect.gen(function* () {
        const source = byKind.get(kind);
        if (source === undefined) return;
        yield* sweeping.withLock(
          kind,
          Effect.gen(function* () {
            const live = new Set<string>();
            for (const host of hosts) {
              const pending = yield* host.pending;
              for (const wake of pending) {
                if (wake.spec.kind !== kind) continue;
                live.add(wake.id);
                yield* lookAt(source, host, wake);
              }
            }
            // A wake cancelled, delivered or gone with its thread leaves nothing behind.
            for (const id of metSince.keys()) {
              if (live.has(id)) continue;
              metSince.delete(id);
              yield* FiberMap.remove(debounces, id);
            }
          }),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("condition wake sweep failed").pipe(
            Effect.annotateLogs({ kind, cause: Cause.pretty(cause) }),
          ),
        ),
      );

    for (const source of sources) {
      const queue = nudges.get(source.kind)!;
      // A look at every poll, or sooner on a nudge, whichever comes first.
      yield* Queue.take(queue).pipe(
        Effect.timeoutOption(source.pollEvery),
        Effect.andThen(sweep(source.kind)),
        Effect.forever,
        Effect.forkScoped,
      );
      if (source.changes !== undefined) {
        yield* source.changes.pipe(
          Stream.runForEach(() => nudge(source.kind)),
          Effect.catchCause((cause) =>
            Effect.logWarning("condition wake events stopped").pipe(
              Effect.annotateLogs({ kind: source.kind, cause: Cause.pretty(cause) }),
            ),
          ),
          Effect.forkScoped,
        );
      }
    }

    const arm: WakeConditionsShape["arm"] = (caller, spec) =>
      Effect.gen(function* () {
        const source = byKind.get(spec.kind);
        if (source === undefined) {
          return yield* new AppToolError({
            tool: "schedule_wake",
            message: `Gram can't wait on a ${spec.kind} condition here.`,
          });
        }
        return storedCondition(yield* source.arm(caller, spec));
      });

    const register: WakeConditionsShape["register"] = (host) =>
      Effect.sync(() => {
        hosts.push(host);
      });

    return WakeConditions.of({ arm, register, nudge, sweep });
  }),
);
