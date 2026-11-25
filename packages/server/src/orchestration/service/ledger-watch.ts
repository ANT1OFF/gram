import {
  currentBaseOf,
  effectiveCheckout,
  featureCardsText,
  reconcileFeatureCards,
  WORKER_REQUEST_SUMMARY_MAX,
  type OrchestratorLedger,
  type PendingRequest,
  type ServerEvent,
  type Thread,
  type ThreadId,
  type TurnId,
  type WorkerPendingRequest,
  type WorkerReport,
  type WorkspaceState,
  type WorkspaceId,
} from "@gram/contracts";
import { samePathKey } from "@gram/git";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { LocalCheck } from "../../git/local-checks.ts";
import { redactText } from "../../logging/redact.ts";
import {
  accrueCost,
  contextPct,
  featuresOf,
  groupsOf,
  ledgerOf,
  metersOf,
  type ExtraRepoFacts,
  type WorkerFacts,
} from "../ledger.ts";
import { activeHolds, limitUses, subscriptionAgents, subscriptionLimits } from "../limit-pause.ts";
import { wakesOf } from "../outbox.ts";
import { ledgerQuestions } from "../worker-questions.ts";
import { heldOf, projectOfCheckout, workersOf, clipped, type OrchestrationKit } from "./kit.ts";
import type { WorkerQuestions } from "./questions.ts";
import type { OrchestrationShape } from "./shape.ts";

/** How long `watchLedger` lets changes settle before it builds the ledger again. */
export const LEDGER_WATCH_DEBOUNCE = Duration.millis(300);

const ledgerText = (ledger: OrchestratorLedger): string =>
  JSON.stringify({ ...ledger, builtAt: 0 });

const requestSummary = (request: PendingRequest): string => {
  const asks =
    request.kind === "question"
      ? request.questions.map((each) => each.question).join("\n")
      : request.kind === "plan"
        ? request.plan
        : `${request.displayName}${request.autonomyNote === undefined ? "" : ` (${request.autonomyNote})`}: ${
            request.description ??
            (typeof request.input["command"] === "string" ? request.input["command"] : "")
          }`;
  return clipped(redactText(asks.trim()), WORKER_REQUEST_SUMMARY_MAX);
};

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const localCheckRow = (check: LocalCheck): NonNullable<WorkerFacts["localCheck"]> => ({
  status: check.status,
  ...(check.reason === undefined ? {} : { reason: check.reason }),
  ...(check.failure === undefined ? {} : { kind: check.failure.kind }),
});

/** The survey, the ledger and feature cards, and their watches. */
export const makeLedgerWatch = (
  kit: OrchestrationKit,
  deps: Pick<WorkerQuestions, "reconcileQuestions">,
) => {
  const {
    store,
    extraFacts,
    readOutbox,
    requestSeen,
    publisher,
    localChecks,
    runtimes,
    changedFiles,
    extraBadges,
    conflictedSince,
    findThread,
    updateOutbox,
    limitReadings,
    workerWorkspaces,
    orchestrators,
    hub,
    cardsLock,
    eventSink,
  } = kit;

  const survey = (state: WorkspaceState, persistCost: boolean, endedTurn?: TurnId) =>
    Effect.gen(function* () {
      yield* deps.reconcileQuestions(state.workspace.id);
      const now = yield* Clock.currentTimeMillis;
      const workers = workersOf(yield* store.listThreads, state);
      const projects = new Map((yield* store.listProjects).map((p) => [p.id, p]));
      const extrasOf = (thread: Thread): ReadonlyArray<ExtraRepoFacts> =>
        (thread.extraCheckouts ?? []).map((checkout) => {
          const sampled = extraFacts.get(samePathKey(checkout.path));
          return {
            checkout,
            project: projectOfCheckout(projects.values(), checkout),
            files: sampled?.files ?? [],
            signatures: sampled?.signatures,
            repo: sampled?.repo,
          };
        });
      const latest = new Map<ThreadId, WorkerReport>();
      const interfaces: Record<string, string> = {};
      const reported = yield* store.latestWorkerReports(
        state.workspace.id,
        workers.map((worker) => worker.id),
      );
      for (const { report, interface: stated } of reported) {
        latest.set(report.threadId, report);
        if (stated !== undefined) interfaces[report.threadId] = stated;
      }
      const outbox = yield* readOutbox(state.workspace.id);
      const facts = yield* Effect.forEach(workers, (thread): Effect.Effect<WorkerFacts> =>
        Effect.gen(function* () {
          const requests = yield* store.listRequests(thread.id);
          const pendingRequests = requests.map((request): WorkerPendingRequest => {
            const askedAt = requestSeen.get(request.id)?.at;
            return {
              kind: request.kind,
              ageMin: Math.max(0, Math.floor((now - (askedAt ?? now)) / 60_000)),
              ...(askedAt === undefined ? {} : { askedAt }),
              requestId: request.id,
              summary: requestSummary(request),
            };
          });
          const badge = yield* publisher.badgeFor(thread);
          const base = badge === undefined ? undefined : currentBaseOf(badge);
          const localCheck =
            localChecks === undefined || badge?.headRefOid === undefined || base === undefined
              ? undefined
              : localChecks.latest(
                  thread.checkout.path,
                  badge.headRefOid,
                  base,
                  projects.get(thread.projectId),
                );
          const status = yield* runtimes
            .status(thread.id)
            .pipe(Effect.orElseSucceed((): WorkerFacts["status"] => "cold"));
          const lastTurn = yield* store.lastTurn(thread.id);
          const reopeningAfterTurn =
            status === "starting" &&
            endedTurn !== undefined &&
            endedTurn === lastTurn?.id &&
            (yield* runtimes.summaryOf(thread.id))?.queue.length === 0;
          return {
            thread,
            wakes: wakesOf(outbox, thread.id),
            project: projects.get(thread.projectId),
            status: reopeningAfterTurn ? "idle" : status,
            usage: yield* store.lastTurnUsage(thread.id),
            lastTurn,
            pendingRequests,
            completedReason: yield* store.getCompletedReason(thread.id),
            git: yield* publisher.stateFor(effectiveCheckout(thread).path),
            badge,
            ...(localCheck === undefined ? {} : { localCheck: localCheckRow(localCheck) }),
            files: changedFiles.get(thread.id)?.files ?? [],
            signatures: changedFiles.get(thread.id)?.signatures,
            lastReport: latest.get(thread.id),
            memo: outbox.workers[thread.id],
            extras: extrasOf(thread),
            extraBadges: extraBadges.get(thread.id) ?? [],
            dependencyBadges: yield* dependencyBadgesOf(thread),
            conflictedSince: conflictedSince.get(thread.id),
            ...(yield* publisher
              .stateForThread(thread)
              .pipe(Effect.map((threadGit) => ({ missingPrs: threadGit?.missingPrs, threadGit })))),
            plan: yield* store.getPlan(thread.id),
            requests,
            now,
            quiet: yield* runtimes.quiet(thread.id).pipe(Effect.orElseSucceed(() => undefined)),
            compacting: yield* runtimes
              .compacting(thread.id)
              .pipe(Effect.orElseSucceed(() => false)),
          };
        }),
      );
      const features = featuresOf(facts, state);
      const groups = groupsOf(features, state.groups);
      const holder = state.workspace.orchestratorThreadId;
      const own = holder === undefined ? undefined : yield* findThread(holder);
      const ownUsage = own === undefined ? undefined : yield* store.lastTurnUsage(own.id);
      const spenders = [
        ...(own === undefined
          ? []
          : [{ id: own.id, createdAt: own.createdAt, costUsd: ownUsage?.costUsd }]),
        ...facts.map(({ thread, usage }) => ({
          id: thread.id,
          createdAt: thread.createdAt,
          costUsd: usage?.costUsd,
        })),
      ];
      const cost = accrueCost(outbox.cost, spenders, now, localZone());
      if (persistCost) {
        yield* updateOutbox(state.workspace.id, (current) => [
          { ...current, cost: accrueCost(current.cost, spenders, now, localZone()) },
          undefined,
        ]);
      }
      const holds = activeHolds(outbox.limitHolds, now);
      const limits = Option.isNone(limitReadings)
        ? []
        : subscriptionLimits(
            yield* limitReadings.value.current,
            subscriptionAgents(state.charter, own?.model),
            now,
          );
      const budget = metersOf({
        state,
        features,
        costUsdToday: cost.usd,
        limits: limitUses(limits, holds, now),
      });
      const lastActivityAt = new Map(workers.map((worker) => [worker.id, worker.lastActivityAt]));
      const ownContextPct = contextPct(ownUsage);
      return {
        now,
        outbox,
        features,
        groups,
        budget,
        workers,
        lastActivityAt,
        ownContextPct,
        interfaces,
      };
    });

  const ledger: OrchestrationShape["ledger"] = (workspaceId) =>
    Effect.gen(function* () {
      const state = yield* store.getWorkspace(workspaceId);
      const found = yield* survey(state, false);
      return ledgerOf({
        state,
        features: found.features,
        groups: found.groups,
        budget: found.budget,
        orchestratorEdits: found.outbox.orchestratorEdits,
        held: heldOf(found.outbox),
        questions: ledgerQuestions(found.outbox),
        now: found.now,
      });
    });

  const movesLedger = (workspaceId: WorkspaceId, event: ServerEvent): boolean => {
    const ofWorkspace = (threadId: ThreadId) =>
      workerWorkspaces.get(threadId) === workspaceId || orchestrators.get(threadId) === workspaceId;
    switch (event.type) {
      case "orchestration.changed":
        return event.workspaceId === workspaceId;
      case "threads.snapshot":
        return true;
      case "thread.upsert":
        return ofWorkspace(event.thread.id);
      case "thread.status":
      case "thread.request":
      case "thread.requestResolved":
      case "thread.removed":
      case "git.state":
        return ofWorkspace(event.threadId);
      default:
        return false;
    }
  };

  const watchLedger: OrchestrationShape["watchLedger"] = (workspaceId) => {
    const changed = hub
      .serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] }))
      .pipe(
        Stream.filter((event) => movesLedger(workspaceId, event)),
        Stream.debounce(LEDGER_WATCH_DEBOUNCE),
        Stream.mapEffect(() => ledger(workspaceId)),
      );
    return Stream.merge(Stream.fromEffect(ledger(workspaceId)), changed).pipe(
      Stream.changesWith((a, b) => ledgerText(a) === ledgerText(b)),
    );
  };

  const featureCards: OrchestrationShape["featureCards"] = (workspaceId) =>
    Effect.gen(function* () {
      const state = yield* store.getWorkspace(workspaceId);
      const found = yield* survey(state, false);
      const busy = found.features.flatMap((feature) =>
        feature.workers.filter(
          (worker) => worker.status === "running" || worker.status === "starting",
        ),
      );
      const activity = new Map<ThreadId, string>();
      for (const worker of busy) {
        const line = yield* runtimes
          .activity(worker.threadId)
          .pipe(Effect.orElseSucceed(() => undefined));
        if (line !== undefined) activity.set(worker.threadId, line);
      }
      const previous = yield* store.listFeatureCards(workspaceId);
      const { cards, changed } = reconcileFeatureCards(previous, {
        workspaceId,
        features: found.features,
        models: new Map(found.workers.map((thread) => [thread.id, thread.model.model])),
        activity,
        spawnedAt: new Map(found.workers.map((thread) => [thread.id, thread.createdAt])),
        startedBy: new Map(
          found.workers.flatMap((thread) =>
            thread.startedBy === undefined ? [] : [[thread.id, thread.startedBy] as const],
          ),
        ),
        held: heldOf(found.outbox),
        now: found.now,
      });
      yield* Effect.forEach(changed, store.putFeatureCard, { discard: true });
      if (eventSink !== undefined && changed.length > 0) yield* eventSink.featureCards(changed);
      return { workspaceId, cards };
    }).pipe((effect) => cardsLock.withLock(workspaceId, effect));

  const watchFeatureCards: OrchestrationShape["watchFeatureCards"] = (workspaceId) => {
    const changed = hub
      .serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] }))
      .pipe(
        Stream.filter((event) => movesLedger(workspaceId, event)),
        Stream.debounce(LEDGER_WATCH_DEBOUNCE),
        Stream.mapEffect(() => featureCards(workspaceId)),
      );
    return Stream.merge(Stream.fromEffect(featureCards(workspaceId)), changed).pipe(
      Stream.changesWith((a, b) => featureCardsText(a.cards) === featureCardsText(b.cards)),
    );
  };

  const dependencyBadgesOf = (thread: Thread) =>
    Effect.forEach(thread.boundPr?.dependsOn ?? [], (dependency) =>
      publisher.watchedBadge(dependency),
    ).pipe(Effect.map((badges) => badges.filter((badge) => badge !== undefined)));

  return { survey, ledger, watchLedger, featureCards, watchFeatureCards, dependencyBadgesOf };
};

/** What `makeLedgerWatch` makes, for the parts whose `deps` take some of it. */
export type LedgerWatch = ReturnType<typeof makeLedgerWatch>;
