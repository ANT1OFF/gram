// The ledger: one row per worker, grouped by feature, built on
// demand and never stored. Everything here is a function over facts the service gathered, so the
// shape of a row, the worker cap's meter and the day's spend can be tested without a server.

import {
  combinePrFacts,
  DEPENDENCY_DRAG_CONFLICT_MIN,
  DEPENDENCY_DRAG_ROUNDS,
  effectiveCheckout,
  FINISHED_STATES,
  isBoundBadge,
  planHeadline,
  prFactsOf,
  reopenedSinceMerge,
  requiredChecksOf,
  samePr,
  workerHasOngoingWork,
  type BoundPr,
  type BudgetMeters,
  type Checkout,
  type CompletedReason,
  type FeatureGroupLedgerEntry,
  type FeatureLedgerEntry,
  type GitState,
  type HeldBrief,
  type WorkerQuestion,
  type LimitUse,
  type MergeIntent,
  type MergeWaiting,
  type OrchestratorLedger,
  type PendingWake,
  type PendingRequest,
  type PrStatus,
  type Project,
  type Thread,
  type ThreadId,
  type ThreadStatus,
  type TurnId,
  type UsageSummary,
  type WorkerError,
  type WorkerLedgerEntry,
  type WorkerPendingRequest,
  type WorkerPr,
  type WorkerPrDependency,
  type WorkerRepo,
  type WorkerReport,
  type WorkerState,
  type WorkerQuiet,
  type WorkspaceState,
} from "@gram/contracts";
import { repoFromPrUrl } from "@gram/git";
import { branchPrOf } from "../git/completion.ts";
import { redactText } from "../logging/redact.ts";
import type { ThreadPlanRecord } from "../persistence/thread-store.ts";
import type { CostBucket, WorkerMemo } from "./outbox.ts";
import { localDayOf } from "../zone-time.ts";
import {
  featureState,
  groupOf,
  overlapPairs,
  workerState,
  workerStateBase,
  type WorkerStateInput,
} from "./rules.ts";

/** A worktree a worker holds in a repo other than its own, as the service last sampled it. */
export interface ExtraRepoFacts {
  readonly checkout: Checkout;
  /** The project whose root is the worktree's repo; `undefined` once that project is gone. */
  readonly project: Project | undefined;
  /** Paths changed there, relative to that repo; empty until it is first sampled. */
  readonly files: ReadonlyArray<string>;
  /** What each of `files` holds there now, where that could be read. */
  readonly signatures?: Readonly<Record<string, string>> | undefined;
  /** `owner/repo` of its `origin`; `undefined` until sampled, or without one. */
  readonly repo: string | undefined;
}

/** Everything the service knows about one worker at the moment the ledger is built. */
export interface WorkerFacts {
  readonly thread: Thread;
  readonly project: Project | undefined;
  readonly status: ThreadStatus;
  /** What the worker's last ended turn reported. */
  readonly usage: UsageSummary | undefined;
  /**
   * The turn it started last, as the store wrote it on opening: what `Thread.lastError` is
   * judged against, so nothing that lags behind the runtime decides whether a failure stands.
   */
  readonly lastTurn?: { readonly id: TurnId; readonly startedAt: number } | undefined;
  readonly pendingRequests: ReadonlyArray<WorkerPendingRequest>;
  readonly completedReason: CompletedReason | undefined;
  /** The publisher's cached state for the worker's checkout. */
  readonly git: GitState | undefined;
  /** The publisher's cached badge for the PR the worker acts on. */
  readonly badge: PrStatus | undefined;
  /** Paths the worker has changed, relative to its repo; empty until its first git state. */
  readonly files: ReadonlyArray<string>;
  /** What each of `files` holds now, where that could be read. */
  readonly signatures?: Readonly<Record<string, string>> | undefined;
  readonly lastReport: WorkerReport | undefined;
  readonly memo: WorkerMemo | undefined;
  /** The worktrees it holds in other repos (`Thread.extraCheckouts`); empty for most workers. */
  readonly extras: ReadonlyArray<ExtraRepoFacts>;
  /** The badges of its `extraPrs` as the publisher last sent them; one not looked up yet is absent. */
  readonly extraBadges: ReadonlyArray<PrStatus>;
  /** Its bound PRs GitHub says it has no such PR for (`GitState.missingPrs`), which hold nothing open. */
  readonly missingPrs?: ReadonlyArray<Pick<BoundPr, "repo" | "number">> | undefined;
  /** The wakes it has set for itself (`wakesOf`), soonest first. */
  readonly wakes?: ReadonlyArray<PendingWake> | undefined;
  /**
   * The thread's own state (`stateForThread`), which carries a bound PR that lives elsewhere and its
   * followed PRs, as the plan headline reads them; the checkout's `git` stands in without it.
   */
  readonly threadGit?: GitState | undefined;
  /** Its thread plan and the agent's todo list; absent for a worker that keeps neither. */
  readonly plan?: ThreadPlanRecord | undefined;
  /** Its pending requests whole, as the plan headline reads them. */
  readonly requests?: ReadonlyArray<PendingRequest> | undefined;
  /** The clock the headline's idle rule reads. */
  readonly now?: number | undefined;
  /** The runtime's live silent-tool evidence; persisted stops are in `memo.quiet`. */
  readonly quiet?: WorkerQuiet | undefined;
  /** The agent is compacting its context: at work, however little it streams. */
  readonly compacting?: boolean | undefined;
  /** The publisher's last badges of the PRs its bound PR depends on (`watchedBadge`). */
  readonly dependencyBadges?: ReadonlyArray<PrStatus> | undefined;
  /** Epoch ms its PR was first seen conflicting with its base, while it still does. */
  readonly conflictedSince?: number | undefined;
  /** Gram's own check of `badge`'s head on its base, where one ran or runs (`LocalChecks.latest`). */
  readonly localCheck?: WorkerPr["localCheck"] | undefined;
}

/** The workspace's PRs by `owner/repo#N`, lower-cased, with the worker whose each is. */
type WorkspacePrs = ReadonlyMap<string, { readonly threadId: ThreadId; readonly badge: PrStatus }>;

const prKey = (pr: Pick<BoundPr, "repo" | "number">) => `${pr.repo.toLowerCase()}#${pr.number}`;

/**
 * The dependencies of a worker's bound PR as its row shows them: each with its badge's words, the
 * worker it belongs to when one in the workspace has it, and whether it drags on. A worker's own
 * badge of it is fresher than the watch's, so it is read first.
 */
const dependencyRows = (
  facts: Pick<WorkerFacts, "thread" | "dependencyBadges" | "conflictedSince" | "now">,
  workspacePrs: WorkspacePrs,
  conflictedMin: number | undefined,
): ReadonlyArray<WorkerPrDependency> =>
  (facts.thread.boundPr?.dependsOn ?? []).map((dependency) => {
    const owner = workspacePrs.get(prKey(dependency));
    const badge =
      owner?.badge ??
      (facts.dependencyBadges ?? []).find((each) => {
        const repo = repoFromPrUrl(each.url);
        return repo !== undefined && samePr({ repo, number: each.number }, dependency);
      });
    const state = badge === undefined ? dependency.seen?.state : prFactsOf(badge).state;
    const rounds = badge?.review?.rounds;
    const drags =
      state === "open" &&
      ((conflictedMin ?? 0) >= DEPENDENCY_DRAG_CONFLICT_MIN ||
        (rounds ?? 0) > DEPENDENCY_DRAG_ROUNDS);
    const verdict = badge?.review?.verdictOnHead;
    return {
      repo: dependency.repo,
      number: dependency.number,
      ...(state === undefined ? {} : { state }),
      ...(badge === undefined ? {} : { url: badge.url }),
      ...(badge?.headRef === undefined ? {} : { headRef: badge.headRef }),
      ...(rounds === undefined ? {} : { rounds }),
      ...(verdict === undefined ? {} : { verdictOnHead: verdict }),
      ...(badge?.reviewDecision === undefined ? {} : { reviewDecision: badge.reviewDecision }),
      ...(owner === undefined || owner.threadId === facts.thread.id
        ? {}
        : { threadId: owner.threadId }),
      setBy: dependency.setBy,
      ...(dependency.mergeAfter === false ? { mergeAfter: false as const } : {}),
      ...(drags ? { drags: true as const } : {}),
    };
  });

/** Automation armed on this worker: an idle turn can deliberately yield to these events. */
export const waitingOnAutomation = (
  thread: Thread,
  wakes: ReadonlyArray<PendingWake> = [],
): boolean =>
  wakes.length > 0 ||
  (thread.runWatches?.length ?? 0) > 0 ||
  [thread.boundPr, ...(thread.extraPrs ?? [])].some(
    (pr) => pr?.monitor === true || pr?.reviewMonitor === true || pr?.mergeWhenReady !== undefined,
  );

/** An unfinished worker's unreported stop, or its live silent tool, excluding deliberate waits. */
const quietOfWorker = (facts: WorkerFacts, state: WorkerState): WorkerQuiet | undefined => {
  const report = facts.lastReport;
  const awaitingReply =
    (report?.state === "blocked" || report?.state === "question") &&
    (facts.memo?.lastInputAt === undefined || report.at >= facts.memo.lastInputAt);
  if (
    facts.thread.parked ||
    facts.compacting === true ||
    facts.memo?.userIntervened ||
    facts.pendingRequests.length > 0 ||
    (facts.status !== "running" && waitingOnAutomation(facts.thread, facts.wakes)) ||
    FINISHED_STATES.has(state) ||
    state === "done" ||
    state === "blocked" ||
    state === "question" ||
    state === "error" ||
    awaitingReply
  )
    return undefined;
  if (facts.quiet !== undefined && facts.status === "running") return facts.quiet;
  if (
    (facts.status !== "idle" && facts.status !== "cold") ||
    (facts.memo?.background?.length ?? 0) > 0
  )
    return undefined;
  const quiet = facts.memo?.quiet;
  if (
    quiet === undefined ||
    facts.memo?.reportInTurn ||
    (facts.lastReport?.at ?? -Infinity) >= quiet.at
  )
    return undefined;
  return quiet;
};

/** The worker's plan progress for its row: none until it keeps a plan or a todo list with steps. */
const planOfWorker = (facts: WorkerFacts): WorkerLedgerEntry["plan"] => {
  const headline = planHeadline({
    thread: facts.thread,
    status: facts.status,
    pendingRequests: facts.requests ?? [],
    git: facts.threadGit ?? facts.git,
    plan: facts.plan?.plan,
    turnPlan: facts.plan?.turnPlan,
    error: facts.thread.lastError?.text,
    now: facts.now ?? facts.thread.lastActivityAt,
  });
  if (headline === undefined || headline.total === 0) return undefined;
  return { done: headline.done, total: headline.total, headline: redactText(headline.text) };
};

/**
 * Whether a PR could be opened from any repo the worker works in (`workerState`'s `canOpenPr`).
 * `GitState.origin` and an extra worktree's sampled `repo` are the `owner/repo` of a GitHub
 * `origin`, so a checkout whose state is known and names none has nowhere to open one. Before the
 * first git state nobody knows, and the answer is yes.
 */
export const canOpenPr = (facts: Pick<WorkerFacts, "git" | "extras">): boolean =>
  facts.git === undefined ||
  (facts.git.repo && facts.git.origin !== undefined) ||
  facts.extras.some((extra) => extra.repo !== undefined);

/** A merged PR frees a slot only once its worker has no ongoing execution or explicit waits. */
export const isLiveWorker = (
  worker: Pick<WorkerLedgerEntry, "state" | "status"> & Partial<WorkerLedgerEntry>,
): boolean =>
  worker.status !== "ended" &&
  (!FINISHED_STATES.has(worker.state) ||
    workerHasOngoingWork({ pendingRequests: [], userIntervened: false, ...worker }));

/** The workers a ledger reads as finished: delivered, merged or archived. */
export const finishedWorkers = (
  features: ReadonlyArray<FeatureLedgerEntry>,
): ReadonlySet<ThreadId> =>
  new Set(
    features
      .flatMap((feature) => feature.workers)
      .filter((worker) => FINISHED_STATES.has(worker.state))
      .map((worker) => worker.threadId),
  );

/** The required checks, and the rest where they differ, so a red check nobody requires reads as such. */
const checksText = (badge: PrStatus): string => {
  const required = requiredChecksOf(badge);
  return required === badge.checks ? required : `${required} (not required: ${badge.checks})`;
};

/** Where the bot is with the head, as `WorkerPr.botOnHead` says it. */
const botOnHead = (review: PrStatus["review"]): WorkerPr["botOnHead"] =>
  review?.roundInFlight === true
    ? "reviewing"
    : review?.reviewedHead === true || review?.verdictOnHead !== undefined
      ? "reviewed"
      : undefined;

/** The ledger distinguishes disabled checks from qualification, even before a PR is bound. */
const localGateOf = (project: Project | undefined) =>
  project?.localCheckUnavailable !== undefined
    ? { localGate: project.localCheckUnavailable }
    : project === undefined || (project.localCheck?.command?.trim() ?? "") !== ""
      ? {}
      : {
          localGate: `no local check configured for ${project.name}; local gate OFF — CI and GitHub rules apply`,
        };

/** One PR as a ledger row, with the merge intent its binding carries. */
export const prRow = (
  repo: string,
  badge: PrStatus,
  intent?: MergeIntent | undefined,
  monitored = false,
  waiting?: MergeWaiting | undefined,
): WorkerPr => {
  const verdict = badge.review?.verdictOnHead;
  const bot = botOnHead(badge.review);
  const changesBy = (badge.review?.humanReviews ?? [])
    .filter((review) => review.verdict === "changesRequested")
    .map((review) => review.author);
  return {
    repo,
    number: badge.number,
    state: prFactsOf(badge).state,
    checks: checksText(badge),
    ...(monitored ? { monitored: true as const } : {}),
    ...(verdict === undefined ? {} : { verdictOnHead: verdict }),
    ...(badge.mergeState === undefined ? {} : { mergeState: badge.mergeState }),
    url: badge.url,
    ...(badge.reviewDecision === undefined ? {} : { reviewDecision: badge.reviewDecision }),
    ...(badge.reviewRequests === undefined || badge.reviewRequests.length === 0
      ? {}
      : { reviewRequests: badge.reviewRequests }),
    ...(changesBy.length === 0 ? {} : { changesRequestedBy: changesBy }),
    ...(bot === undefined ? {} : { botOnHead: bot }),
    ...(badge.reviewUnread === true ? { reviewUnread: true as const } : {}),
    ...(intent === undefined
      ? {}
      : {
          mergeWhenReady: {
            ...(intent.hold === undefined ? {} : { hold: redactText(intent.hold) }),
            ...(intent.holdWaitsOn === undefined ? {} : { holdWaitsOn: intent.holdWaitsOn }),
            ...(intent.heldBy === undefined ? {} : { heldBy: intent.heldBy }),
            ...(intent.after?.length ? { after: intent.after } : {}),
            ...(intent.failedOn !== undefined && intent.failedOn === badge.headRefOid
              ? { refused: true as const }
              : {}),
            ...(waiting === undefined ? {} : { waiting: redactText(waiting.why) }),
          },
        }),
  };
};

const prOf = (
  facts: WorkerFacts,
  badge: PrStatus | undefined,
  workspacePrs: WorkspacePrs,
): WorkerPr | undefined => {
  const { thread } = facts;
  if (badge === undefined) return undefined;
  const repo = thread.boundPr?.repo ?? repoFromPrUrl(badge.url);
  if (repo === undefined) return undefined;
  const row = prRow(
    repo,
    badge,
    thread.boundPr?.mergeWhenReady,
    thread.boundPr?.monitor === true || thread.boundPr?.reviewMonitor === true,
    thread.boundPr?.mergeWaiting,
  );
  return boundRow(
    facts,
    facts.localCheck === undefined ? row : { ...row, localCheck: facts.localCheck },
    workspacePrs,
  );
};

/** The bound PR's row with the PRs it depends on, and how long it has conflicted meanwhile. */
const boundRow = (facts: WorkerFacts, row: WorkerPr, workspacePrs: WorkspacePrs): WorkerPr => {
  if ((facts.thread.boundPr?.dependsOn ?? []).length === 0) return row;
  const conflictedMin =
    facts.conflictedSince === undefined || facts.now === undefined
      ? undefined
      : Math.max(0, Math.floor((facts.now - facts.conflictedSince) / 60_000));
  return {
    ...row,
    dependsOn: dependencyRows(facts, workspacePrs, conflictedMin),
    ...(conflictedMin === undefined ? {} : { conflictedMin }),
  };
};

/** The cached badge of one of the thread's `extraPrs`, which `GitState.extraPrs` matches by URL. */
const extraBadge = (
  badges: ReadonlyArray<PrStatus>,
  bound: Pick<BoundPr, "repo" | "number">,
): PrStatus | undefined =>
  badges.find((badge) => {
    const repo = repoFromPrUrl(badge.url);
    return repo !== undefined && samePr({ repo, number: badge.number }, bound);
  });

const sameRepo = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

/** One of the thread's `extraPrs` as a ledger row: the badge's words, or repo and number until then. */
const extraRow = (facts: WorkerFacts, bound: BoundPr): WorkerPr => {
  const badge = extraBadge(facts.extraBadges, bound);
  return badge === undefined
    ? { repo: bound.repo, number: bound.number }
    : prRow(bound.repo, badge, bound.mergeWhenReady, bound.monitor || bound.reviewMonitor === true);
};

/**
 * One `alsoIn` row per extra worktree whose project is still known. Its PRs are the thread's bound
 * PRs in that worktree's repo (`extraPrs`, then `boundPr`, for a worker whose first PR happened to be
 * opened there), the first as `pr` and the rest as `morePrs`, with the badge's words when the
 * publisher has one and the repo and number alone until then.
 */
const alsoInOf = (facts: WorkerFacts, workspacePrs: WorkspacePrs): ReadonlyArray<WorkerRepo> =>
  facts.extras.flatMap((extra): ReadonlyArray<WorkerRepo> => {
    if (extra.project === undefined) return [];
    const bound = [...(facts.thread.extraPrs ?? []), facts.thread.boundPr].filter(
      (pr): pr is BoundPr => pr !== undefined && sameRepo(pr.repo, extra.repo),
    );
    const rows = bound.map((pr): WorkerPr => {
      if (pr !== facts.thread.boundPr) return extraRow(facts, pr);
      const badge = primaryBadge(facts);
      return boundRow(
        facts,
        badge === undefined
          ? { repo: pr.repo, number: pr.number }
          : prRow(
              pr.repo,
              badge,
              pr.mergeWhenReady,
              pr.monitor || pr.reviewMonitor === true,
              pr.mergeWaiting,
            ),
        workspacePrs,
      );
    });
    const [pr, ...morePrs] = rows;
    return [
      {
        projectId: extra.project.id,
        project: extra.project.name,
        ...localGateOf(extra.project),
        ...(extra.checkout.branch === undefined ? {} : { branch: extra.checkout.branch }),
        ...(pr === undefined ? {} : { pr }),
        ...(morePrs.length === 0 ? {} : { morePrs }),
        changedFiles: extra.files.length,
      },
    ];
  });

/**
 * The badge of the PR the worker acts on. A bound PR not looked up yet, or still showing the
 * previous binding's badge (which may share its number from another repo), has none.
 */
const primaryBadge = (facts: Pick<WorkerFacts, "thread" | "badge">): PrStatus | undefined => {
  const bound = facts.thread.boundPr;
  return bound !== undefined && !isBoundBadge(facts.badge, bound) ? undefined : facts.badge;
};

/**
 * Every PR of the worker: the one it acts on, its branch's own when that is another, then the
 * extras, `undefined` for a bound one not looked up yet and nothing for one GitHub doesn't have.
 * What "finished" is decided on, here and in the worktree sweep.
 */
export const workerPrBadges = (
  facts: Pick<WorkerFacts, "thread" | "git" | "badge" | "extraBadges" | "missingPrs">,
): ReadonlyArray<PrStatus | undefined> => {
  const gone = (pr: Pick<BoundPr, "repo" | "number">) =>
    facts.missingPrs?.some((missing) => samePr(missing, pr)) === true;
  const branchPr = branchPrOf(facts.thread, facts.git);
  const primary = primaryBadge(facts);
  const bound = facts.thread.boundPr;
  return [
    ...(primary === undefined && (bound === undefined || gone(bound)) ? [] : [primary]),
    ...(branchPr === undefined ? [] : [branchPr]),
    ...(facts.thread.extraPrs ?? []).flatMap((extra) =>
      gone(extra) ? [] : [extraBadge(facts.extraBadges, extra)],
    ),
  ];
};

/** How full a context window is, 0–100; `undefined` when the agent reported no window. */
export const contextPct = (usage: UsageSummary | undefined): number | undefined => {
  if (usage?.contextTokens === undefined || usage.contextWindow === undefined) return undefined;
  if (usage.contextWindow <= 0) return undefined;
  return Math.min(100, Math.round((usage.contextTokens / usage.contextWindow) * 100));
};

const stateInputOf = (facts: WorkerFacts): WorkerStateInput => {
  const { thread, memo } = facts;
  const report = facts.lastReport;
  const badges = workerPrBadges(facts);
  const prFacts = combinePrFacts(
    badges.map((badge) => (badge === undefined ? undefined : prFactsOf(badge))),
  );
  return {
    status: facts.status,
    parked: thread.parked,
    completedReason: facts.completedReason,
    ...(report === undefined ? {} : { lastReport: { state: report.state, at: report.at } }),
    lastInputAt: memo?.lastInputAt,
    hasStartedTurn: memo?.started === true || facts.usage !== undefined,
    pendingRequestCount: facts.pendingRequests.length,
    ...(prFacts === undefined ? {} : { pr: prFacts }),
    reopened: reopenedSinceMerge(thread, badges),
    canOpenPr: canOpenPr(facts),
    ...(thread.lastError === undefined
      ? {}
      : {
          lastError: {
            at: thread.lastError.at,
            ...(thread.lastError.turnId === undefined ? {} : { turnId: thread.lastError.turnId }),
          },
        }),
    lastTurnId: facts.lastTurn?.id,
    lastTurnStartedAt: facts.lastTurn?.startedAt,
  };
};

const stateOf = (facts: WorkerFacts): WorkerState => workerState(stateInputOf(facts));

/** How many shared paths a ledger row keeps. */
const OVERLAP_FILES_KEPT = 10;

/** A thread's `lastError` as the ledger and the `workerError` wake carry it. */
export const workerErrorOf = (thread: Thread): WorkerError | undefined => {
  const error = thread.lastError;
  if (error === undefined) return undefined;
  return {
    kind: error.kind,
    ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
    text: error.text,
  };
};

const entryOf = (
  facts: WorkerFacts,
  state: WorkerState,
  overlapping: ReadonlyArray<ThreadId>,
  overlapFiles: ReadonlyArray<string>,
  workspacePrs: WorkspacePrs,
): WorkerLedgerEntry => {
  const { thread, memo } = facts;
  const report = facts.lastReport;
  const checkout = effectiveCheckout(thread);
  const branch = facts.git?.branch ?? checkout.branch;
  // A first PR opened in one of the other repos is that repo's row, not this one's.
  const elsewhere = facts.extras.some(
    (extra) =>
      sameRepo(extra.repo, thread.boundPr?.repo) && !sameRepo(facts.git?.origin, extra.repo),
  );
  const pr = elsewhere ? undefined : prOf(facts, primaryBadge(facts), workspacePrs);
  const ownRepo = pr?.repo ?? facts.git?.origin;
  const branchPr = branchPrOf(facts.thread, facts.git);
  const branchRepo =
    branchPr === undefined ? undefined : (repoFromPrUrl(branchPr.url) ?? facts.git?.origin);
  const morePrs = [
    ...(branchPr === undefined || branchRepo === undefined ? [] : [prRow(branchRepo, branchPr)]),
    ...(thread.extraPrs ?? [])
      .filter((extra) => sameRepo(extra.repo, ownRepo))
      .map((extra) => extraRow(facts, extra)),
  ];
  const alsoIn = alsoInOf(facts, workspacePrs);
  const pct = contextPct(facts.usage);
  const lastError = workerErrorOf(thread);
  const plan = planOfWorker(facts);
  const quiet = quietOfWorker(facts, state);
  const stands =
    (report?.state === "blocked" || report?.state === "question") &&
    (memo?.lastInputAt === undefined || report.at >= memo.lastInputAt);
  return {
    feature: thread.spawnedBy?.feature ?? "",
    projectId: thread.projectId,
    project: facts.project?.name ?? "",
    ...localGateOf(facts.project),
    threadId: thread.id,
    title: redactText(thread.title),
    ...(branch === undefined ? {} : { branch }),
    state,
    stateBase: workerStateBase(stateInputOf(facts)),
    status: facts.status,
    ...((facts.status === "idle" || facts.status === "cold") &&
    waitingOnAutomation(thread, facts.wakes)
      ? { waitingOnAutomation: true as const }
      : {}),
    ...(facts.compacting === true ? { compacting: true as const } : {}),
    ...(quiet === undefined ? {} : { quiet }),
    ...(lastError === undefined ? {} : { lastError }),
    ...(thread.limitWait === undefined || thread.limitWait.cancelled === true
      ? {}
      : { limitWait: { kind: thread.limitWait.kind, resumeAt: thread.limitWait.resumeAt } }),
    ...(report === undefined ? {} : { lastReport: report }),
    ...(stands ? { reportStands: true as const } : {}),
    pendingRequests: facts.pendingRequests,
    ...(pr === undefined ? {} : { pr }),
    ...(morePrs.length === 0 ? {} : { morePrs }),
    changedFiles: Math.max(facts.git?.changedFiles ?? 0, facts.files.length),
    ...(facts.git?.missing === true ? { worktreeMissing: true as const } : {}),
    ...(alsoIn.length === 0 ? {} : { alsoIn }),
    overlapsWith: overlapping,
    ...(overlapFiles.length === 0 ? {} : { overlapFiles }),
    // Dollars only where they are a bill: a gateway profile's own key. A subscription's are limits.
    ...(facts.usage?.costUsd === undefined || thread.model.profileId === undefined
      ? {}
      : { costUsd: facts.usage.costUsd }),
    ...(pct === undefined ? {} : { contextPct: pct }),
    ...(plan === undefined ? {} : { plan }),
    userIntervened: memo?.userIntervened === true,
    messagesFromOrchestrator: memo?.messages ?? 0,
    ...(facts.wakes === undefined || facts.wakes.length === 0 ? {} : { wakes: facts.wakes }),
    ...(thread.runWatches?.length ? { runWatches: thread.runWatches } : {}),
  };
};

/**
 * Workers as features: grouped by slug in order of first spawn, each group oldest worker first,
 * with the stage somebody set for it, the group it was put in and whether the user paused it
 * (`staged`, from the workspace).
 */
export const featuresOf = (
  workers: ReadonlyArray<WorkerFacts>,
  staged: Partial<Pick<WorkspaceState, "stages" | "groups" | "pausedFeatures" | "charter">> = {},
): ReadonlyArray<FeatureLedgerEntry> => {
  const states = new Map(workers.map((facts) => [facts.thread.id, stateOf(facts)]));
  // Overlap is advice on sequencing work under way. A delivered worker's files differ from the base
  // for as long as nothing merges its branch, which would flag every later worker against it.
  const pairs = overlapPairs(
    workers
      .filter((facts) => !FINISHED_STATES.has(states.get(facts.thread.id)!))
      .flatMap((facts) => [
        {
          threadId: facts.thread.id,
          projectId: facts.thread.projectId,
          files: facts.files,
          signatures: facts.signatures,
        },
        // Each of its other repos under that repo's own project, since overlap is per repo.
        ...facts.extras.flatMap((extra) =>
          extra.project === undefined
            ? []
            : [
                {
                  threadId: facts.thread.id,
                  projectId: extra.project.id,
                  files: extra.files,
                  signatures: extra.signatures,
                },
              ],
        ),
      ]),
    staged.charter?.overlapIgnorePaths,
  );
  const overlapping = new Map<ThreadId, { ids: Set<ThreadId>; files: Set<string> }>();
  for (const [pair, files] of pairs) {
    const ids = pair.split(" ") as [ThreadId, ThreadId];
    for (const [own, other] of [ids, [ids[1], ids[0]]] as const) {
      const found = overlapping.get(own) ?? { ids: new Set(), files: new Set() };
      found.ids.add(other);
      for (const file of files) found.files.add(file);
      overlapping.set(own, found);
    }
  }
  const workspacePrs = new Map<string, { readonly threadId: ThreadId; readonly badge: PrStatus }>();
  for (const facts of workers) {
    const badge = primaryBadge(facts);
    const repo = badge === undefined ? undefined : repoFromPrUrl(badge.url);
    if (badge === undefined || repo === undefined) continue;
    workspacePrs.set(prKey({ repo, number: badge.number }), { threadId: facts.thread.id, badge });
  }
  const groups = new Map<string, Array<WorkerLedgerEntry>>();
  for (const facts of workers.toSorted((a, b) => a.thread.createdAt - b.thread.createdAt)) {
    const found = overlapping.get(facts.thread.id);
    const entry = entryOf(
      facts,
      states.get(facts.thread.id)!,
      [...(found?.ids ?? [])].toSorted(),
      [...(found?.files ?? [])].toSorted().slice(0, OVERLAP_FILES_KEPT),
      workspacePrs,
    );
    groups.set(entry.feature, [...(groups.get(entry.feature) ?? []), entry]);
  }
  return [...groups].map(([feature, entries]) => {
    const group = groupOf(staged.groups, feature);
    const stage = staged.stages?.[feature];
    return {
      feature,
      ...(group === undefined ? {} : { group }),
      state: featureState(entries.map((entry) => entry.state)),
      ...(stage === undefined ? {} : { stage }),
      ...(staged.pausedFeatures?.includes(feature) === true ? { paused: true as const } : {}),
      workers: entries,
    };
  });
};

/**
 * The workspace's groups as the ledger shows them, in the order they were made. A group's state is
 * its least advanced feature's, by the same ordering a feature takes from its workers; a feature
 * that is named in a group and has no worker yet is listed and doesn't count.
 */
export const groupsOf = (
  features: ReadonlyArray<FeatureLedgerEntry>,
  groups: WorkspaceState["groups"],
): ReadonlyArray<FeatureGroupLedgerEntry> =>
  Object.entries(groups ?? {}).map(([group, stored]) => ({
    group,
    features: stored.features,
    state: featureState(
      features.filter((feature) => stored.features.includes(feature.feature)).map((f) => f.state),
    ),
    ...(stored.stage === undefined ? {} : { stage: stored.stage }),
  }));

/**
 * Today's spend, brought up to date from each thread's cumulative cost. A counter's growth since it
 * was last read goes into today's bucket, so growth across midnight lands on the day it was read;
 * a thread seen for the first time brings its whole cost when it was created today (a worker this
 * orchestrator spawned) and only a baseline otherwise. "Today" is the calendar day in `timeZone`,
 * so a daylight-saving change or a change of zone within that day keeps the bucket's spend.
 * Threads that report no cost add nothing, which in P1 is nobody: only Claude is admitted.
 * The figure is shown in the ledger and the digest; nothing is enforced against it.
 */
export const accrueCost = (
  bucket: CostBucket,
  threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly createdAt: number;
    readonly costUsd: number | undefined;
  }>,
  now: number,
  timeZone: string,
): CostBucket => {
  const { date, start: day } = localDayOf(now, timeZone);
  // A bucket kept before it recorded its date has only its start to go by.
  const sameDay = bucket.date === undefined ? bucket.day === day : bucket.date === date;
  let usd = sameDay ? bucket.usd : 0;
  const seen: Record<string, number> = { ...bucket.seen };
  for (const thread of threads) {
    if (thread.costUsd === undefined) continue;
    const before = seen[thread.id];
    if (before === undefined) {
      if (thread.createdAt >= day) usd += thread.costUsd;
    } else if (thread.costUsd > before) {
      usd += thread.costUsd - before;
    }
    seen[thread.id] = thread.costUsd;
  }
  return { day, date, usd, seen };
};

/**
 * The charter's one cap beside the workers that count against it, the subscription limits in use
 * with the threshold new workers pause at, and today's spend for information.
 */
export const metersOf = (input: {
  readonly state: WorkspaceState;
  readonly features: ReadonlyArray<FeatureLedgerEntry>;
  readonly costUsdToday: number;
  readonly limits?: ReadonlyArray<LimitUse> | undefined;
}): BudgetMeters => {
  const pauseAtPct = input.state.charter.pauseAtLimitPct;
  const limits = input.limits ?? [];
  return {
    liveWorkers: input.features.flatMap((feature) => feature.workers).filter(isLiveWorker).length,
    maxConcurrentWorkers: input.state.charter.maxConcurrentWorkers,
    costUsdToday: input.costUsdToday,
    ...(pauseAtPct === undefined ? {} : { pauseAtPct }),
    ...(limits.length === 0 ? {} : { limits }),
  };
};

/** The ledger as `orchestrator.ledger` and `list_workers` return it. */
export const ledgerOf = (input: {
  readonly state: WorkspaceState;
  readonly features: ReadonlyArray<FeatureLedgerEntry>;
  /** `groupsOf` over every feature, the ones `features` leaves out included. */
  readonly groups?: ReadonlyArray<FeatureGroupLedgerEntry> | undefined;
  readonly budget: BudgetMeters;
  readonly orchestratorEdits: number;
  /** Low-priority briefs held until a limit resets. */
  readonly held?: ReadonlyArray<HeldBrief> | undefined;
  /** The workers' questions, open ones first (`ledgerQuestions`). */
  readonly questions?: ReadonlyArray<WorkerQuestion> | undefined;
  readonly now: number;
}): OrchestratorLedger => {
  const { workspace, paused } = input.state;
  const groups = input.groups ?? [];
  const held = input.held ?? [];
  const questions = input.questions ?? [];
  return {
    workspaceId: workspace.id,
    ...(workspace.orchestratorThreadId === undefined
      ? {}
      : { orchestratorThreadId: workspace.orchestratorThreadId }),
    features: input.features,
    ...(groups.length === 0 ? {} : { groups }),
    budget: input.budget,
    orchestratorEdits: input.orchestratorEdits,
    ...(paused === undefined ? {} : { paused }),
    ...(held.length === 0 ? {} : { held }),
    ...(questions.length === 0 ? {} : { questions }),
    builtAt: input.now,
  };
};

/**
 * The features a digest or `list_workers` shows: archived workers are left out unless asked for,
 * and with `since`, so are finished ones (delivered, merged, archived) last active before it.
 */
export const visibleFeatures = (
  features: ReadonlyArray<FeatureLedgerEntry>,
  lastActivityAt: (threadId: ThreadId) => number,
  options: { readonly includeArchived: boolean; readonly since?: number | undefined },
): ReadonlyArray<FeatureLedgerEntry> =>
  features
    .map((feature) => ({
      ...feature,
      workers: feature.workers.filter((worker) => {
        if (worker.state === "archived" && !options.includeArchived) return false;
        if (options.since === undefined || !FINISHED_STATES.has(worker.state)) return true;
        return lastActivityAt(worker.threadId) >= options.since;
      }),
    }))
    .filter((feature) => feature.workers.length > 0);

/**
 * `list_workers`' filters on top of `visibleFeatures`: only workers in one of `states`, and with
 * `live`, only those that count against the cap (`isLiveWorker`). A feature left with none goes.
 */
export const filterWorkers = (
  features: ReadonlyArray<FeatureLedgerEntry>,
  options: {
    readonly states?: ReadonlyArray<WorkerState> | undefined;
    readonly live?: boolean | undefined;
  },
): ReadonlyArray<FeatureLedgerEntry> => {
  const { states, live } = options;
  if (states === undefined && live !== true) return features;
  return features
    .map((feature) => ({
      ...feature,
      workers: feature.workers.filter(
        (worker) =>
          (states === undefined || states.includes(worker.state)) &&
          (live !== true || isLiveWorker(worker)),
      ),
    }))
    .filter((feature) => feature.workers.length > 0);
};

/** How much of a last report's summary a compact row quotes. */
const COMPACT_SUMMARY_MAX = 200;

const clipped = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

/** A worker's row as `list_workers` shows it by default: what to act on, without the long text. */
export type CompactWorkerRow = Pick<WorkerLedgerEntry, "threadId" | "title" | "state" | "status"> &
  Partial<
    Pick<
      WorkerLedgerEntry,
      | "project"
      | "branch"
      | "pr"
      | "morePrs"
      | "alsoIn"
      | "pendingRequests"
      | "overlapsWith"
      | "changedFiles"
      | "costUsd"
      | "userIntervened"
      | "wakes"
      | "runWatches"
      | "plan"
      | "quiet"
      | "compacting"
      | "waitingOnAutomation"
    >
  > & {
    readonly lastReport?: Pick<WorkerReport, "state" | "at" | "summary" | "evidence"> & {
      /** The report states an interface, which `detail` quotes. */
      readonly hasInterface?: true;
    };
  };

/**
 * A row cut to what an orchestrator acts on: empty lists, zero counts and `false` flags go, a last
 * report keeps `COMPACT_SUMMARY_MAX` characters of its summary and only the fact of an interface,
 * and the activity line, context meter and message count are left to `detail`.
 */
export const compactWorkerRow = (worker: WorkerLedgerEntry): CompactWorkerRow => {
  const report = worker.lastReport;
  return {
    threadId: worker.threadId,
    title: worker.title,
    state: worker.state,
    status: worker.status,
    ...(worker.compacting === true ? { compacting: true as const } : {}),
    ...(worker.quiet === undefined ? {} : { quiet: worker.quiet }),
    ...(worker.waitingOnAutomation === true ? { waitingOnAutomation: true as const } : {}),
    project: worker.project,
    ...(worker.branch === undefined ? {} : { branch: worker.branch }),
    ...(worker.pr === undefined ? {} : { pr: worker.pr }),
    ...(worker.morePrs === undefined || worker.morePrs.length === 0
      ? {}
      : { morePrs: worker.morePrs }),
    ...(worker.alsoIn === undefined || worker.alsoIn.length === 0 ? {} : { alsoIn: worker.alsoIn }),
    ...(report === undefined
      ? {}
      : {
          lastReport: {
            state: report.state,
            at: report.at,
            summary: clipped(report.summary, COMPACT_SUMMARY_MAX),
            ...(report.evidence === undefined ? {} : { evidence: report.evidence }),
            ...(report.interface === undefined ? {} : { hasInterface: true as const }),
          },
        }),
    ...(worker.pendingRequests.length === 0 ? {} : { pendingRequests: worker.pendingRequests }),
    ...(worker.overlapsWith.length === 0 ? {} : { overlapsWith: worker.overlapsWith }),
    ...(worker.changedFiles === 0 ? {} : { changedFiles: worker.changedFiles }),
    ...(worker.costUsd === undefined ? {} : { costUsd: worker.costUsd }),
    ...(worker.userIntervened ? { userIntervened: true } : {}),
    ...(worker.plan === undefined ? {} : { plan: worker.plan }),
    // A pending wake is something to act on: archiving its worker silences it.
    ...(worker.wakes === undefined || worker.wakes.length === 0 ? {} : { wakes: worker.wakes }),
    ...(worker.runWatches?.length ? { runWatches: worker.runWatches } : {}),
  };
};
