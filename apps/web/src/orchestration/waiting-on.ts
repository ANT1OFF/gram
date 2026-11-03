import {
  DEFAULT_PR_WAKE_EVENTS,
  checksOf,
  wakeConditionLabel,
  wakeConditionWhen,
  type PendingWake,
  type PrRef,
  type PrWakeEvent,
  type RunWatch,
  type ThreadStatus,
  type WakeCondition,
  type WorkerLedgerEntry,
  type WorkerPr,
  type WorkerState,
} from "@gram/contracts";

import { formatWakeTime } from "@/lib/time";

import { wakeWhenText } from "./board-model";
import { openPrs, prWait, type WaitInput, type WorkerBusy } from "./wait-model";

// What a worker or an orchestrator at rest is waiting on, in one short label and a hover that
// lists every wait: the one model the sidebar's rows, the Board's chips and ⌘J's Workers list
// read, so the three say the same thing. Read from the ledger (PRs, wakes, watched runs, limit
// waits) and nothing else; no React, so it is tested without a browser. Waiting is calm: nothing
// here makes a worker need you, which only an ask, a failure or a person's wait does.

/**
 * Why it waits, one kind per wait. `frozen` is the base branch frozen for merges, which the merge
 * freeze will report; `condition` is a wake on a condition other than a time or a PR.
 */
export type WaitKind =
  | "limit"
  | "frozen"
  | "held"
  | "checks"
  | "review"
  | "merge"
  | "dependency"
  | "run"
  | "condition"
  | "timer";

export const WAIT_KINDS: readonly WaitKind[] = [
  "limit",
  "frozen",
  "held",
  "checks",
  "review",
  "merge",
  "dependency",
  "run",
  "condition",
  "timer",
];

export interface WaitReason {
  readonly kind: WaitKind;
  /** What the row says after its word: "checks on #69", "#102 to merge", "until 08:10". */
  readonly short: string;
  /** The hover's line for it, whole: "CI is running on #69 in acme/web." */
  readonly detail: string;
  /** Epoch ms it clears by, when that is known: a wake's time, a limit's reset. */
  readonly at?: number | undefined;
}

export interface WaitingOn {
  /** The kind of the wait the label names. */
  readonly kind: WaitKind;
  /** The row's line: "Waiting · checks on #69", "Paused · limit until 08:10". */
  readonly label: string;
  /** Every wait, the one the label names first. */
  readonly reasons: readonly WaitReason[];
  /** The hover: the label with "+N" for the others, then every wait's line. */
  readonly hint: string;
}

/**
 * Which wait the label names when several apply: what holds everything else first (a limit, a
 * frozen base, the user's hold), then what clears soonest by its nature (CI, the review bot, the
 * merge Gram makes), then the longer waits (another PR, a watched run, a condition), and a timed
 * wake last, as it is mostly the fallback beside the others. Within a kind, the soonest first.
 */
const RANK: Readonly<Record<WaitKind, number>> = Object.fromEntries(
  WAIT_KINDS.map((kind, i) => [kind, i]),
) as Record<WaitKind, number>;

/** The word a row's line starts with: a limit pauses it, the user holds it, the rest waits. */
const WORD: Readonly<Partial<Record<WaitKind, string>>> = { limit: "Paused", held: "Held" };

/** "Waiting · checks on #69": a wait as a row's line. */
export const waitLabel = (reason: Pick<WaitReason, "kind" | "short">): string =>
  `${WORD[reason.kind] ?? "Waiting"} · ${reason.short}`;

/** The reasons, the one the label names first, and the label and hover they make; none, nothing. */
export const waitingOf = (reasons: readonly WaitReason[]): WaitingOn | undefined => {
  const sorted = reasons.toSorted(
    (a, b) =>
      RANK[a.kind] - RANK[b.kind] ||
      (a.at ?? Number.MAX_SAFE_INTEGER) - (b.at ?? Number.MAX_SAFE_INTEGER),
  );
  const [first] = sorted;
  if (first === undefined) return undefined;
  const label = waitLabel(first);
  const more = sorted.length - 1;
  return {
    kind: first.kind,
    label,
    reasons: sorted,
    hint: [more > 0 ? `${label} · +${more}` : label, ...sorted.map((r) => r.detail)].join("\n"),
  };
};

/** How a time reads in a wait: `08:10` today, `Fri 08:10` on another day, on a 24-hour clock. */
export type WaitClock = (at: number) => string;

export const waitClock =
  (now: number, intl: { readonly timeZone?: string } = {}): WaitClock =>
  (at) =>
    formatWakeTime(at, now, intl);

/** "#102", or "acme/api#102" for one in another repo than `repo`. */
const prName = (pr: PrRef, repo?: string): string =>
  pr.repo === repo ? `#${pr.number}` : `${pr.repo}#${pr.number}`;

/** What a wake on another PR waits for, by the first event it names. */
const PR_EVENT_SHORT: Readonly<Record<PrWakeEvent, (name: string) => string>> = {
  merged: (name) => `${name} to merge`,
  closed: (name) => `${name} to close`,
  headChanged: (name) => `${name} to move`,
  checksSettled: (name) => `checks on ${name}`,
  verdict: (name) => `review on ${name}`,
};

/** How a wait names another thread: its title where the window has it. */
export type ThreadName = (threadId: string) => string | undefined;

/**
 * What a condition wake waits for, for a row: "main to move", "thread to finish" (the hover names
 * the thread). Any other kind reads as its chip does (`wakeConditionLabel`), so a kind added to
 * `WakeCondition` shows here without a change; give it a case only for words of its own.
 */
export const conditionShort = (condition: WakeCondition): string => {
  switch (condition.kind) {
    case "branchMoved":
      return `${condition.branch ?? condition.repo} to move`;
    case "threadFinished":
      return "thread to finish";
    default:
      // A kind this build's contracts don't know yet still says something.
      return wakeConditionLabel(condition) ?? (condition as { kind: string }).kind;
  }
};

/**
 * A pending wake as a wait: on a time, on a condition (a branch moving, a thread finishing), or on
 * another PR's events, the last two with its time as a fallback.
 */
export const wakeReason = (
  wake: Pick<PendingWake, "at" | "note" | "onPr" | "on" | "condition">,
  clock: WaitClock,
  name: ThreadName = () => undefined,
): WaitReason => {
  const note = wake.note === "" ? "" : `: ${wake.note}`;
  if (wake.condition !== undefined) {
    const named =
      wake.condition.kind === "threadFinished" ? name(wake.condition.threadId) : undefined;
    return {
      kind: "condition",
      short: conditionShort(wake.condition),
      detail: `Wakes when ${wakeConditionWhen(wake.condition, named)}, else at ${clock(wake.at)}${note}`,
      at: wake.at,
    };
  }
  const detail = `${wakeWhenText(wake, clock)}${note}`;
  if (wake.onPr !== undefined) {
    const [event = "merged"] = wake.on ?? DEFAULT_PR_WAKE_EVENTS;
    return {
      kind: "dependency",
      short: PR_EVENT_SHORT[event](`#${wake.onPr.number}`),
      detail,
      at: wake.at,
    };
  }
  return { kind: "timer", short: `until ${clock(wake.at)}`, detail, at: wake.at };
};

/** A watched workflow run as a wait. */
export const runReason = (run: Pick<RunWatch, "repo" | "runId" | "name">): WaitReason => ({
  kind: "run",
  short: run.name === undefined ? `run ${run.runId}` : `${run.name} run`,
  detail: `Watching ${run.name === undefined ? "workflow run" : `the ${run.name} run,`} ${run.runId} in ${run.repo}.`,
});

/** A provider limit a thread waits out (`Thread.limitWait`, as the ledger carries it). */
export interface LimitWaitFacts {
  readonly kind: "limit" | "backoff";
  /** Epoch ms it resumes on its own. */
  readonly resumeAt: number;
}

/** A provider limit waited out, which resumes the thread on its own. */
export const limitReason = (wait: LimitWaitFacts, now: number, clock: WaitClock): WaitReason => {
  const what = wait.kind === "limit" ? "usage limit" : "rate limit";
  // "limit until 08:10", "retry at 07:05": short enough that a narrow row keeps the time.
  const due = now < wait.resumeAt;
  const short =
    wait.kind === "limit"
      ? due
        ? `limit until ${clock(wait.resumeAt)}`
        : "limit, resuming"
      : due
        ? `retry at ${clock(wait.resumeAt)}`
        : "retry, resuming";
  return {
    kind: "limit",
    short,
    detail: due
      ? `Waits out a ${what}; resumes on its own at ${clock(wait.resumeAt)}.`
      : `The ${what} has reset; it resumes once its turn can start.`,
    at: wait.resumeAt,
  };
};

/** What one open PR of a worker's waits on that moves by itself. */
const prReasons = (pr: WorkerPr): WaitReason[] => {
  const name = `#${pr.number}`;
  const where = `${name} in ${pr.repo}`;
  const reasons: WaitReason[] = [];
  const intent = pr.mergeWhenReady;
  if (intent?.hold !== undefined && intent.holdWaitsOn === "agent") {
    reasons.push({ kind: "merge", short: `${name} held`, detail: prWait(pr).detail ?? where });
  }
  for (const dependency of pr.dependsOn ?? []) {
    if (dependency.mergeAfter === false || dependency.state === "merged") continue;
    const other = prName(dependency, pr.repo);
    reasons.push({
      kind: "dependency",
      short: `${other} to merge`,
      detail: `${where} waits for ${prName(dependency)} to merge${dependency.state === undefined ? "" : ` (${dependency.state})`}.`,
    });
  }
  if (pr.localCheck?.status === "running") {
    reasons.push({
      kind: "checks",
      short: `local check ${name}`,
      detail: `Gram's local check runs on ${where}.`,
    });
  }
  const checks = checksOf(pr.checks);
  if (checks === "pending") {
    reasons.push({
      kind: "checks",
      short: `checks on ${name}`,
      detail: `CI is running on ${where}.`,
    });
  }
  const botDone =
    pr.reviewUnread === true || pr.verdictOnHead !== undefined || pr.botOnHead === "reviewed";
  if (!botDone && pr.botOnHead === "reviewing") {
    reasons.push({
      kind: "review",
      short: `review on ${name}`,
      detail: `The review bot is reviewing the head of ${where}.`,
    });
  }
  const mergeable =
    pr.mergeState === "CLEAN" || pr.mergeState === "UNSTABLE" || pr.mergeState === undefined;
  if (
    intent !== undefined &&
    intent.hold === undefined &&
    intent.refused !== true &&
    checks !== "failing" &&
    mergeable
  ) {
    const after = (intent.after ?? []).map((each) => prName(each)).join(", ");
    reasons.push({
      kind: "merge",
      short: `merge of ${name}`,
      detail:
        intent.waiting ??
        `Gram merges ${where} once it is ready${after === "" ? "" : `, after ${after}`}.`,
    });
  }
  // Watched with nothing above: what GitHub last said of it, which the monitor waits on.
  if (reasons.length === 0 && pr.monitored === true) {
    const wait = prWait(pr);
    reasons.push({
      kind: wait.tag === "bot: changes" ? "review" : "checks",
      short: `${name} ${wait.tag ?? "watched"}`,
      detail: `A monitor watches ${where}. ${wait.detail ?? ""}`.trim(),
    });
  }
  return reasons;
};

/** What a worker's waits read: its ledger row's, with the live state and status laid over. */
export type WorkerWaitingInput = WaitInput & Partial<Pick<WorkerLedgerEntry, "limitWait">>;

/**
 * What a worker at rest is waiting on (`waitingOf`), given what it does (`workerActivity`): a limit
 * it waits out, the user's hold, or, while it waits on automation, each wait that moves it on by
 * itself (its PRs' CI, review bot, merge and dependencies; its wakes and watched runs). Nothing for
 * one at work, one that needs somebody, finished work, or one at rest with nothing to wait for.
 */
export const workerWaitingOn = (
  worker: WorkerWaitingInput,
  busy: WorkerBusy,
  now: number,
  {
    state = worker.state,
    status = worker.status,
    clock = waitClock(now),
    name = () => undefined,
  }: { state?: WorkerState; status?: ThreadStatus; clock?: WaitClock; name?: ThreadName } = {},
): WaitingOn | undefined => {
  if (status === "running" || status === "starting") return undefined;
  if (busy.activity === "idle" && busy.reason === "you hold it") {
    return waitingOf([
      {
        kind: "held",
        short: "by you",
        detail: "You are directing this worker; hand it back when ready.",
      },
    ]);
  }
  if (busy.activity !== "automation") return undefined;
  return waitingOf([
    ...(worker.limitWait === undefined ? [] : [limitReason(worker.limitWait, now, clock)]),
    ...openPrs(worker, state).flatMap(prReasons),
    ...(worker.runWatches ?? []).map(runReason),
    ...(worker.wakes ?? []).map((wake) => wakeReason(wake, clock, name)),
  ]);
};

/** What an orchestrator's waits read: its ledger's wakes and its own thread's status and limit. */
export interface OrchestratorWaitingInput {
  readonly status: ThreadStatus | undefined;
  readonly wakes?: readonly PendingWake[] | undefined;
  readonly limitWait?: LimitWaitFacts | undefined;
}

/**
 * What an orchestrator at rest is waiting on: a limit it waits out, and the wakes it set itself.
 * Nothing while it works or asks: its line and the ask stack say those.
 */
export const orchestratorWaitingOn = (
  { status, wakes = [], limitWait }: OrchestratorWaitingInput,
  now: number,
  clock: WaitClock = waitClock(now),
  name: ThreadName = () => undefined,
): WaitingOn | undefined => {
  if (status !== "idle" && status !== "cold" && status !== undefined) return undefined;
  return waitingOf([
    ...(limitWait === undefined ? [] : [limitReason(limitWait, now, clock)]),
    ...wakes.map((wake) => wakeReason(wake, clock, name)),
  ]);
};
