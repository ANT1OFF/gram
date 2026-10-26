/**
 * Declared PR dependencies (`depends_on`): a thread's bound PR waiting on another one. They are kept
 * on the binding (`BoundPr.dependsOn`), and this module is the only one that writes them. Each open
 * one is watched through the publisher's sweeps, and the dependent thread is sent a notice when it
 * merges, is closed or gets a new push, with no wake of its own to set. `merge_when_ready` reads
 * them as `after` (`mergeAfterDependencies`), and the ledger shows the chain.
 */
import {
  AppToolError,
  MAX_PR_DEPENDENCIES,
  prRefText,
  samePr,
  type BoundPr,
  type PrDependency,
  type PrRef,
  type PrStatus,
  type PrWatchSeen,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { EventHub } from "../events/event-hub.ts";
import { besidesActivity, upsertsChanging } from "../events/upsert-changes.ts";
import { isBadgeOf } from "../git/extra-prs.ts";
import { MergeWhenReady } from "../git/merge-when-ready.ts";
import { GitStatePublisher, type PrWatch } from "../git/publisher.ts";
import { Orchestration } from "../orchestration/service.ts";
import {
  DEPENDENCY_EVENTS,
  dependencyWakeText,
  nextPrWatchSeen,
  prWakeEventOf,
  prWatchSeenOf,
} from "../orchestration/rules.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";

const TOOL = "depends_on";

/** How soon a dependency's notice its thread couldn't take yet is tried again. */
const DEPENDENCY_RETRY = Duration.minutes(1);

/** What `depends_on` asks for, its PR already parsed. */
interface DependsOnInput {
  readonly pr: PrRef;
  /** The worker whose PR depends on it, for an orchestrator; the caller's own otherwise. */
  readonly threadId?: ThreadId | undefined;
  readonly remove?: boolean | undefined;
  /** `false`: `merge_when_ready` needn't wait for it. */
  readonly mergeAfter?: boolean | undefined;
}

export interface PrDependenciesShape {
  /**
   * `depends_on`: declares, changes or drops one dependency of a thread's bound PR, the caller's own
   * or, for an orchestrator, its worker's. What an orchestrator declared its worker can't drop or
   * stop merging after. Answers the PR's dependencies as they stand after.
   */
  readonly declare: (
    callerId: ThreadId,
    input: DependsOnInput,
  ) => Effect.Effect<
    { readonly pr: string; readonly dependsOn: ReadonlyArray<string> },
    AppToolError
  >;
}

export class PrDependencies extends Context.Service<PrDependencies, PrDependenciesShape>()(
  "@gram/server/PrDependencies",
) {}

const refused = (message: string) => new AppToolError({ tool: TOOL, message });

/** A dependency as the tool's answer names it. */
const dependencyName = (dependency: PrDependency): string =>
  `${prRefText(dependency)}${dependency.mergeAfter === false ? " (needn't merge first)" : ""}${
    dependency.seen?.state === "merged" || dependency.seen?.state === "closed"
      ? ` (${dependency.seen.state})`
      : ""
  }`;

/** A dependency still to watch: not yet seen merged or closed. */
const open = (dependency: PrDependency): boolean =>
  dependency.seen?.state !== "merged" && dependency.seen?.state !== "closed";

/** What a dependency keeps of what it saw: its events turn on the state and the head alone. */
const keptSeen = (seen: PrWatchSeen): PrWatchSeen => ({
  ...(seen.state === undefined ? {} : { state: seen.state }),
  ...(seen.head === undefined ? {} : { head: seen.head }),
});

/** `bound` with `dependsOn` as given, the key left off when it is empty. */
const withDependencies = (bound: BoundPr, dependsOn: ReadonlyArray<PrDependency>): BoundPr => {
  const { dependsOn: _, ...rest } = bound;
  return dependsOn.length === 0 ? rest : { ...rest, dependsOn };
};

/** What the publisher's sweeps look up for every open dependency of an open thread's PR. */
const dependencyWatches = (threads: ReadonlyArray<Thread>): ReadonlyArray<PrWatch> =>
  threads.flatMap((thread) =>
    thread.parked
      ? []
      : (thread.boundPr?.dependsOn ?? []).filter(open).map((dependency) => ({
          threadId: thread.id,
          repo: dependency.repo,
          number: dependency.number,
          // The bot's rounds on it are what says it drags on.
          reviews: true,
        })),
  );

export const PrDependenciesLive = Layer.effect(
  PrDependencies,
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const runtimes = yield* ThreadRuntimes;
    const publisher = yield* GitStatePublisher;
    const hub = yield* EventHub;
    const orchestration = Option.getOrUndefined(yield* Effect.serviceOption(Orchestration));
    const mergeWhenReady = Option.getOrUndefined(yield* Effect.serviceOption(MergeWhenReady));
    /** One look at a badge at a time: a sweep's and a catch-up's would both tell the same event. */
    const looking = yield* Semaphore.make(1);
    /** Per dependency whose notice its thread couldn't take, the look again. */
    const retries = yield* FiberMap.make<string>();

    const syncWatches = store.listThreads.pipe(
      Effect.flatMap((threads) => publisher.watchPrs("dependencies", dependencyWatches(threads))),
    );

    /**
     * `badge` for every open thread whose PR depends on it: the thread is told of a merge, a close
     * or a push since, and what it saw is kept once it has been. A thread that can't take the notice
     * yet (a cleanup holding it, its folder gone) keeps the dependency as it was, and is looked at
     * again a minute on. A restart between the notice and the write sends it once more, which the
     * notice's key makes replace a copy still queued.
     */
    /**
     * Whether `thread`'s dependency events wait: it is in a paused workspace, or it is a worker of a feature the user paused, which holds what would start a worker's
     * turn, as its scheduled wakes are held. What it saw isn't kept meanwhile, so the event is told
     * once the resume looks again.
     */
    const held = (thread: Thread) =>
      Effect.gen(function* () {
        if (thread.workspaceId === undefined) return false;
        const state = yield* store
          .getWorkspace(thread.workspaceId)
          .pipe(Effect.orElseSucceed(() => undefined));
        if (state === undefined) return false;
        if (state.paused !== undefined) return true;
        const feature = thread.spawnedBy?.feature;
        return (
          feature !== undefined &&
          thread.spawnedBy?.threadId === state.workspace.orchestratorThreadId &&
          state.pausedFeatures?.includes(feature) === true
        );
      });

    const onBadge = (badge: PrStatus): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (const thread of yield* store.listThreads) {
          const bound = thread.boundPr;
          if (thread.parked || bound === undefined) continue;
          if (!(bound.dependsOn ?? []).some((each) => open(each) && isBadgeOf(badge, each)))
            continue;
          if (yield* held(thread)) continue;
          for (const dependency of bound.dependsOn ?? []) {
            if (!open(dependency) || !isBadgeOf(badge, dependency)) continue;
            const fired = prWakeEventOf(dependency.seen, badge, DEPENDENCY_EVENTS);
            const seen = keptSeen(nextPrWatchSeen(dependency.seen, badge));
            if (fired !== undefined) {
              const delivered = yield* runtimes
                .sendNotice(thread.id, `dependency:${prRefText(dependency)}`, {
                  text: dependencyWakeText(bound, dependency, fired),
                })
                .pipe(
                  Effect.as(true),
                  Effect.catch((e) =>
                    Effect.logWarning("dependency notice not delivered").pipe(
                      Effect.annotateLogs({ threadId: thread.id, error: e.message }),
                      // As a wake: an agent that won't start leaves the notice queued and a
                      // thread that's gone takes nothing, while anything holding the thread is
                      // tried again.
                      Effect.as(e._tag !== "InvalidState"),
                    ),
                  ),
                );
              if (!delivered) {
                yield* FiberMap.run(
                  retries,
                  `${thread.id} ${prRefText(dependency).toLowerCase()}`,
                  Effect.sleep(DEPENDENCY_RETRY).pipe(
                    Effect.andThen(Effect.suspend(() => catchUp)),
                  ),
                );
                continue;
              }
            }
            if (JSON.stringify(seen) !== JSON.stringify(dependency.seen)) {
              yield* runtimes
                .updateThread(thread.id, (current) =>
                  current.boundPr === undefined || !samePr(current.boundPr, bound)
                    ? current
                    : {
                        ...current,
                        boundPr: withDependencies(
                          current.boundPr,
                          (current.boundPr.dependsOn ?? []).map((each) =>
                            samePr(each, dependency) ? { ...each, seen } : each,
                          ),
                        ),
                      },
                )
                .pipe(Effect.ignore);
            }
            if (fired === undefined) continue;
            // A merge waiting on it asks again now rather than after its recheck interval.
            if (fired.event === "merged" && mergeWhenReady !== undefined) {
              yield* mergeWhenReady.check(thread.id);
            }
          }
        }
      });

    /**
     * Brings the watches up to the threads, and measures every open dependency against its PR's
     * last badge: one unarchived, or read before a restart, may have moved meanwhile.
     */
    const catchUp: Effect.Effect<void> = Effect.gen(function* () {
      yield* syncWatches;
      const seen = new Map<string, PrStatus>();
      for (const thread of yield* store.listThreads) {
        if (thread.parked) continue;
        for (const dependency of (thread.boundPr?.dependsOn ?? []).filter(open)) {
          const key = prRefText(dependency).toLowerCase();
          if (seen.has(key)) continue;
          const badge = yield* publisher.watchedBadge(dependency);
          if (badge === undefined) continue;
          seen.set(key, badge);
        }
      }
      for (const badge of seen.values()) yield* looking.withPermits(1)(onBadge(badge));
      // One seen merged or closed just now is watched no more.
      if (seen.size > 0) yield* syncWatches;
    });

    yield* publisher.observe({
      onState: () => Effect.void,
      onRound: () => Effect.void,
      onWatchedPr: (badge) =>
        looking.withPermits(1)(onBadge(badge)).pipe(Effect.andThen(syncWatches)),
    });
    yield* catchUp;
    const threadChanges = upsertsChanging(besidesActivity);
    yield* hub.serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] })).pipe(
      // A resume is a workspace change: the events its pause held are told then.
      Stream.filter(
        (event) =>
          ((event.type === "thread.upsert" || event.type === "thread.removed") &&
            threadChanges(event)) ||
          event.type === "workspaces.changed",
      ),
      Stream.runForEach(() => catchUp),
      Effect.forkScoped,
    );

    const declare: PrDependenciesShape["declare"] = (callerId, input) =>
      Effect.gen(function* () {
        const targetId = input.threadId ?? callerId;
        const byOrchestrator = targetId !== callerId;
        if (
          byOrchestrator &&
          (orchestration === undefined || !(yield* orchestration.isDelegated(callerId, targetId)))
        ) {
          return yield* refused(`Thread ${targetId} isn't one of your workers.`);
        }
        const thread = yield* store
          .getThread(targetId)
          .pipe(Effect.mapError(() => refused(`No thread ${targetId}.`)));
        const bound = thread.boundPr;
        if (bound === undefined) {
          return yield* refused(
            `No pull request is bound to ${byOrchestrator ? "that worker" : "this thread"}; a dependency is declared on a PR, so open and bind it first (pr_bind).`,
          );
        }
        if (samePr(bound, input.pr))
          return yield* refused("A pull request can't depend on itself.");
        const existing = (bound.dependsOn ?? []).find((each) => samePr(each, input.pr));
        if (input.remove === true && existing === undefined) {
          return yield* refused(
            `${prRefText(bound)} wasn't declared to depend on ${prRefText(input.pr)}.`,
          );
        }
        let seen: PrWatchSeen | undefined;
        if (input.remove !== true && existing === undefined) {
          if ((bound.dependsOn ?? []).length >= MAX_PR_DEPENDENCIES) {
            return yield* refused(
              `A pull request depends on ${MAX_PR_DEPENDENCIES} others at most; drop one first.`,
            );
          }
          const looked = yield* publisher.lookupPr(thread, { ...input.pr, reviews: true });
          if (Option.isSome(looked)) {
            const badge = looked.value;
            if (badge === undefined) {
              return yield* refused(`GitHub has no pull request ${prRefText(input.pr)}.`);
            }
            if (badge.state !== "OPEN") {
              return yield* refused(
                `${prRefText(input.pr)} is ${badge.state.toLowerCase()} already; there is nothing to wait for.`,
              );
            }
            seen = keptSeen(prWatchSeenOf(badge));
          }
        }
        const guardedMessage = `Your orchestrator declared that ${prRefText(bound)} depends on ${prRefText(input.pr)}; only it can change that.`;
        const now = yield* Clock.currentTimeMillis;
        // Who declared it is read again in the write: an orchestrator's declaration that landed
        // while this call looked the PR up stands against the worker's change.
        let blocked: string | undefined;
        const write = runtimes.updateThread(targetId, (current) => {
          blocked = undefined;
          const binding = current.boundPr;
          if (binding === undefined || !samePr(binding, bound)) {
            blocked = `${prRefText(bound)} is no longer bound there; declare it again on the PR now bound.`;
            return current;
          }
          const list = binding.dependsOn ?? [];
          const guarded =
            !byOrchestrator &&
            list.some((each) => samePr(each, input.pr) && each.setBy === "orchestrator");
          if (guarded && (input.remove === true || input.mergeAfter === false)) {
            blocked = guardedMessage;
            return current;
          }
          if (input.remove === true) {
            return {
              ...current,
              boundPr: withDependencies(
                binding,
                list.filter((each) => !samePr(each, input.pr)),
              ),
            };
          }
          const declared: PrDependency = {
            repo: input.pr.repo,
            number: input.pr.number,
            setBy: byOrchestrator || guarded ? "orchestrator" : "thread",
            setAt: now,
            ...(input.mergeAfter === false ? { mergeAfter: false as const } : {}),
          };
          const before = list.find((each) => samePr(each, input.pr));
          // Read again in the write: another declaration may have filled the list meanwhile.
          if (before === undefined && list.length >= MAX_PR_DEPENDENCIES) {
            blocked = `A pull request depends on ${MAX_PR_DEPENDENCIES} others at most; drop one first.`;
            return current;
          }
          const next =
            before === undefined
              ? [...list, { ...declared, ...(seen === undefined ? {} : { seen }) }]
              : list.map((each) =>
                  samePr(each, input.pr)
                    ? {
                        ...declared,
                        setAt: each.setAt,
                        ...(each.seen === undefined ? {} : { seen: each.seen }),
                      }
                    : each,
                );
          return {
            ...current,
            boundPr: withDependencies(binding, next),
          };
        });
        // No merge of it between its last look and its launch while its order changes.
        const updated = yield* (
          mergeWhenReady === undefined ? write : mergeWhenReady.mutate(targetId, write)
        ).pipe(Effect.mapError((e) => refused(e.message)));
        if (blocked !== undefined) return yield* refused(blocked);
        yield* syncWatches;
        return {
          pr: prRefText(bound),
          dependsOn: (updated.boundPr?.dependsOn ?? []).map(dependencyName),
        };
      });

    return PrDependencies.of({ declare });
  }),
);
