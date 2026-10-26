import type {
  BudgetMeters,
  DigestChange,
  DigestVariant,
  Handoff,
  OrchestrationDigest,
  OrchestrationPause,
  PauseReason,
  Thread,
  ThreadStatus,
  WorkerLedgerEntry,
  WorkerPr,
  WorkerReportState,
  WorkerState,
} from "@gram/contracts";

import { prRefText } from "@/components/pr-marks-model";
import { dateTimeFormat } from "@/lib/intl";

// Pure derivations for the orchestration UI: the role a thread plays, and the words and tones the
// digest, worker report, memory write and handoff cards show. No React here, so it is all testable
// without a browser.

/** What a thread is to orchestration, from its durable fields. */
export type ThreadRoleInfo =
  | { readonly kind: "orchestrator" }
  | { readonly kind: "worker"; readonly feature: string }
  | { readonly kind: "dream" };

/** The role a thread plays, or `undefined` for a plain thread. A role outranks a `spawnedBy`. */
export const threadRoleOf = (
  thread: Pick<Thread, "role" | "spawnedBy">,
): ThreadRoleInfo | undefined => {
  if (thread.role !== undefined) return { kind: thread.role };
  if (thread.spawnedBy !== undefined) return { kind: "worker", feature: thread.spawnedBy.feature };
  return undefined;
};

/** The role in a few words, for a chip. */
export const roleLabel = (role: ThreadRoleInfo): string => {
  switch (role.kind) {
    case "orchestrator":
      return "Orchestrator";
    case "dream":
      return "Dream";
    case "worker":
      return `Worker · ${role.feature}`;
  }
};

/** The role as a sentence, for a tooltip and screen readers. */
export const roleDescription = (
  role: ThreadRoleInfo,
  orchestratorTitle?: string | undefined,
): string => {
  switch (role.kind) {
    case "orchestrator":
      return "Orchestrator: dispatches worker threads and is woken when they need attention";
    case "dream":
      return "Dream: a pass over an orchestrator's memory";
    case "worker":
      return orchestratorTitle === undefined
        ? `Worker for “${role.feature}”, spawned by an orchestrator`
        : `Worker for “${role.feature}”, spawned by “${orchestratorTitle}”`;
  }
};

/**
 * `table[word]`, or `undefined` for a word the table has no entry for. The tables in this file are
 * typed exhaustively over the contract's literals, so `tsc` fails until a new literal is given a
 * presentation; at run time the word is still whatever the server sent. A web build that had never
 * heard of `delivered` indexed its table with it, read `.tone` of `undefined`, and took the whole
 * app down to the root error boundary. Every lookup by a word from the wire goes through here.
 */
export const known = <V>(table: Readonly<Record<string, V>>, word: string): V | undefined =>
  Object.hasOwn(table, word) ? table[word] : undefined;

/** How a state reads: its words, and the tone the component draws an icon and a colour from. */
export interface StatePresentation {
  readonly label: string;
  readonly tone: StateTone;
}

/** A word this build doesn't know, shown as it came: neutral, and never a crash. */
const unknownState = (word: string): StatePresentation => ({ label: word, tone: "muted" });

const VARIANT_TITLE: Record<DigestVariant, string> = {
  boot: "Session start",
  digest: "Digest",
  away: "While you were away",
  checkpoint: "Checkpoint",
};

/** The digest card's heading: only a wake while the app ran is numbered. */
export const digestTitle = (digest: Pick<OrchestrationDigest, "variant" | "generation">): string =>
  digest.variant === "digest"
    ? `${VARIANT_TITLE.digest} #${digest.generation}`
    : (known(VARIANT_TITLE, digest.variant) ?? VARIANT_TITLE.digest);

/** How a state reads at a glance; the component maps each tone to a colour and an icon shape. */
export type StateTone = "muted" | "working" | "needs" | "success" | "delivered" | "danger";

const WORKER_STATE: Record<WorkerState, StatePresentation> = {
  briefed: { label: "Briefed", tone: "muted" },
  working: { label: "Working", tone: "working" },
  needsUser: { label: "Needs you", tone: "needs" },
  blocked: { label: "Blocked", tone: "danger" },
  question: { label: "Has a question", tone: "needs" },
  done: { label: "Done", tone: "success" },
  inReview: { label: "In review", tone: "working" },
  readyToMerge: { label: "Ready to merge", tone: "success" },
  // Its own tone, so its own icon: finished, but nothing says it is in main, and a check mark beside
  // "Merged" rows would say it was.
  delivered: { label: "Delivered", tone: "delivered" },
  merged: { label: "Merged", tone: "success" },
  error: { label: "Error", tone: "danger" },
  archived: { label: "Archived", tone: "muted" },
};

/** A worker state's label and tone; a state this build doesn't know reads as its own word. */
export const presentState = (state: string): StatePresentation =>
  known(WORKER_STATE, state) ?? unknownState(state);

const REPORT_STATE: Record<WorkerReportState, StatePresentation> = {
  progress: { label: "Progress", tone: "working" },
  blocked: { label: "Blocked", tone: "danger" },
  question: { label: "Question", tone: "needs" },
  done: { label: "Done", tone: "success" },
};

/** The same for what a worker reported. */
export const presentReportState = (state: string): StatePresentation =>
  known(REPORT_STATE, state) ?? unknownState(state);

/** A change as "from → to"; a worker the last digest didn't know has no "from". */
export const changeText = (change: Pick<DigestChange, "from" | "to">): string =>
  change.from === undefined
    ? `New → ${presentState(change.to).label}`
    : `${presentState(change.from).label} → ${presentState(change.to).label}`;

export const usd = (amount: number): string => `$${amount.toFixed(2)}`;

/**
 * Workers against the cap. The day's cost stays out: on a subscription it is a guess at a bill
 * nobody gets, and the title bar's meter shows the limits that do apply.
 */
export const budgetLine = (budget: BudgetMeters): string =>
  `Workers ${budget.liveWorkers}/${budget.maxConcurrentWorkers}`;

/** Whether every worker slot is taken, which is when the line is worth a warning tone. */
export const budgetSpent = (budget: BudgetMeters): boolean =>
  budget.liveWorkers >= budget.maxConcurrentWorkers;

/** `owner/repo#12` plus what the PR badge would say about it. */
export const prLabel = (pr: WorkerPr): string => {
  const facts = [pr.checks, pr.verdictOnHead, pr.mergeState].filter(
    (fact): fact is string => fact !== undefined,
  );
  return `${prRefText(pr)}${facts.length === 0 ? "" : ` (${facts.join(", ")})`}`;
};

/** The things about a worker the orchestrator should notice, in words. */
export const workerFlags = (
  worker: Pick<WorkerLedgerEntry, "userIntervened" | "overlapsWith" | "pendingRequests">,
): readonly string[] => [
  ...(worker.userIntervened ? ["held by you"] : []),
  ...(worker.overlapsWith.length === 0
    ? []
    : [
        `overlaps ${worker.overlapsWith.length} other ${worker.overlapsWith.length === 1 ? "worker" : "workers"}`,
      ]),
  ...worker.pendingRequests.map((request) => `waiting ${request.ageMin}m on ${request.kind}`),
];

const PAUSE_REASON: Record<PauseReason, string> = {
  user: "Paused by you",
  parked: "Paused while the orchestrator is parked",
  deliveryFailed: "Paused: a digest could not be delivered",
};

/** Why an orchestrator is paused, with the server's detail when it gave one. */
export const pauseText = (pause: Pick<OrchestrationPause, "reason" | "detail">): string => {
  const reason = known(PAUSE_REASON, pause.reason) ?? `Paused (${pause.reason})`;
  return pause.detail === undefined ? reason : `${reason} (${pause.detail})`;
};

/**
 * What a pause does to the workers, after `pauseText`'s sentence. The user's own pause stops them
 * too, each once it has finished the step it is on, and `working` of them are still at work: finishing a
 * command, or the user's own. Any other pause stops only the orchestrator.
 */
export const pauseLeavesRunning = (
  working: number,
  pause?: Pick<OrchestrationPause, "reason">,
): string => {
  if (pause?.reason === "user") {
    return working === 0
      ? "Its workers are stopped too. Resuming lets them go a few at a time."
      : `Its workers stop once they finish the step they're on (${working} still at work, finishing a step or with you). Resuming lets them go a few at a time.`;
  }
  return working === 0
    ? "Workers already running would keep going."
    : `Workers already running keep going (${working} now).`;
};

/** "14:02": when a pause began, on the 24-hour clock. */
export const pauseClock = (at: number): string =>
  dateTimeFormat([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);

/**
 * The confirm before pausing with work mid-flight: `working` workers and whether the orchestrator
 * is in a turn. `undefined` when nothing is, and the pause needs no confirm.
 */
export const pauseConfirmText = (working: number, orchestrator: boolean): string | undefined => {
  if (working === 0 && !orchestrator) return undefined;
  const who = [
    ...(orchestrator ? ["the orchestrator"] : []),
    ...(working === 0 ? [] : [working === 1 ? "1 worker" : `${working} workers`]),
  ].join(" and ");
  const what = `${who.charAt(0).toUpperCase()}${who.slice(1)} ${working + (orchestrator ? 1 : 0) === 1 ? "is" : "are"} mid-turn.`;
  return `${what} Pausing doesn't cut anything off: each finishes the step it is on, then stops. Workers you hold keep going with you.`;
};

/** Statuses of a thread in a turn: starting it, running it, or stopped in it on an ask. */
const IN_TURN: ReadonlySet<ThreadStatus> = new Set([
  "starting",
  "running",
  "needsApproval",
  "needsInput",
]);

/**
 * Whether a thread is mid-turn: the one test a pause's confirm counts by, a paused worker's row
 * marks "stopping" by and the briefing reads a turn by.
 */
export const inTurn = (status: ThreadStatus | undefined): boolean =>
  status !== undefined && IN_TURN.has(status);

/** How a worker stands in a workspace the user paused, as its row and banner say it. */
export type WorkerPause = "stopping" | "held" | "paused";

/** A worker's `WorkerPause` from its status and whether the user holds it. */
export const workerPauseOf = (status: ThreadStatus, held: boolean): WorkerPause =>
  held ? "held" : inTurn(status) ? "stopping" : "paused";

export const workerPauseHint = (pause: WorkerPause, at: number): string => {
  switch (pause) {
    case "stopping":
      return `Pausing since ${pauseClock(at)}… finishing the current step`;
    case "held":
      return `Paused since ${pauseClock(at)}, but yours: it keeps going with you, and nothing else reaches it`;
    case "paused":
      return `Paused with its workspace since ${pauseClock(at)}: it continues where it left off when you resume`;
  }
};

const HANDOFF_REASON: Record<Handoff["reason"], string> = {
  context: "context was filling up",
  compactions: "too many compactions",
  user: "you asked for one",
};

/** The handoff divider's words. */
export const handoffLabel = (handoff: Pick<Handoff, "reason">): string =>
  `New session · ${known(HANDOFF_REASON, handoff.reason) ?? handoff.reason}`;

/**
 * A worker-authored URL when it is safe to make a link of: `https` only, so a `javascript:` or
 * `file:` address a worker reported stays text.
 */
export const safeLink = (url: string | undefined): string | undefined => {
  if (url === undefined) return undefined;
  try {
    return new URL(url).protocol === "https:" ? url : undefined;
  } catch {
    // Not a URL at all: shown as the text the worker wrote.
    return undefined;
  }
};

/** A size in the unit a person would say it in. */
export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const [value, unit] =
    bytes < 1024 ** 2
      ? [bytes / 1024, "KB"]
      : bytes < 1024 ** 3
        ? [bytes / 1024 ** 2, "MB"]
        : [bytes / 1024 ** 3, "GB"];
  return `${value.toFixed(1)} ${unit}`;
};

/** One line of a before/after comparison. */
export interface DiffLine {
  readonly kind: "same" | "add" | "del";
  readonly text: string;
}

const linesOf = (text: string | undefined): readonly string[] =>
  text === undefined || text === "" ? [] : text.replace(/\n$/, "").split("\n");

/**
 * A line diff by longest common subsequence, deletions ahead of additions where they meet. Memory
 * files are capped at 32 KB, so the quadratic table stays small.
 */
export const lineDiff = (before: string | undefined, after: string | undefined): DiffLine[] => {
  const a = linesOf(before);
  const b = linesOf(after);
  const width = b.length + 1;
  // lcs[i * width + j] is the longest common subsequence of a[i..] and b[j..].
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      out.push({ kind: "del", text: a[i++]! });
    } else {
      out.push({ kind: "add", text: b[j++]! });
    }
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++]! });
  while (j < b.length) out.push({ kind: "add", text: b[j++]! });
  return out;
};

/** `+3 −1` for a diff, so the collapsed card still says how much changed. */
export const diffStat = (lines: readonly DiffLine[]): string => {
  const added = lines.filter((line) => line.kind === "add").length;
  const removed = lines.filter((line) => line.kind === "del").length;
  return `+${added} −${removed}`;
};
