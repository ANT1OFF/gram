import {
  mergeStateAllowsMerge,
  requiredChecksOf,
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
} from "@gram/contracts";

// The orchestration mock's ledger rows: a worker's state from its thread, its PR rows, and
// features as far along as their slowest worker, cut down from the server's rules.

/** The ledger's order from least to most advanced; a feature is as far along as its slowest worker. */
export const ADVANCEMENT: readonly WorkerState[] = [
  "error",
  "blocked",
  "question",
  "needsUser",
  "briefed",
  "working",
  "done",
  "inReview",
  "readyToMerge",
  "delivered",
  "merged",
  "archived",
];

/**
 * A cut-down version of the server's rule for where a worker stands, from what the mock knows
 * about its thread.
 */
export const mockWorkerState = (
  summary: Pick<ThreadSummary, "thread" | "status" | "git">,
  lastReport: WorkerReport | undefined,
): WorkerState => {
  if (summary.thread.parked) return "archived";
  if (summary.status === "error") return "error";
  if (summary.status === "needsApproval" || summary.status === "needsInput") return "needsUser";
  const pr = summary.git?.pr;
  if (pr?.state === "MERGED") return "merged";
  if (pr?.state === "OPEN") {
    return requiredChecksOf(pr) === "passing" &&
      pr.review?.verdictOnHead === "approved" &&
      mergeStateAllowsMerge(pr.mergeState)
      ? "readyToMerge"
      : "inReview";
  }
  // Done with no PR in a checkout known to have no GitHub remote: finished, and never "merged".
  if (
    lastReport?.state === "done" &&
    summary.git?.repo === true &&
    summary.git.origin === undefined
  )
    return "delivered";
  if (lastReport !== undefined && lastReport.state !== "progress") return lastReport.state;
  if (summary.status === "running" || summary.status === "starting") return "working";
  return lastReport === undefined ? "briefed" : "working";
};

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
    state: mockWorkerState(summary, lastReport),
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

export const leastAdvanced = (states: readonly WorkerState[]): WorkerState =>
  states.reduce((least, state) =>
    ADVANCEMENT.indexOf(state) < ADVANCEMENT.indexOf(least) ? state : least,
  );

/** Workers grouped by feature in first-seen order, each group as far along as its slowest worker. */
export const groupByFeature = (workers: readonly WorkerLedgerEntry[]): FeatureLedgerEntry[] => {
  const groups = new Map<string, WorkerLedgerEntry[]>();
  for (const worker of workers) {
    groups.set(worker.feature, [...(groups.get(worker.feature) ?? []), worker]);
  }
  return [...groups].map(([feature, members]) => ({
    feature,
    state: leastAdvanced(members.map((member) => member.state)),
    workers: members,
  }));
};
