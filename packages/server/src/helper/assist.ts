import {
  helperOn,
  type PaletteFilter,
  type CatchUpView,
  type FeatureCardSummary,
  type HelperEventPayload,
  type RecapView,
  type RequestId,
  type ServerEvent,
  type StuckView,
  type ThreadId,
  type WorkspaceId,
  type ThreadSuggestions,
} from "@gram/contracts";
import { Pr } from "@gram/git";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { EventHub } from "../events/event-hub.ts";
import { GitStatePublisher } from "../git/publisher.ts";
import { ThreadVisibility } from "../git/visibility.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadPlans } from "../plans/service.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { ThreadWaits } from "../waits/service.ts";
import { proposePaletteFilters } from "./palette-filters.ts";
import { makeAskReplies } from "./ask-replies.ts";
import { makeCatchUps } from "./catch-up.ts";
import { makeFeatureSummaries } from "./feature-summary.ts";
import { makeNoticeTitles } from "./notice-title.ts";
import { prContextsFor } from "./pr-context.ts";
import { makeRecapWatch, makeRecaps } from "./recap.ts";
import { HelperScheduler } from "./scheduler.ts";
import { makeStucks } from "./stuck.ts";
import { makeSuggestions, suggestibleEnd } from "./suggest.ts";
import { makeWaitHelper } from "./wait.ts";

const isPlanOrRemoval = (
  event: ServerEvent,
): event is Extract<ServerEvent, { type: "thread.plan" | "thread.removed" }> =>
  event.type === "thread.plan" || event.type === "thread.removed";

/**
 * The helper model's help inside a thread: where you left off, what you might say next, and what
 * waits on you that the agent didn't name.
 */
export class ThreadAssist extends Context.Service<
  ThreadAssist,
  {
    readonly paletteFilters: (
      threadId: ThreadId,
      query: string,
    ) => Effect.Effect<readonly PaletteFilter[]>;
    /** `thread.recap`. */
    readonly recap: (threadId: ThreadId) => Effect.Effect<RecapView | undefined>;
    /** `thread.catchUp`. */
    readonly catchUp: (threadId: ThreadId) => Effect.Effect<CatchUpView | undefined>;
    /** `thread.whyStuck`. */
    readonly whyStuck: (threadId: ThreadId) => Effect.Effect<StuckView | undefined>;
    /** `thread.suggestions`. */
    readonly suggestions: (threadId: ThreadId) => Effect.Effect<ThreadSuggestions | undefined>;
    /** `request.replies`: empty unless suggested replies are on and the request is a free-form question. */
    readonly askReplies: (
      threadId: ThreadId,
      requestId: RequestId,
    ) => Effect.Effect<ReadonlyArray<string>>;
    /** `request.noticeTitle`: `undefined` unless notification titles are on and the request pending. */
    readonly noticeTitle: (
      threadId: ThreadId,
      requestId: RequestId,
      count: number,
    ) => Effect.Effect<string | undefined>;
    /** `helper.recordEvent`. */
    readonly recordEvent: (payload: HelperEventPayload) => Effect.Effect<void>;
    /** `orchestrator.featureSummary`: a feature card's sentence for its current version. */
    readonly featureSummary: (
      workspaceId: WorkspaceId,
      feature: string,
    ) => Effect.Effect<FeatureCardSummary | undefined>;
  }
>()("@gram/server/ThreadAssist") {}

/**
 * Recaps on open and ahead of time, suggested replies when a turn you're watching ends, and
 * `Thread.lastViewedAt`: the moment the user moves out of a
 * thread they had in front of them, which is what "since you last looked" counts from.
 */
export const ThreadAssistLive = Layer.effect(
  ThreadAssist,
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const runtimes = yield* ThreadRuntimes;
    const visibility = yield* ThreadVisibility;
    const publisher = yield* GitStatePublisher;
    const scheduler = yield* HelperScheduler;
    const hub = yield* EventHub;
    const plans = yield* ThreadPlans;
    const pr = yield* Pr;
    const waits = yield* ThreadWaits;
    const prContextDeps = {
      settings: store.getSettings,
      charter: (id: WorkspaceId) =>
        store.getWorkspace(id).pipe(Effect.map((state) => state.charter)),
      seenChecks: pr.seenChecks,
      now: Clock.currentTimeMillis,
    };
    /** The plan as the prompts show it: the goal and each step's words and state, no ids. */
    const promptPlan = (threadId: ThreadId) =>
      Effect.map(plans.get(threadId), (plan) =>
        plan === undefined || (plan.goal === "" && plan.steps.length === 0)
          ? undefined
          : { goal: plan.goal, steps: plan.steps.map(({ text, status }) => ({ text, status })) },
      );

    const focused = (threadId: ThreadId) =>
      Effect.map(visibility.attention(threadId), (attention) => attention === "focused");

    const recaps = makeRecaps({
      schedule: scheduler.schedule,
      getThread: (threadId) => store.getThread(threadId),
      status: (threadId) => runtimes.status(threadId),
      feedRev: (threadId) => Effect.map(store.feedRevision(threadId), (rev) => rev?.rev),
      lastTurn: (threadId) =>
        Effect.map(store.listTurns(threadId), (turns) => {
          const last = turns.at(-1);
          return last === undefined ? undefined : { id: last.id, endedAt: last.endedAt };
        }),
      recentMessages: (threadId, turns) =>
        Effect.map(store.recentMessages(threadId, turns), (page) => page.messages),
      userMessages: (threadId) => store.listUserMessages(threadId),
      git: (thread) => publisher.stateForThread(thread),
      prContext: (thread, git) => prContextsFor(prContextDeps, thread, git),
      plan: promptPlan,
      focused,
    });

    const featureSummary = makeFeatureSummaries({
      schedule: scheduler.schedule,
      orchestratorOf: (workspaceId) =>
        store.getWorkspace(workspaceId).pipe(
          Effect.map((state) => state.workspace.orchestratorThreadId),
          Effect.orElseSucceed(() => undefined),
        ),
      cards: (workspaceId) => store.listFeatureCards(workspaceId),
      latestReports: (workspaceId, threadIds) =>
        Effect.map(store.latestWorkerReports(workspaceId, threadIds), (latest) =>
          latest.map(({ report }) => report),
        ),
      putSummary: (workspaceId, feature, summary) =>
        store.putFeatureCardSummary(workspaceId, feature, summary),
    });

    const catchUps = makeCatchUps({
      schedule: scheduler.schedule,
      getThread: (threadId) => store.getThread(threadId),
      reports: (thread) =>
        thread.workspaceId === undefined
          ? Effect.succeed([])
          : Effect.map(store.listWorkerReports(thread.workspaceId), (records) =>
              records.flatMap(({ report }) => (report.threadId === thread.id ? [report] : [])),
            ),
      recentMessages: (threadId, turns) =>
        Effect.map(store.recentMessages(threadId, turns), (page) => page.messages),
    });

    const workerReports = (thread: {
      readonly id: ThreadId;
      readonly workspaceId?: WorkspaceId;
    }) =>
      thread.workspaceId === undefined
        ? Effect.succeed([])
        : Effect.map(store.listWorkerReports(thread.workspaceId), (records) =>
            records.flatMap(({ report }) => (report.threadId === thread.id ? [report] : [])),
          );

    const stucks = makeStucks({
      schedule: scheduler.schedule,
      getThread: (threadId) => store.getThread(threadId),
      status: (threadId) => runtimes.status(threadId),
      reports: workerReports,
      recentMessages: (threadId, turns) =>
        Effect.map(store.recentMessages(threadId, turns), (page) => page.messages),
      prs: (thread) =>
        Effect.flatMap(publisher.stateForThread(thread), (git) =>
          prContextsFor(prContextDeps, thread, git),
        ),
    });

    const suggestions = makeSuggestions({
      schedule: scheduler.schedule,
      status: (threadId) => runtimes.status(threadId),
      lastTurn: (threadId) =>
        Effect.map(store.listTurns(threadId), (turns) => {
          const last = turns.at(-1);
          return last === undefined ? undefined : { id: last.id, reason: last.reason };
        }),
      userMessages: (threadId) => store.listUserMessages(threadId),
      recentMessages: (threadId, turns) =>
        Effect.map(store.recentMessages(threadId, turns), (page) => page.messages),
      plan: promptPlan,
      prContext: (threadId) =>
        store.getThread(threadId).pipe(
          Effect.flatMap((thread) =>
            Effect.flatMap(publisher.stateForThread(thread), (git) =>
              prContextsFor(prContextDeps, thread, git),
            ),
          ),
          Effect.orElseSucceed(() => []),
        ),
      focused,
      publish: (s) => hub.publish({ type: "thread.suggestions", ...s }),
      enabled: Effect.map(store.getSettings, (settings) => helperOn(settings, "suggest")),
    });
    const askReplies = makeAskReplies({
      schedule: scheduler.schedule,
      listRequests: (threadId) => store.listRequests(threadId),
      userMessages: (threadId) => store.listUserMessages(threadId),
      recentMessages: (threadId, turns) =>
        Effect.map(store.recentMessages(threadId, turns), (page) => page.messages),
    });
    const noticeTitles = makeNoticeTitles({
      schedule: scheduler.schedule,
      listRequests: (threadId) => store.listRequests(threadId),
      threadTitle: (threadId) =>
        store.getThread(threadId).pipe(
          Effect.map((thread) => thread.title),
          Effect.orElseSucceed(() => ""),
        ),
    });
    // One job a thread: a new turn interrupts the suggestions still being made for the last.
    const suggesting = yield* FiberMap.make<ThreadId>();
    const turnMoved = (threadId: ThreadId) =>
      Effect.andThen(FiberMap.remove(suggesting, threadId), suggestions.forget(threadId));

    const waitHelper = makeWaitHelper({
      schedule: scheduler.schedule,
      recordEvent: scheduler.recordEvent,
      waits,
      recentMessages: (threadId, turns) =>
        Effect.map(store.recentMessages(threadId, turns), (page) => page.messages),
      lastTurnId: (threadId) => Effect.map(store.listTurns(threadId), (turns) => turns.at(-1)?.id),
      enabled: Effect.map(store.getSettings, (settings) => helperOn(settings, "wait")),
    });
    // Off the observer's fiber, which a call would hold up; one of each kind a thread at a time.
    const waiting = yield* FiberMap.make<string>();

    const watch = yield* makeRecapWatch(recaps);
    yield* runtimes.observe({
      onTurnStart: (thread) => Effect.andThen(watch.started(thread.id), turnMoved(thread.id)),
      onUserInput: (thread, input) =>
        Effect.all([
          watch.started(thread.id),
          turnMoved(thread.id),
          // Before its lapse: a suggestion still being made for the last turn is for a turn gone.
          waitHelper.userSent(thread.id),
          FiberMap.remove(waiting, `end:${thread.id}`),
          FiberMap.run(waiting, `input:${thread.id}`, waitHelper.atUserInput(thread, input.text)),
        ]),
      onTurnEnd: (thread, end) =>
        Effect.gen(function* () {
          yield* watch.ended(thread, yield* focused(thread.id));
          const inputs = waitHelper.inputs(thread.id);
          yield* FiberMap.run(
            waiting,
            `end:${thread.id}`,
            waitHelper.atTurnEnd(thread, end, inputs),
          );
          if (!suggestibleEnd(end)) return;
          yield* FiberMap.run(suggesting, thread.id, suggestions.atTurnEnd(thread, end.turnId));
        }),
    });

    // A plan edit can contradict what was suggested against the old one; a closed thread's
    // suggestions and recap timer would otherwise stay for the server's lifetime.
    yield* hub.internalEvents(isPlanOrRemoval, "thread assist").pipe(
      Stream.runForEach((event) =>
        event.type === "thread.plan"
          ? // Behind suggestions still being made, which check the plan before they're kept.
            FiberMap.run(suggesting, event.threadId, suggestions.planChanged(event.threadId), {
              onlyIfMissing: true,
            }).pipe(Effect.asVoid)
          : Effect.all([
              FiberMap.remove(suggesting, event.threadId),
              suggestions.forget(event.threadId),
              watch.started(event.threadId),
              FiberMap.remove(waiting, `input:${event.threadId}`),
              FiberMap.remove(waiting, `end:${event.threadId}`),
              waitHelper.forget(event.threadId),
            ]),
      ),
      Effect.forkScoped,
    );

    yield* visibility.focusLeaves.pipe(
      Stream.runForEach(({ threadId, at }) =>
        runtimes
          .updateThread(threadId, (thread) => ({ ...thread, lastViewedAt: at }))
          .pipe(Effect.ignore),
      ),
      Effect.forkScoped,
    );

    return {
      recap: (threadId) =>
        Effect.gen(function* () {
          const made = yield* recaps.onOpenMade(threadId);
          if (made === undefined) return undefined;
          const { view } = made;
          // The agent's own: there are no helper replies to keep or take back for its turn.
          if (view.wrapUp !== undefined) return view;
          // Its replies answer the plan and PRs it read. A plan edited or a PR moved since, or a
          // thread closed meanwhile, makes them stale: they neither stand as the turn's suggestions
          // nor reach the composer.
          const kept =
            view.turnId !== undefined &&
            (yield* suggestions.remember(
              { threadId, turnId: view.turnId, replies: view.recap.replies },
              made.basis,
            ));
          return kept || view.turnId === undefined
            ? view
            : { ...view, recap: { ...view.recap, replies: [] } };
        }).pipe(
          // Suggestions switched off leave the recap's replies out, and the recap itself alone.
          Effect.flatMap((view) =>
            view === undefined
              ? Effect.succeed(view)
              : Effect.map(store.getSettings, (settings) =>
                  helperOn(settings, "suggest")
                    ? view
                    : { ...view, recap: { ...view.recap, replies: [] } },
                ),
          ),
        ),
      paletteFilters: (threadId, query) =>
        Effect.flatMap(store.listWorkspaces, (states) =>
          proposePaletteFilters(
            scheduler.schedule,
            threadId,
            query,
            states.map(({ workspace }) => ({ id: workspace.id, name: workspace.name })),
          ),
        ),
      catchUp: catchUps.onOpen,
      whyStuck: stucks.onAsk,
      suggestions: suggestions.onOpen,
      askReplies: (threadId, requestId) =>
        Effect.flatMap(store.getSettings, (settings) =>
          helperOn(settings, "suggest")
            ? askReplies.forRequest(threadId, requestId)
            : Effect.succeed([]),
        ),
      noticeTitle: (threadId, requestId, count) =>
        Effect.flatMap(store.getSettings, (settings) =>
          helperOn(settings, "notice")
            ? noticeTitles.forRequest(threadId, requestId, count)
            : Effect.succeed(undefined),
        ),
      recordEvent: ({ kind, event }) => scheduler.recordEvent(kind, event),
      featureSummary,
    };
  }),
);
