import {
  PlanStepId,
  type GitState,
  type PrContext,
  type GramUIMessage,
  type Thread,
  type ThreadId,
  type ThreadPlan,
} from "@gram/contracts";
import { Pr } from "@gram/git";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { randomUUID } from "node:crypto";
import { EventHub } from "../events/event-hub.ts";
import { GitStatePublisher } from "../git/publisher.ts";
import { fenceConversation } from "../helper/material.ts";
import { prContextsFor, prPromptBlock } from "../helper/pr-context.ts";
import {
  basisHash,
  HelperScheduler,
  type HelperLane,
  type HelperSchedulerShape,
} from "../helper/scheduler.ts";
import { ThreadStore, type ThreadStoreShape } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import {
  applyPrFacts,
  HelperPlanOutput,
  PLAN_PROMPT_VERSION,
  PLAN_SYSTEM,
  planFacts,
  planPrompt,
  validateHelperPlan,
  type PlanFacts,
  type PrFact,
} from "./helper.ts";
import { ThreadPlans, type ThreadPlansShape } from "./service.ts";

/**
 * When the helper refreshes a thread's plan. A turn ending asks, 20 s later
 * so a queued follow-up merges into one call, at most every 2 minutes a thread unless the user wrote
 * since, and at most 30 times a thread a day, unless the agent's own todo list describes a thread
 * with no PR whose plan has a goal. A bound PR merging or closing asks 30 s later, and its
 * facts are applied to the plan at once, with no call. An agent's todo list changing asks nothing:
 * the headline reads it directly. An unchanged thread never costs a call, since the scheduler
 * answers an equal basis from its cache. Orchestrators and dreams have no helper plan, and a parked
 * thread is refreshed only for a PR merging or closing.
 */

const TURN_DEBOUNCE = Duration.seconds(20);
const PR_DEBOUNCE = Duration.seconds(30);
const MIN_INTERVAL_MS = 2 * 60_000;
const DAILY_REFRESHES = 30;
/** Incremental refreshes between full rebuilds, which keep a long thread's plan from drifting. */
const REBUILD_EVERY = 20;
/** About 3k tokens of new conversation for an incremental refresh, 8k for a rebuild. */
const DELTA_CHARS = 12_000;
const REBUILD_CHARS = 32_000;
/** More new messages than this, and a refresh reads the recent turns instead. */
const DELTA_MESSAGES = 400;
const REBUILD_TURNS = 8;

/** Where the plan's material ended last time, kept in `ThreadPlan.basis`: `rev=12;n=3`. */
export interface PlanBasis {
  readonly rev: number;
  /** Incremental refreshes since the last rebuild. */
  readonly n: number;
}

export const parseBasis = (basis: string | undefined): PlanBasis | undefined => {
  const match = /^rev=(\d+);n=(\d+)/.exec(basis ?? "");
  return match === null ? undefined : { rev: Number(match[1]), n: Number(match[2]) };
};

export const formatBasis = ({ rev, n }: PlanBasis): string => `rev=${rev};n=${n}`;

export interface PlanKeeperShape {
  /**
   * Refreshes the plan now, for the user (Refresh, Rebuild): the interactive lane, no debounce or
   * daily cap. `rebuild` re-derives every unlocked step from the whole thread. Answers the plan.
   */
  refresh(
    threadId: ThreadId,
    options?: { readonly rebuild?: boolean | undefined },
  ): Effect.Effect<ThreadPlan | undefined>;
}

export class PlanKeeper extends Context.Service<PlanKeeper, PlanKeeperShape>()(
  "@gram/server/PlanKeeper",
) {}

/** A thread's PR facts for comparing one `git.state` with the next. */
const prKey = (prs: ReadonlyArray<PrFact>): string =>
  prs.map((pr) => `${pr.repo ?? ""}#${pr.number}:${pr.state}`).join(",");

/** A PR in `now` that has merged or closed since `before`. */
const prEnded = (before: ReadonlyArray<PrFact>, now: ReadonlyArray<PrFact>): boolean =>
  now.some(
    (pr) =>
      (pr.state === "merged" || pr.state === "closed") &&
      before.find((old) => old.number === pr.number)?.state !== pr.state,
  );

const newStepId = (): PlanStepId => Schema.decodeSync(PlanStepId)(randomUUID().slice(0, 8));

const followedOf = (thread: Thread) => [
  ...(thread.boundPr === undefined ? [] : [thread.boundPr]),
  ...(thread.extraPrs ?? []),
];

/** What a refresh reads: the new messages since `basis`, or the thread's start and recent turns. */
const materialFor = (
  store: ThreadStoreShape,
  threadId: ThreadId,
  from: PlanBasis | undefined,
): Effect.Effect<{
  readonly messages: ReadonlyArray<GramUIMessage>;
  readonly full: boolean;
}> =>
  Effect.gen(function* () {
    if (from !== undefined) {
      const since = yield* store.messagesSince(threadId, from.rev, DELTA_MESSAGES);
      if (since !== undefined) return { messages: since, full: false };
    }
    const [first] = yield* store.listUserMessages(threadId);
    const { messages } = yield* store.recentMessages(threadId, REBUILD_TURNS);
    const opener = first === undefined || messages.some((m) => m.id === first.id) ? [] : [first];
    return { messages: [...opener, ...messages], full: true };
  });

export interface PlanKeeperDeps {
  readonly store: ThreadStoreShape;
  readonly plans: ThreadPlansShape;
  readonly scheduler: HelperSchedulerShape;
  readonly gitOf: (thread: Thread) => Effect.Effect<GitState | undefined>;
  /** `prContextsFor` over the thread and its git state. */
  readonly prContext: (
    thread: Thread,
    git: GitState | undefined,
  ) => Effect.Effect<ReadonlyArray<PrContext>>;
}

/**
 * One refresh of `threadId`'s plan through the scheduler, answering the plan as it stands after.
 * The answer is checked against the plan as it is when the answer lands, not as it was asked about,
 * so an edit the user made meanwhile stays.
 */
export const refreshPlan = (
  { store, plans, scheduler, gitOf, prContext }: PlanKeeperDeps,
  threadId: ThreadId,
  options: { readonly lane: HelperLane; readonly rebuild: boolean; readonly userSpoke: boolean },
): Effect.Effect<ThreadPlan | undefined> =>
  Effect.gen(function* () {
    const thread = yield* store.getThread(threadId);
    if (thread.role !== undefined) return undefined;
    const record = yield* plans.record(threadId);
    const git = yield* gitOf(thread);
    const followed = followedOf(thread);
    const facts: PlanFacts = planFacts(git, followed, record.turnPlan ?? []);
    const pr = prPromptBlock(yield* prContext(thread, git));
    const revision = yield* store.feedRevision(threadId);
    if (revision === undefined) return record.plan;
    const previous = parseBasis(record.plan?.basis);
    const due =
      options.rebuild ||
      previous === undefined ||
      previous.n >= REBUILD_EVERY ||
      revision.resetRev > previous.rev;
    const { messages, full } = yield* materialFor(store, threadId, due ? undefined : previous);
    const locked = (record.plan?.steps ?? []).filter((step) => step.locked === true);
    // A rebuild starts over from what the user and the agent wrote.
    const rebuilt = (plan: ThreadPlan | undefined) =>
      plan === undefined || !options.rebuild
        ? plan
        : { ...plan, steps: plan.steps.filter((step) => step.locked === true) };
    const result = yield* scheduler.schedule({
      kind: "plan",
      threadId,
      lane: options.lane,
      basis: basisHash(
        revision.rev,
        full,
        options.rebuild,
        facts,
        pr ?? null,
        locked,
        record.plan?.goalBy ?? null,
      ),
      promptVersion: PLAN_PROMPT_VERSION,
      system: PLAN_SYSTEM,
      prompt: Effect.sync(() =>
        planPrompt(
          facts,
          rebuilt(record.plan),
          fenceConversation(messages, { maxChars: full ? REBUILD_CHARS : DELTA_CHARS }),
          pr,
        ),
      ),
      output: HelperPlanOutput,
    });
    // A cached answer was applied when it was new: applying it again would mint its new steps
    // fresh ids and replace the ones it gave them.
    if (result._tag !== "Done" || result.cached) return record.plan;
    // The call may have waited in the queue: a PR that merged meanwhile is a fact the answer can't undo.
    const landed = yield* store.getThread(threadId);
    const current: PlanFacts = planFacts(
      yield* gitOf(landed),
      followedOf(landed),
      record.turnPlan ?? [],
    );
    const now = yield* Clock.currentTimeMillis;
    const basis = formatBasis({ rev: revision.rev, n: full ? 0 : (previous?.n ?? 0) + 1 });
    return yield* plans.update(
      threadId,
      (plan) =>
        validateHelperPlan(rebuilt(plan), result.value, {
          facts: current,
          userSpoke: options.userSpoke || full,
          basis,
          now,
          newId: newStepId,
        }) ?? plan,
    );
  }).pipe(
    Effect.catchTag("ThreadNotFound", () => Effect.succeed(undefined)),
    Effect.catchCause(() =>
      Effect.logWarning("thread plan not refreshed").pipe(
        Effect.annotateLogs({ threadId }),
        Effect.as(undefined),
      ),
    ),
  );

/** The day a refresh is counted against, UTC. */
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const PlanKeeperLive: Layer.Layer<
  PlanKeeper,
  never,
  ThreadStore | EventHub | ThreadRuntimes | ThreadPlans | HelperScheduler | GitStatePublisher | Pr
> = Layer.effect(
  PlanKeeper,
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const hub = yield* EventHub;
    const runtimes = yield* ThreadRuntimes;
    const plans = yield* ThreadPlans;
    const scheduler = yield* HelperScheduler;
    const publisher = yield* GitStatePublisher;
    const pr = yield* Pr;
    const deps: PlanKeeperDeps = {
      store,
      plans,
      scheduler,
      // The thread's own state: it carries the bound and followed PRs the checkout's doesn't.
      gitOf: publisher.stateForThread,
      prContext: (thread, git) =>
        prContextsFor(
          {
            settings: store.getSettings,
            seenChecks: pr.seenChecks,
            now: Clock.currentTimeMillis,
            charter: (id) => store.getWorkspace(id).pipe(Effect.map((state) => state.charter)),
          },
          thread,
          git,
        ),
    };

    const timers = yield* FiberMap.make<ThreadId>();
    const running = yield* FiberSet.make();
    const lastRefresh = new Map<ThreadId, number>();
    const spoke = new Set<ThreadId>();
    const counts = new Map<ThreadId, { day: string; n: number }>();
    const prFacts = new Map<ThreadId, ReadonlyArray<PrFact>>();

    /**
     * The agent's own todo list says it all: it keeps one, the thread has no PR, and the
     * plan has its goal already. Then only a PR event asks the helper.
     */
    const describedByTodos = (thread: Thread) =>
      Effect.gen(function* () {
        const record = yield* plans.record(thread.id);
        if ((record.turnPlan ?? []).length === 0 || (record.plan?.goal ?? "") === "") return false;
        const git = yield* deps.gitOf(thread);
        return (
          planFacts(git, followedOf(thread), []).prs.length === 0 && followedOf(thread).length === 0
        );
      });

    const run = (threadId: ThreadId, why: "turn" | "pr") =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId);
        if (thread.role !== undefined || (thread.parked && why !== "pr")) return;
        if (why === "turn" && (yield* describedByTodos(thread))) return;
        const now = yield* Clock.currentTimeMillis;
        const day = dayOf(now);
        const count = counts.get(threadId);
        const n = count?.day === day ? count.n : 0;
        if (n >= DAILY_REFRESHES) return;
        counts.set(threadId, { day, n: n + 1 });
        lastRefresh.set(threadId, now);
        const userSpoke = spoke.delete(threadId);
        yield* refreshPlan(deps, threadId, { lane: "background", rebuild: false, userSpoke });
      }).pipe(Effect.catchCause(() => Effect.void));

    /** Waits `delay` and refreshes; a later ask for the same thread restarts the wait. */
    const ask = (threadId: ThreadId, why: "turn" | "pr", delay: Duration.Duration) =>
      FiberMap.run(
        timers,
        threadId,
        Effect.sleep(delay).pipe(Effect.andThen(FiberSet.run(running, run(threadId, why)))),
      ).pipe(Effect.asVoid);

    yield* runtimes.observe({
      onUserInput: (thread) => Effect.sync(() => void spoke.add(thread.id)),
      onTurnEnd: (thread, end) =>
        Effect.gen(function* () {
          if (!end.queueEmpty || thread.role !== undefined) return;
          const now = yield* Clock.currentTimeMillis;
          const last = lastRefresh.get(thread.id);
          const early =
            last === undefined || spoke.has(thread.id) ? 0 : last + MIN_INTERVAL_MS - now;
          const delay = Duration.max(TURN_DEBOUNCE, Duration.millis(Math.max(0, early)));
          yield* ask(thread.id, "turn", delay);
        }),
    });

    /** A thread's git state, as published: facts first, and a PR that ended asks for a refresh. */
    const onState = (thread: Thread, state: GitState) =>
      Effect.gen(function* () {
        if (thread.role !== undefined) return;
        const facts = planFacts(state, followedOf(thread), []).prs;
        const before = prFacts.get(thread.id);
        if (before !== undefined && prKey(before) === prKey(facts)) return;
        prFacts.set(thread.id, facts);
        // Facts first: a merged PR's step is done now, whatever the helper would say.
        yield* plans.update(thread.id, (plan) => applyPrFacts(plan, facts));
        if (before !== undefined && prEnded(before, facts)) {
          yield* ask(thread.id, "pr", PR_DEBOUNCE);
        }
      }).pipe(Effect.catchCause(() => Effect.void));

    // With replay: the publisher's start-up sync sends each thread's state before this exists, and
    // an unchanged badge isn't sent again, so a PR that merged while the app was shut would be missed.
    yield* publisher.observe({ onState, onRound: () => Effect.void }, { replay: true });

    yield* hub.serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] })).pipe(
      Stream.runForEach((event) =>
        event.type === "thread.removed"
          ? Effect.gen(function* () {
              yield* FiberMap.remove(timers, event.threadId);
              for (const map of [lastRefresh, counts, prFacts]) map.delete(event.threadId);
              spoke.delete(event.threadId);
            })
          : Effect.void,
      ),
      Effect.forkScoped,
    );

    return PlanKeeper.of({
      refresh: (threadId, options) =>
        Effect.gen(function* () {
          yield* FiberMap.remove(timers, threadId);
          const userSpoke = spoke.delete(threadId);
          lastRefresh.set(threadId, yield* Clock.currentTimeMillis);
          return yield* refreshPlan(deps, threadId, {
            lane: "interactive",
            rebuild: options?.rebuild === true,
            userSpoke: userSpoke || options?.rebuild === true,
          });
        }),
    });
  }),
);
