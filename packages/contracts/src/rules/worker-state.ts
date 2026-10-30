// Where a worker stands, and so where its feature and group stand: one rule for the server's
// ledger, the board's live overlay and the web's mock ledger, so a card, its band and the ledger
// can't disagree. Pure functions over plain data; nothing here is stored.

import type { CompletedReason } from "../domain.ts";
import type { PrFacts } from "../completion.ts";
import type { TurnId } from "../ids.ts";
import type {
  WorkerLedgerEntry,
  WorkerReportState,
  WorkerState,
  WorkerStateBase,
} from "../orchestration.ts";
import type { ThreadStatus } from "../thread-status.ts";

/** What of a worker can change from one moment to the next: its thread's status and requests. */
export interface WorkerLive {
  readonly status: ThreadStatus;
  /** Approval, question and plan requests waiting on the user. */
  readonly pendingRequestCount: number;
}

/** The facts a worker's state is derived from; nothing of it is stored. */
export interface WorkerStateInput extends WorkerLive {
  readonly parked: boolean;
  readonly completedReason?: CompletedReason | undefined;
  readonly lastReport?: { readonly state: WorkerReportState; readonly at: number } | undefined;
  /** Epoch ms of the latest input the worker was given, by the user or the orchestrator. */
  readonly lastInputAt?: number | undefined;
  /** A turn has started at some point, so the brief has been picked up. */
  readonly hasStartedTurn: boolean;
  /**
   * The bound PR's badge through `prFactsOf`, or every PR's through `combinePrFacts` for a worker
   * with more than one; absent without a PR or before its first lookup.
   */
  readonly pr?: PrFacts | undefined;
  /**
   * The thread was reopened since its merges (`reopenedSinceMerge`): work resumed after them, so
   * the merged badges it still carries don't make it merged.
   */
  readonly reopened?: boolean | undefined;
  /**
   * Whether a PR could be opened from any repo the worker works in: `false` only when it is known
   * that none has a GitHub remote. Absent means it could, or that nobody knows yet.
   */
  readonly canOpenPr?: boolean | undefined;
  /**
   * The failure `Thread.lastError` records, which a later completed turn clears. It outlives the
   * session's own `error` status, which a restart doesn't keep.
   */
  readonly lastError?: { readonly at: number; readonly turnId?: TurnId | undefined } | undefined;
  /** The turn started last, and when, from the store's turn rows. */
  readonly lastTurnId?: TurnId | undefined;
  readonly lastTurnStartedAt?: number | undefined;
}

const failureStands = (input: WorkerStateInput): boolean => {
  const failure = input.lastError;
  if (failure === undefined) return false;
  return failure.turnId !== undefined
    ? input.lastTurnId === undefined || input.lastTurnId === failure.turnId
    : input.lastTurnStartedAt === undefined || input.lastTurnStartedAt <= failure.at;
};

/**
 * Where a worker's facts leave it before its status and requests are weighed (`workerState`'s
 * rules 2 and 5 to 10, with "working" read off `hasStartedTurn` alone), and the two facts the
 * status rules need. The ledger carries it, so a client can lay a newer status over it.
 */
export const workerStateBase = (input: WorkerStateInput): WorkerStateBase => {
  const flags = {
    ...(input.parked ? { parked: true as const } : {}),
    ...(failureStands(input) ? { failureStands: true as const } : {}),
  };
  const at = (state: WorkerState): WorkerStateBase => ({ state, ...flags });
  if (
    input.reopened !== true &&
    (input.pr?.state === "merged" ||
      (input.completedReason === "prMerged" && input.pr?.state !== "open"))
  )
    return at("merged");
  if (input.pr?.state === "open") {
    return at(
      input.pr.checksGreen && input.pr.approvedOnHead && input.pr.mergeable
        ? "readyToMerge"
        : "inReview",
    );
  }
  const report = input.lastReport;
  const unanswered =
    report !== undefined && (input.lastInputAt === undefined || report.at >= input.lastInputAt);
  if (unanswered && (report.state === "blocked" || report.state === "question"))
    return at(report.state);
  const marked = input.completedReason === "agent" || input.completedReason === "user";
  if ((unanswered && report.state === "done") || marked) {
    return at(input.pr === undefined && input.canOpenPr === false ? "delivered" : "done");
  }
  return at(input.hasStartedTurn ? "working" : "briefed");
};

const waitsOnUser = (live: WorkerLive): boolean =>
  live.status === "needsApproval" || live.status === "needsInput" || live.pendingRequestCount > 0;

const turnLive = (live: WorkerLive): boolean =>
  live.status === "running" || live.status === "starting";

/**
 * A worker's state from its base and its thread's status and requests, the last half of
 * `workerState`. Live activity and a request waiting on the user both beat parking: a parked
 * worker reads `archived` only at rest with nothing waiting on the user.
 */
export const withLive = (base: WorkerStateBase, live: WorkerLive): WorkerState => {
  const waiting = waitsOnUser(live);
  if (base.parked === true) {
    if (waiting) return "needsUser";
    if (!turnLive(live)) return "archived";
  }
  if (base.state === "merged") return waiting ? "needsUser" : "merged";
  if (live.status === "error") return "error";
  if (base.failureStands === true && (live.status === "cold" || live.status === "idle"))
    return "error";
  if (waiting) return "needsUser";
  if (base.state === "briefed" && turnLive(live)) return "working";
  return base.state;
};

/**
 * Where a worker stands. The first rule that holds wins, most specific first:
 *
 * 1. `archived`: the thread is parked and at rest, and nothing waits on the user. A request it
 *    raises reads `needsUser`, and a turn it runs reads as it would unparked: live activity is
 *    never hidden by parking.
 * 2. `merged`: its PRs are merged, or the thread was completed because its PR merged, and none of
 *    its PRs is open: an open PR wins over a completion (`anyPrOpen`), as it does in the sidebar.
 *    Nor is it merged once reopened since those merges: it falls through to what it does now.
 *    A request waiting on the user still reads `needsUser`.
 * 3. `error`: the session is in `error`, or, at rest, the failure it last recorded is still its
 *    latest word: the failed turn is the last to have started, or, for a failure outside a turn
 *    (a session that wouldn't open), no turn has started since. After a restart every session
 *    is `cold`, so the failure is what tells. Turn identity, not input times, decides, since an
 *    input's bookkeeping can land after the failure it caused.
 * 4. `needsUser`: it waits on an approval, a question or a plan.
 * 5. `readyToMerge`: PR open, approved on head, checks green, mergeable.
 * 6. `inReview`: PR open.
 * 7. `blocked` / `question`: its latest report says so and no input has arrived since, so the
 *    report is still unanswered.
 * 8. `done`: its latest report says so and no input has arrived since, or the agent or the user
 *    marked it completed (an old idle completion is nobody's word, and doesn't count).
 *    Where no PR can be opened at all (`canOpenPr: false`) that is the end of the road, so it
 *    reads `delivered` instead of waiting for a review that can't come. Never `merged`: nothing the
 *    server can see says the branch is in main, and the ledger states only facts.
 * 9. `working`: a turn is running or starting, or one has started before. An idle worker that
 *    stopped without reporting reads `working` beside an `idle` status in the ledger.
 * 10. `briefed`: no turn has started yet.
 *
 * A closed, unmerged PR counts as no PR: the worker falls through to its report and status.
 * It is `withLive` over `workerStateBase`, so a client holding the base gets the same answer.
 */
export const workerState = (input: WorkerStateInput): WorkerState =>
  withLive(workerStateBase(input), input);

/**
 * A base for a ledger row that carries none (an older server's, or a test's): the row's own
 * state, with what the status rules made of it undone as far as the row can tell. A row that
 * reads `needsUser` or `error` doesn't say where it stood beneath, so it is taken to be working.
 */
const baseOfRow = (state: WorkerState): WorkerStateBase => {
  switch (state) {
    case "archived":
      return { state: "working", parked: true };
    case "error":
      return { state: "working", failureStands: true };
    case "needsUser":
      return { state: "working" };
    default:
      return { state };
  }
};

/**
 * A ledger row's state with the thread's live status and requests laid over it, by the server's
 * rule. The ledger is refetched a beat after the thread changes, so without this a card would sit
 * in the wrong column meanwhile: a request just raised moves it to waiting on a person at once,
 * and one just answered moves it back. Without `live` the row's own status and requests count,
 * which gives the row's own state back.
 */
export const liveWorkerState = (
  row: Pick<WorkerLedgerEntry, "state" | "stateBase" | "status" | "pendingRequests">,
  live?: WorkerLive,
): WorkerState =>
  withLive(
    row.stateBase ?? baseOfRow(row.state),
    live ?? { status: row.status, pendingRequestCount: row.pendingRequests.length },
  );

/**
 * Worker states from what holds a feature back most to what holds it back least: the states that
 * wait on somebody, then the road from brief to merge. `needsUser` comes before `blocked` and
 * `question`: a request blocks the agent outright and only the user can answer it, while a report
 * can be answered by the orchestrator. `delivered` sits just before `merged`: both are finished,
 * but only one of them is known to be in main, so a feature with a worker of each is `delivered`.
 * `archived` is last because a parked worker holds nothing back.
 */
export const WORKER_STATE_ORDER: ReadonlyArray<WorkerState> = [
  "error",
  "needsUser",
  "blocked",
  "question",
  "briefed",
  "working",
  "done",
  "inReview",
  "readyToMerge",
  "delivered",
  "merged",
  "archived",
];

/** A state this build doesn't know ranks first: nobody can say how far along it is. */
const rank = (state: WorkerState): number => WORKER_STATE_ORDER.indexOf(state);

/**
 * A feature's state: its least advanced worker's by `WORKER_STATE_ORDER`, so a feature is
 * `inReview` only when every sibling has a PR and `readyToMerge` only when every sibling is.
 * Archived workers don't count while any sibling is live. A feature whose workers are all
 * delivered, merged or archived is `delivered` if any of them is, and `merged` only when every one
 * that isn't archived truly is; one with nothing but archived workers (or none) is `archived`.
 * A group's state is its features' states folded the same way.
 */
export const featureState = (workers: ReadonlyArray<WorkerState>): WorkerState => {
  const live = workers.filter((state) => state !== "archived");
  return live.reduce<WorkerState>(
    (least, state) => (rank(state) < rank(least) ? state : least),
    live[0] ?? "archived",
  );
};
