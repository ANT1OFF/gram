import * as Schema from "effect/Schema";
import {
  anyPrOpen,
  mergedAndDone,
  prFactsOf,
  reopenedSinceMerge,
  threadPrBadges,
} from "./completion.ts";
import {
  approvalSubject,
  type PendingRequest,
  type PlanItem,
  type SidebarGroup,
  type Thread,
  type ThreadStatus,
} from "./domain.ts";
import { requiredChecksOf, type GitState, type PrStatus } from "./git.ts";
import { nextStep, openStep, planText, type PlanStep, type ThreadPlan } from "./thread-plan.ts";

/**
 * The one line a thread's row and header say about where it stands. It is
 * computed here from facts, the plan and the thread's status, by the first rule of a fixed table
 * that matches; no model ever writes it. That is what lets it replace the merged glyph: "Waiting on
 * review · #235" comes from GitHub, and a helper's wording only ever reaches it as a step's text.
 */

export const PlanPhase = Schema.Literals([
  "needsYou",
  "working",
  "waitingReview",
  "waitingCi",
  "readyToMerge",
  "followUp",
  "next",
  "done",
  "stale",
]);
export type PlanPhase = typeof PlanPhase.Type;

export const PlanHeadline = Schema.Struct({
  phase: PlanPhase,
  /** "Waiting on review · #235", "Approve: git push origin fix/flaky-retry". */
  text: Schema.String,
  /** The PR the text names. */
  pr: Schema.optionalKey(Schema.Int),
  /** That PR's URL, which names its repository: numbers are local to one. */
  prUrl: Schema.optionalKey(Schema.String),
  /** Steps done out of those that count, from the plan or else the agent's todo list; 0 of 0 without either. */
  done: Schema.Int,
  total: Schema.Int,
});
export type PlanHeadline = typeof PlanHeadline.Type;

/** How long a thread rests before its headline says so instead of what's next. */
export const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What the headline is computed from; a `ThreadSummary` plus the clock and what stopped it. */
export interface HeadlineFacts {
  readonly thread: Pick<
    Thread,
    | "boundPr"
    | "extraPrs"
    | "completedAt"
    | "completedReason"
    | "settledMerge"
    | "lastActivityAt"
    | "role"
  >;
  readonly status: ThreadStatus;
  readonly pendingRequests: ReadonlyArray<PendingRequest>;
  readonly git?: Pick<GitState, "pr" | "extraPrs" | "missingPrs"> | undefined;
  readonly plan?: ThreadPlan | undefined;
  /** The agent's todo list, which stands in for the plan's steps while the plan has none. */
  readonly turnPlan?: ReadonlyArray<PlanItem> | undefined;
  /** The live activity line ("Running pnpm test…"). */
  readonly activity?: string | undefined;
  /** What stopped the thread, in a few words, when the status is `error`. */
  readonly error?: string | undefined;
  readonly now: number;
}

const TODO_STATUS: Record<PlanItem["status"], PlanStep["status"]> = {
  pending: "todo",
  inProgress: "doing",
  completed: "done",
  cancelled: "dropped",
};

interface Step {
  readonly text: string;
  readonly status: PlanStep["status"];
}

/** The steps the headline counts: the plan's, or the agent's todo list while the plan has none. */
const stepsOf = (facts: HeadlineFacts): { steps: ReadonlyArray<Step>; next: Step | undefined } => {
  const plan = facts.plan;
  if (plan !== undefined && plan.steps.length > 0)
    return { steps: plan.steps, next: nextStep(plan) };
  const steps = (facts.turnPlan ?? []).map((item): Step => ({
    text: item.status === "inProgress" ? (item.activeForm ?? item.content) : item.content,
    status: TODO_STATUS[item.status],
  }));
  return {
    steps,
    next: steps.find((s) => s.status === "doing") ?? steps.find(openStep),
  };
};

/** "Review the plan: 5 steps", counting the plan's top-level list items. */
const planSteps = (markdown: string): number => {
  const items = markdown.split("\n").flatMap((line) => {
    const match = /^(\s*)(?:\d+[.)]|[-*+])\s+\S/u.exec(line);
    return match === null ? [] : [match[1]!.length];
  });
  if (items.length === 0) return 0;
  const top = Math.min(...items);
  return items.filter((indent) => indent === top).length;
};

const firstLine = (text: string): string => planText(text.split("\n").find((l) => l.trim()) ?? "");

/** Rules 1–4: a request waiting on the user, or a stop. */
const needsYouText = (facts: HeadlineFacts): string | undefined => {
  const approval = facts.pendingRequests.find((r) => r.kind === "approval");
  if (approval !== undefined) {
    const subject = approval.toolName.startsWith("mcp__")
      ? approval.displayName
      : firstLine(approvalSubject(approval));
    return `Approve: ${subject === "" ? approval.displayName : subject}`;
  }
  const question = facts.pendingRequests.find((r) => r.kind === "question");
  if (question !== undefined) {
    const asked = firstLine(question.questions[0]?.question ?? "");
    return asked === "" ? "Question for you" : `Question: ${asked}`;
  }
  const plan = facts.pendingRequests.find((r) => r.kind === "plan");
  if (plan !== undefined) {
    const n = planSteps(plan.plan);
    return n === 0 ? "Review the plan" : `Review the plan: ${n} ${n === 1 ? "step" : "steps"}`;
  }
  if (facts.status === "error") {
    return facts.error === undefined
      ? "Stopped with an error"
      : `Stopped: ${firstLine(facts.error)}`;
  }
  return undefined;
};

/** Rule 5: what on an open PR needs the user, with who asked for changes. */
const prTrouble = (pr: PrStatus): string | undefined => {
  if (requiredChecksOf(pr) === "failing") return `CI failing on #${pr.number}`;
  const person = pr.review?.humanReviews?.findLast((r) => r.verdict === "changesRequested");
  if (person !== undefined) return `Changes requested on #${pr.number} · ${person.author}`;
  if (pr.review?.verdictOnHead === "changesRequested") {
    const bot = pr.review.bots[0];
    return `Changes requested on #${pr.number}${bot === undefined ? "" : ` · ${bot}`}`;
  }
  if (pr.reviewDecision === "CHANGES_REQUESTED") return `Changes requested on #${pr.number}`;
  return undefined;
};

/** Rules 7–9, and a draft: what an open PR waits on, the AI reviewer told apart from people. */
const waitingOn = (pr: PrStatus): { phase: PlanPhase; text: string } => {
  const facts = prFactsOf(pr);
  if (pr.isDraft) return { phase: "next", text: `Draft · #${pr.number}` };
  const approved = facts.approvedOnHead || pr.reviewDecision === "APPROVED";
  if (facts.checksGreen && facts.mergeable && approved) {
    return { phase: "readyToMerge", text: `Ready to merge · #${pr.number}` };
  }
  if (requiredChecksOf(pr) === "pending") {
    return { phase: "waitingCi", text: `Waiting on CI · #${pr.number}` };
  }
  // The AI reviewer, not a person: its round is minutes away, theirs may be days.
  if (pr.review?.roundInFlight === true) {
    return { phase: "waitingReview", text: `AI review running · #${pr.number}` };
  }
  return { phase: "waitingReview", text: `Waiting on review · #${pr.number}` };
};

const daysIdle = (facts: HeadlineFacts): number =>
  Math.floor((facts.now - facts.thread.lastActivityAt) / DAY_MS);

/**
 * The headline by the first matching rule of a fixed table, or `undefined` for a
 * thread with nothing to say: at rest, with no plan, no PR and nothing done. An orchestrator has
 * none; its board is its plan.
 */
export const planHeadline = (facts: HeadlineFacts): PlanHeadline | undefined => {
  if (facts.thread.role === "orchestrator") return undefined;
  const { steps, next } = stepsOf(facts);
  const counted = steps.filter((s) => s.status !== "dropped");
  const done = counted.filter((s) => s.status === "done").length;
  const total = counted.length;
  const of = (
    phase: PlanPhase,
    text: string,
    pr?: Pick<PrStatus, "number" | "url">,
  ): PlanHeadline => ({
    phase,
    text,
    ...(pr === undefined ? {} : { pr: pr.number, prUrl: pr.url }),
    done,
    total,
  });

  const needs = needsYouText(facts);
  if (needs !== undefined) return of("needsYou", needs);

  const badges = threadPrBadges(facts.thread, facts.git);
  const open = badges.filter((b): b is PrStatus => b !== undefined && b.state === "OPEN");
  for (const pr of open) {
    const trouble = prTrouble(pr);
    if (trouble !== undefined) return of("needsYou", trouble, pr);
  }

  if (facts.status === "running" || facts.status === "starting") {
    const doing = counted.findIndex((s) => s.status === "doing");
    const current = facts.activity ?? (doing === -1 ? undefined : counted[doing]!.text);
    if (total === 0) return of("working", current ?? "Working");
    const i = doing === -1 ? Math.min(done + 1, total) : doing + 1;
    return of("working", `Step ${i} of ${total}${current === undefined ? "" : ` · ${current}`}`);
  }

  const [waiting] = open;
  if (waiting !== undefined) {
    const { phase, text } = waitingOn(waiting);
    return of(phase, text, waiting);
  }
  // Bound, but its badge hasn't been looked up yet.
  if (anyPrOpen(badges)) return of("waitingReview", "Waiting on review");

  const merged = badges.find((b) => b?.state === "MERGED");
  const finished =
    total > 0
      ? next === undefined
      : mergedAndDone(facts.thread, badges) ||
        facts.thread.completedReason === "agent" ||
        facts.thread.completedReason === "user";
  if (finished) {
    return merged === undefined
      ? of("done", "Done")
      : of("done", `Done · #${merged.number} merged`, merged);
  }

  const idle = daysIdle(facts);
  if (facts.now - facts.thread.lastActivityAt >= STALE_AFTER_MS) {
    const days = `Idle ${idle} ${idle === 1 ? "day" : "days"}`;
    return of("stale", total === 0 ? days : `${days} · ${done} of ${total}`);
  }

  if (next !== undefined) {
    const step = planText(next.text);
    return merged === undefined
      ? of("next", `Next: ${step}`)
      : of("followUp", `Follow-up after #${merged.number} · ${step}`, merged);
  }
  // Work went on after the merge, with no plan to say what it is.
  if (merged !== undefined && reopenedSinceMerge(facts.thread, badges)) {
    return of("followUp", `Follow-up after #${merged.number}`, merged);
  }
  return undefined;
};

/** Phases whose thread waits on a pull request: the In review lane. */
export const REVIEW_PHASES: ReadonlySet<PlanPhase> = new Set([
  "waitingReview",
  "waitingCi",
  "readyToMerge",
]);

/**
 * The sidebar group once the thread has a headline: a thread at rest is settled when its
 * phase is `done` or the agent or user marked it complete, and idle otherwise, so a merge with work
 * left over no longer settles it. Needs you and working are the status's, as without a headline; a
 * failing PR at rest stays idle, and lifting it to Needs you until seen is the web's attention rule.
 */
export const headlineGroup = (
  group: SidebarGroup,
  headline: Pick<PlanHeadline, "phase"> | undefined,
  completedReason: Thread["completedReason"],
): SidebarGroup => {
  if (headline === undefined || (group !== "idle" && group !== "settled")) return group;
  const marked = completedReason === "agent" || completedReason === "user";
  return headline.phase === "done" || marked ? "settled" : "idle";
};
