import {
  featureState,
  prFactsOf,
  reopenedSinceMerge,
  requiredChecksOf,
  workerState,
  workerStateBase,
  type FeatureLedgerEntry,
  WORKER_REQUEST_SUMMARY_MAX,
  type MergeIntent,
  type PendingRequest,
  type PrStatus,
  type ThreadId,
  type ThreadSummary,
  type WorkerLedgerEntry,
  type WorkerPr,
  type WorkerRepo,
  type WorkerReport,
  type WorkerState,
  type WorkerStateInput,
} from "@gram/contracts";

// The orchestration mock's ledger rows: a worker's state from its thread by the server's own rule
// (`workerState`), its PR rows, and features as far along as their slowest worker (`featureState`).

/** What the mock knows of a worker, as the facts the server's rule reads. */
type MockWorkerFacts = Pick<ThreadSummary, "thread" | "status" | "git"> &
  Partial<Pick<ThreadSummary, "pendingRequests">>;

/**
 * The server's `WorkerStateInput` from what the mock knows about a worker's thread. The mock keeps
 * no input times or turn rows, so a report always stands and a turn has started once it reported.
 */
export const mockStateInput = (
  summary: MockWorkerFacts,
  lastReport: WorkerReport | undefined,
): WorkerStateInput => {
  const { thread, git } = summary;
  const badge = git?.pr;
  return {
    status: summary.status,
    parked: thread.parked,
    completedReason: thread.completedReason,
    ...(lastReport === undefined
      ? {}
      : { lastReport: { state: lastReport.state, at: lastReport.at } }),
    hasStartedTurn: lastReport !== undefined,
    pendingRequestCount: summary.pendingRequests?.length ?? 0,
    ...(badge === undefined ? {} : { pr: prFactsOf(badge) }),
    reopened: reopenedSinceMerge(thread, [badge]),
    // Known to have no GitHub remote: no PR can be opened, so done is delivered.
    canOpenPr: !(git?.repo === true && git.origin === undefined),
    ...(thread.lastError === undefined
      ? {}
      : {
          lastError: {
            at: thread.lastError.at,
            ...(thread.lastError.turnId === undefined ? {} : { turnId: thread.lastError.turnId }),
          },
        }),
  };
};

/** Where a worker stands, by the server's rule over what the mock knows. */
export const mockWorkerState = (
  summary: MockWorkerFacts,
  lastReport: WorkerReport | undefined,
): WorkerState => workerState(mockStateInput(summary, lastReport));

/** What the ledger knows about a worker beyond its thread: only the simulations set any of it. */
export interface WorkerExtras {
  readonly lastReport?: WorkerReport | undefined;
  /** When each pending request was raised, epoch ms. */
  readonly askedAt: ReadonlyMap<string, number>;
  readonly overlapsWith: readonly ThreadId[];
  readonly userIntervened: boolean;
  readonly alsoIn?: readonly WorkerRepo[] | undefined;
  readonly now: number;
}

/** The server's ledger row for a PR, cut down to what the badge says. */
export const mockPrRow = (
  repo: string,
  badge: PrStatus,
  intent: MergeIntent | undefined,
): WorkerPr => {
  const review = badge.review;
  const verdict = review?.verdictOnHead;
  const changesBy = (review?.humanReviews ?? [])
    .filter((each) => each.verdict === "changesRequested")
    .map((each) => each.author);
  return {
    repo,
    number: badge.number,
    state: badge.state === "MERGED" ? "merged" : badge.state === "CLOSED" ? "closed" : "open",
    checks: requiredChecksOf(badge),
    ...(verdict === undefined ? {} : { verdictOnHead: verdict }),
    ...(badge.mergeState === undefined ? {} : { mergeState: badge.mergeState }),
    url: badge.url,
    ...(badge.reviewDecision === undefined ? {} : { reviewDecision: badge.reviewDecision }),
    ...(badge.reviewRequests === undefined ? {} : { reviewRequests: badge.reviewRequests }),
    ...(changesBy.length === 0 ? {} : { changesRequestedBy: changesBy }),
    ...(review?.roundInFlight === true
      ? { botOnHead: "reviewing" as const }
      : review?.reviewedHead === true
        ? { botOnHead: "reviewed" as const }
        : {}),
    ...(badge.reviewUnread === true ? { reviewUnread: true as const } : {}),
    ...(intent === undefined
      ? {}
      : {
          mergeWhenReady: {
            ...(intent.hold === undefined ? {} : { hold: intent.hold }),
            ...(intent.holdWaitsOn === undefined ? {} : { holdWaitsOn: intent.holdWaitsOn }),
            ...(intent.heldBy === undefined ? {} : { heldBy: intent.heldBy }),
            ...(intent.after?.length ? { after: intent.after } : {}),
            ...(intent.failedOn !== undefined && intent.failedOn === badge.headRefOid
              ? { refused: true as const }
              : {}),
          },
        }),
  };
};

export const ledgerEntry = (
  summary: ThreadSummary,
  feature: string,
  projectName: string,
  { lastReport, askedAt, overlapsWith, userIntervened, alsoIn, now }: WorkerExtras,
): WorkerLedgerEntry => {
  const { thread, git, usage } = summary;
  return {
    feature,
    projectId: thread.projectId,
    project: projectName,
    threadId: thread.id,
    title: thread.title,
    ...(thread.checkout.branch === undefined ? {} : { branch: thread.checkout.branch }),
    state: workerState(mockStateInput(summary, lastReport)),
    stateBase: workerStateBase(mockStateInput(summary, lastReport)),
    status: summary.status,
    ...(summary.activity === undefined ? {} : { activity: summary.activity }),
    ...(thread.lastError === undefined
      ? {}
      : {
          lastError: {
            kind: thread.lastError.kind,
            ...(thread.lastError.httpStatus === undefined
              ? {}
              : { httpStatus: thread.lastError.httpStatus }),
            text: thread.lastError.text,
          },
        }),
    ...(lastReport === undefined ? {} : { lastReport }),
    pendingRequests: summary.pendingRequests.map((request) => {
      const asked = askedAt.get(request.id) ?? now;
      return {
        kind: request.kind,
        ageMin: Math.max(0, Math.floor((now - asked) / 60_000)),
        askedAt: asked,
        requestId: request.id,
        summary: requestSummary(request).slice(0, WORKER_REQUEST_SUMMARY_MAX),
      };
    }),
    ...(git?.pr === undefined || git.origin === undefined
      ? {}
      : {
          pr: {
            ...mockPrRow(git.origin, git.pr, thread.boundPr?.mergeWhenReady),
            ...(thread.boundPr?.monitor || thread.boundPr?.reviewMonitor
              ? { monitored: true as const }
              : {}),
            ...((thread.boundPr?.dependsOn ?? []).length === 0
              ? {}
              : {
                  dependsOn: (thread.boundPr?.dependsOn ?? []).map((dependency) => ({
                    repo: dependency.repo,
                    number: dependency.number,
                    state: dependency.seen?.state ?? "open",
                    setBy: dependency.setBy,
                    ...(dependency.mergeAfter === false ? { mergeAfter: false as const } : {}),
                  })),
                }),
          },
        }),
    changedFiles: git?.changedFiles ?? 0,
    ...(alsoIn === undefined ? {} : { alsoIn }),
    overlapsWith,
    ...(usage?.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
    userIntervened,
    messagesFromOrchestrator: 0,
    ...(thread.runWatches?.length ? { runWatches: thread.runWatches } : {}),
  };
};

/** What a request asks, in the worker's words: the command, the questions, the plan's first lines. */
export const requestSummary = (request: PendingRequest): string => {
  if (request.kind === "question") return request.questions.map((q) => q.question).join("\n");
  if (request.kind === "plan") return request.plan.split("\n").slice(0, 3).join("\n");
  const command = request.input["command"];
  return typeof command === "string" ? command : request.displayName;
};

/** The server's slug rule, cut down: lower-case words joined by dashes. */
export const slugOf = (raw: string): string | undefined => {
  const slug = raw
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return slug === "" || slug.length > 48 ? undefined : slug;
};

/** Workers grouped by feature in first-seen order, each group as far along as its slowest worker. */
export const groupByFeature = (workers: readonly WorkerLedgerEntry[]): FeatureLedgerEntry[] => {
  const groups = new Map<string, WorkerLedgerEntry[]>();
  for (const worker of workers) {
    groups.set(worker.feature, [...(groups.get(worker.feature) ?? []), worker]);
  }
  return [...groups].map(([feature, members]) => ({
    feature,
    state: featureState(members.map((member) => member.state)),
    workers: members,
  }));
};
