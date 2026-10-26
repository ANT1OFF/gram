import {
  checksOf,
  workerOwnsCiFix,
  ciFixPrKey,
  type PrReviewRequest,
  type ThreadStatus,
  type WorkerLedgerEntry,
  type WorkerPr,
  type WorkerState,
} from "@gram/contracts";

import { prRefText } from "@/components/pr-marks-model";

// What each worker waits on, for the sidebar's per-state counts and the board's columns alike, so
// the two always agree. Pure, so it is tested without a browser.

/**
 * Where a worker stands for the user: running now, waiting on something that moves on by itself
 * (CI, the review bot, a merge Gram will make), waiting on a person, or finished.
 */
export type WaitBucket = "working" | "checks" | "person" | "done";

export const WAIT_BUCKETS: readonly WaitBucket[] = ["working", "checks", "person", "done"];

/** What the counts and the board's headings call each bucket. */
export const WAIT_LABELS: Readonly<Record<WaitBucket, string>> = {
  working: "Working",
  checks: "Waiting on checks",
  person: "Waiting on a person",
  done: "Done",
};

export interface WorkerWait {
  readonly bucket: WaitBucket;
  /** A card's tag, a few words: "CI running", "@platform review", "you: merge". */
  readonly tag?: string | undefined;
  /** The tag said whole, for its tooltip. */
  readonly detail?: string | undefined;
}

/** The ledger's fields a wait is read from. */
export type WaitInput = Pick<
  WorkerLedgerEntry,
  | "state"
  | "status"
  | "pendingRequests"
  | "pr"
  | "morePrs"
  | "alsoIn"
  | "reportStands"
  | "lastReport"
  | "wakes"
  | "runWatches"
> &
  Partial<Pick<WorkerLedgerEntry, "userIntervened" | "quiet">>;

const REQUEST_TAGS: Readonly<Record<string, string>> = {
  approval: "you: approve",
  question: "you: answer",
  plan: "you: plan",
};

/** A reviewer as a tag names them: `@login`, or `@slug` for a team, its org dropped. */
export const reviewerName = (request: PrReviewRequest): string =>
  `@${request.kind === "team" ? request.name.slice(request.name.indexOf("/") + 1) : request.name}`;

/** The tag of a worker the user holds: theirs to move, by choice. */
const HELD = "you: worker";

const person = (tag: string, detail: string): WorkerWait => ({ bucket: "person", tag, detail });
const checks = (tag: string, detail: string): WorkerWait => ({ bucket: "checks", tag, detail });

/**
 * "#12 in acme/web": which PR a detail is about, for a worker with more than one. A sentence's own
 * form, where the PR's ref (`prRefText`) names the PRs it waits on.
 */
const prName = (pr: WorkerPr): string => `#${pr.number} in ${pr.repo}`;

/**
 * What one open PR waits on. CI first, then the review bot on its head, then what GitHub says
 * stands between it and a merge. A person is named where GitHub says who: the code owners asked
 * first, then whoever else is asked to review, then whoever asked for changes.
 */
export const prWait = (pr: WorkerPr): WorkerWait => {
  const name = prName(pr);
  const dependencies = (pr.dependsOn ?? []).filter(
    (dependency) => dependency.mergeAfter !== false && dependency.state !== "merged",
  );
  if (pr.mergeWhenReady?.hold !== undefined) {
    const intent = pr.mergeWhenReady;
    const owner =
      intent.heldBy === "orchestrator"
        ? " by its orchestrator"
        : intent.heldBy === "thread"
          ? " by its worker"
          : "";
    return (intent.holdWaitsOn === "agent" ? checks : person)(
      "held",
      `${name} is held${owner}: ${intent.hold}`,
    );
  }
  if (dependencies.length > 0)
    return checks(
      "dependency",
      `${name} waits on ${dependencies.map((dependency) => `${prRefText(dependency)}${dependency.state ? ` (${dependency.state})` : " (state unknown)"}`).join(", ")}.`,
    );
  if (pr.mergeState === "DIRTY")
    return checks("conflicts", `${name} conflicts with its base; the worker needs to resolve it.`);
  const required = checksOf(pr.checks);
  if (required === "pending")
    return checks("CI pending", `CI is pending on ${name}; wait for checks to settle.`);
  if (required === "failing") {
    return checks("CI failing", `Worker: inspect and fix failed checks on ${name}.`);
  }
  const botDone =
    pr.reviewUnread === true || pr.verdictOnHead !== undefined || pr.botOnHead === "reviewed";
  if (!botDone && pr.botOnHead === "reviewing")
    return checks("bot reviewing", `The review bot is reviewing the head of ${name}.`);
  if (pr.verdictOnHead === "changesRequested") {
    return checks("bot: changes", `Worker: address the review bot's findings on ${name}.`);
  }

  if (pr.mergeState === "BEHIND") return checks("behind base", `${name} is behind its base.`);
  if (pr.mergeState === "DRAFT") return checks("draft", `${name} is still a draft.`);
  const requests = pr.reviewRequests ?? [];
  const owners = requests.filter((request) => request.codeOwner === true);
  const asked = owners.length > 0 ? owners : requests;
  const names = asked.map(reviewerName);
  const who = names.length === 0 ? undefined : names.join(", ");
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    const by = (pr.changesRequestedBy ?? []).map((login) => `@${login}`).join(", ");
    return by === ""
      ? person("changes requested", `A reviewer asked for changes on ${name}.`)
      : person(`${by}: changes`, `${by} asked for changes on ${name}.`);
  }
  if (pr.reviewDecision === "REVIEW_REQUIRED") {
    if (who === undefined) {
      return person("review required", `${name} needs an approving review from a person.`);
    }
    return person(
      `${who} review`,
      owners.length > 0
        ? `${name} waits on a code-owner review from ${who}.`
        : `${name} waits on a review from ${who}.`,
    );
  }
  if (pr.mergeState === "CLEAN" || pr.mergeState === "UNSTABLE" || pr.mergeState === "HAS_HOOKS") {
    const intent = pr.mergeWhenReady;
    if (intent === undefined)
      return person(
        "merge decision",
        `No Gram merge intent is recorded for ${name}; its owner decides the next step under existing authorization.`,
      );
    if (intent.refused === true) {
      return person(
        "merge refused",
        `GitHub refused Gram's merge of this head of ${name}; it tries again once the head moves.`,
      );
    }
    if (pr.mergeState === "HAS_HOOKS") {
      return person("you: merge", `GitHub's merge hooks keep Gram from merging ${name}.`);
    }
    return checks(
      "merge armed",
      `Gram is checking its merge policy for ${name}; the merge intent is armed.`,
    );
  }
  if (pr.mergeState === "BLOCKED") {
    return who === undefined
      ? checks(
          "merge blocked",
          `GitHub reports ${name} blocked; inspect its rules and status for the recorded reason.`,
        )
      : person(`${who} review`, `GitHub won't merge ${name} until ${who} reviews it.`);
  }
  return checks("checking", `GitHub hasn't said yet whether ${name} can merge.`);
};

const RANK: Readonly<Record<WaitBucket, number>> = { person: 0, checks: 1, working: 2, done: 3 };

/** Its PRs still open, its own repo's and every other's. */
const openPrs = (worker: WaitInput, state: WorkerState): WorkerPr[] =>
  [
    worker.pr,
    ...(worker.morePrs ?? []),
    ...(worker.alsoIn ?? []).flatMap((repo) => [repo.pr, ...(repo.morePrs ?? [])]),
  ].filter(
    (pr): pr is WorkerPr =>
      pr !== undefined &&
      (pr.state === "open" ||
        // A PR identity on a settled worker does not establish an active wait.
        (pr.state === undefined && state !== "merged" && state !== "delivered")),
  );

/**
 * What a worker waits on. `state` and `status` are the board's live ones where it has them. Most
 * specific first: a live request waits on the user; archived, merged and delivered work is done; a
 * running agent is working, whatever else holds; an error, or a blocked or question report nobody
 * has answered, waits on a person; and a worker with open PRs waits on what its slowest PR does, a
 * person over checks. Monitors supplement an open PR's reason; without an open PR, they keep
 * delivered/merged work pending. A report of done with no wait is done; otherwise it is working.
 */
export const workerWait = (
  worker: WaitInput,
  state: WorkerState = worker.state,
  status: ThreadStatus = worker.status,
  ownedCi: ReadonlySet<string> = new Set(),
): WorkerWait => {
  const kind =
    status === "needsApproval"
      ? "approval"
      : status === "needsInput"
        ? "question"
        : worker.pendingRequests[0]?.kind;
  if (
    state === "needsUser" ||
    status === "needsApproval" ||
    status === "needsInput" ||
    (status !== "running" && status !== "starting" && worker.pendingRequests.length > 0)
  ) {
    return person(REQUEST_TAGS[kind ?? ""] ?? "you", "It waits on you to answer a request.");
  }
  if (status === "running" || status === "starting") return { bucket: "working" };
  if (state === "archived") {
    const failure = openPrs(worker, state).find(
      (pr) => checksOf(pr.checks) === "failing" && !ownedCi.has(ciFixPrKey(pr)),
    );
    return failure === undefined
      ? { bucket: "done", tag: "archived" }
      : person("CI failing", `${prName(failure)} has no live worker to fix failed checks.`);
  }

  if (state === "error") return person("stopped", "It stopped on an error.");
  if (state === "blocked" || state === "question" || worker.reportStands === true) {
    const reported =
      worker.lastReport?.state === "question" || state === "question" ? "question" : "blocked";
    return person(
      reported,
      `It reported ${reported === "question" ? "a question" : "being blocked"}.`,
    );
  }
  if (worker.userIntervened)
    return person(HELD, "You are directing this worker; hand it back when ready.");
  const monitoring = [
    ...((worker.runWatches?.length ?? 0) === 0
      ? []
      : [
          `Monitored workflow runs: ${worker.runWatches!.map((run) => `${run.repo} run ${run.runId}${run.name ? ` (${run.name})` : ""}`).join(", ")}.`,
        ]),
    ...((worker.wakes?.length ?? 0) === 0
      ? []
      : ["This worker has a scheduled wake; open its thread for the recorded next step."]),
  ];
  const prs = openPrs(worker, state);
  if (prs.length > 0) {
    const primary = prs
      .map((pr) =>
        checksOf(pr.checks) === "failing" &&
        !ownedCi.has(ciFixPrKey(pr)) &&
        !workerOwnsCiFix({ ...worker, state, status }, pr)
          ? person("CI failing", `Nobody is following up failed checks on ${prName(pr)}.`)
          : prWait(pr),
      )
      .reduce((a, b) => (RANK[b.bucket] < RANK[a.bucket] ? b : a));
    return monitoring.length === 0
      ? primary
      : { ...primary, detail: [primary.detail, ...monitoring].join(" ") };
  }
  if (monitoring.length > 0)
    return checks(
      (worker.runWatches?.length ?? 0) > 0 ? "run monitored" : "wake scheduled",
      monitoring.join(" "),
    );
  if (state === "merged") return { bucket: "done", tag: "merged" };
  if (state === "delivered") return { bucket: "done", tag: "delivered" };
  if (state === "done") return { bucket: "done", tag: "reported done" };
  if (state === "inReview" || state === "readyToMerge") {
    return checks("looking up", "Its PR hasn't been looked up yet.");
  }
  return { bucket: "working" };
};

/**
 * How busy a worker is, the one answer Quiet, the sidebar's worker rows and the Board give: a live
 * turn; waiting on automation that moves it on by itself (CI, a check or review monitor, a wake, a
 * dependency PR, a local check); stopped where something has to act (a person, or the worker with
 * nothing armed to bring it back); at rest with nothing to wait for; or finished.
 */
export type WorkerActivity = "working" | "automation" | "attention" | "idle" | "done";

export interface WorkerBusy {
  readonly activity: WorkerActivity;
  /** A few words on what it waits on or needs, from its wait: "CI pending", "conflicts". */
  readonly reason?: string | undefined;
}

/** Working and waiting on automation are busy; the rest is not. */
export const isBusy = (activity: WorkerActivity): boolean =>
  activity === "working" || activity === "automation";

/** The ledger's fields the activity reads beside the wait's. */
export type ActivityInput = WaitInput &
  Partial<Pick<WorkerLedgerEntry, "waitingOnAutomation" | "compacting">>;

/** Waits only the worker itself can move on: an armed wake or run brings it back, nothing else. */
const WORKER_ACTS = new Set(["conflicts", "CI failing", "bot: changes"]);

/** Waits that are automation at work by what they are. */
const AUTOMATED = new Set([
  "CI pending",
  "bot reviewing",
  "dependency",
  "merge armed",
  "checking",
  "looking up",
  "run monitored",
  "wake scheduled",
]);

/**
 * What a worker is doing, read from its wait (`workerWait`) and what it has armed. A live turn or a
 * compaction is working. Finished work is done, and a wait on a person needs attention, except one
 * the user holds, which is theirs by choice and idle. A wait on
 * checks is automation while something moves it on: pending CI, the review bot, a dependency, a
 * running local check, a monitor, a wake, a watched run or an armed merge. Conflicts, failing checks
 * and the bot's findings move on only when the worker acts, so they need attention unless a wake or
 * watched run will bring it back. At rest with nothing armed and nothing to wait on, it is idle.
 */
export const workerActivity = (
  worker: ActivityInput,
  state: WorkerState = worker.state,
  status: ThreadStatus = worker.status,
  ownedCi: ReadonlySet<string> = new Set(),
): WorkerBusy => {
  const wait = workerWait(worker, state, status, ownedCi);
  // One the user holds (a message, a paused feature) waits on them by choice: not stalled.
  if (wait.bucket === "person" && wait.tag === HELD)
    return { activity: "idle", reason: "you hold it" };
  if (wait.bucket === "person") return { activity: "attention", reason: wait.tag };
  if (status === "running" || status === "starting" || worker.compacting === true)
    return { activity: "working" };
  if (wait.bucket === "done") return { activity: "done", reason: wait.tag };
  const wakes = (worker.wakes?.length ?? 0) > 0;
  const runs = (worker.runWatches?.length ?? 0) > 0;
  const prs = openPrs(worker, state);
  const localCheck = prs.some((pr) => pr.localCheck?.status === "running");
  const armed =
    wakes ||
    runs ||
    localCheck ||
    worker.waitingOnAutomation === true ||
    prs.some((pr) => pr.monitored === true || pr.mergeWhenReady !== undefined);
  if (wait.bucket === "checks") {
    const tag = wait.tag;
    if (tag !== undefined && WORKER_ACTS.has(tag))
      return wakes || runs || localCheck
        ? { activity: "automation", reason: localCheck ? "local check" : tag }
        : { activity: "attention", reason: tag };
    if (localCheck) return { activity: "automation", reason: "local check" };
    if ((tag !== undefined && AUTOMATED.has(tag)) || armed)
      return { activity: "automation", reason: tag };
    return { activity: "attention", reason: tag };
  }
  if (armed)
    return { activity: "automation", reason: localCheck ? "local check" : "monitor armed" };
  return { activity: "idle" };
};
