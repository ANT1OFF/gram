import {
  STUCK_AFTER_MS,
  stuckDue,
  type StuckFacts,
  type Thread,
  type ThreadStatus,
  type WorkerLedgerEntry,
} from "@gram/contracts";

// "Why is it stuck?" on a worker that hasn't moved for `STUCK_AFTER_MS` (45 minutes): when it
// applies, how long it has sat, the facts the view shows without a helper, and the nudges the user
// picks from. Pure and deterministic; the nudges only fill a composer.

/** States past the end of the road, and statuses that are an ask the request card already shows. */
const FINISHED = new Set<WorkerLedgerEntry["state"]>(["merged", "delivered", "archived"]);
const ASKING = new Set<ThreadStatus>(["needsApproval", "needsInput"]);

/**
 * Since when a worker has sat without moving, once that is `STUCK_AFTER_MS` or more: no turn, tool
 * call or report since. `undefined` for one that moved lately, is finished, waits on the user's
 * answer, that the user holds (they are the one moving it), or whose thread works now (`working`,
 * by `threadWorking`: a background shell or subagent still running under it), as its tone says.
 */
export const stalledSince = (
  entry: Pick<WorkerLedgerEntry, "state" | "pendingRequests" | "userIntervened" | "lastReport">,
  thread: Pick<Thread, "lastActivityAt" | "completedReason">,
  status: ThreadStatus | undefined,
  now: number,
  working = false,
): number | undefined => {
  if (working) return undefined;
  if (FINISHED.has(entry.state) || thread.completedReason !== undefined) return undefined;
  if (entry.pendingRequests.length > 0 || entry.userIntervened) return undefined;
  if (status !== undefined && ASKING.has(status)) return undefined;
  if (entry.lastReport?.state === "done") return undefined;
  const idleSince = Math.max(thread.lastActivityAt, entry.lastReport?.at ?? thread.lastActivityAt);
  return stuckDue(idleSince, now) ? idleSince : undefined;
};

/** "idle 50 min", "idle 2 h", "idle 3 d": how long, in the largest whole unit. */
export const idleFor = (idleSince: number, now: number): string => {
  const minutes = Math.max(0, Math.floor((now - idleSince) / 60_000));
  if (minutes < 60) return `idle ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `idle ${hours} h`;
  return `idle ${Math.floor(hours / 24)} d`;
};

/** The facts as the view shows them when the helper has no sentence: short, plain, in order. */
export const factLines = (facts: StuckFacts): string[] => [
  ...(facts.lastError === undefined ? [] : [`Failed: ${facts.lastError}`]),
  ...(facts.lastReport === undefined
    ? []
    : [`Reported ${facts.lastReport.state}: ${facts.lastReport.summary}`]),
  ...(facts.lastTool === undefined ? [] : [`Last ran ${facts.lastTool}`]),
  ...facts.prs,
];

export interface Nudge {
  readonly id: "continue" | "checkCi" | "rebase" | "askOrchestrator";
  readonly label: string;
  /** Where its words go: the worker's composer, or the orchestrator's. */
  readonly to: "worker" | "orchestrator";
  readonly text: string;
}

/**
 * The nudges a stalled worker offers, each of four words or fewer. Check CI only while it has a PR.
 * A worker nudge fills the worker's composer, and sending it is a message the user typed, so it
 * holds the worker as any message does; Ask orchestrator leaves the worker alone.
 */
export const nudgesFor = (
  thread: Pick<Thread, "id" | "title">,
  facts: Pick<StuckFacts, "prs" | "idleSince"> | undefined,
  now: number,
): Nudge[] => [
  { id: "continue", label: "Continue", to: "worker", text: "Continue where you left off." },
  ...(facts !== undefined && facts.prs.length > 0
    ? [
        {
          id: "checkCi" as const,
          label: "Check CI",
          to: "worker" as const,
          text: "Check CI on your PR and fix what fails.",
        },
      ]
    : []),
  {
    id: "rebase",
    label: "Rebase",
    to: "worker",
    text: "Rebase on the latest base branch and resolve any conflicts.",
  },
  {
    id: "askOrchestrator",
    label: "Ask orchestrator",
    to: "orchestrator",
    text: `"${thread.title}" [thread ${thread.id}] is ${
      facts === undefined ? "idle" : idleFor(facts.idleSince, now)
    }. What is it waiting on?\n\n`,
  },
];

export { STUCK_AFTER_MS };
