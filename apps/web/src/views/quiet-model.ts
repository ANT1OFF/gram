import type { ThreadId, WorkspaceId } from "@gram/contracts";

import type { Ask } from "@/orchestration/ask-model";
import { WAIT_LABELS, type WorkerActivity } from "@/orchestration/wait-model";
import type { RailTone } from "@/orchestration/rail-model";
import type { WorkerRow } from "@/orchestration/workers-model";

/** How the summary says a wait on automation: the Board's word for it. */
const WAITING = WAIT_LABELS.checks.toLowerCase();

// Quiet's deck and strip: every workspace's asks, then the solo threads', one card at a time, and a
// dot per worker. No React.

/** How long the window must sit untouched, with nothing asked, before it drops into Quiet by itself. */
export const QUIET_IDLE_MS = 5 * 60_000;

/** One card of the deck: an ask and the workspace it came from, none for a solo thread's. */
export interface DeckCard {
  readonly ask: Ask;
  readonly workspaceId: WorkspaceId | undefined;
  readonly workspace: string;
  /** Where Open goes: the asking thread, else the workspace's orchestrator. */
  readonly threadId: ThreadId | undefined;
}

/** What the deck reads from each workspace, or the solo threads: `WorkspaceAsks` without the hook. */
export interface DeckSource {
  readonly workspaceId: WorkspaceId | undefined;
  readonly name: string;
  readonly orchestratorThreadId: ThreadId | undefined;
  readonly asks: readonly Ask[];
}

/** The thread an ask is best read in: the first asker's, else the orchestrator's. */
const askThread = (ask: Ask, orchestrator: ThreadId | undefined): ThreadId | undefined =>
  ask.group?.entries[0]?.threadId ?? orchestrator;

/**
 * Every ask as one deck: the window's workspace first, then the others in their order, each in its
 * stack's order. Asks sent back with Later go behind the rest, in the order they were sent back.
 */
export const quietDeck = (
  sources: readonly DeckSource[],
  first: WorkspaceId | undefined,
  later: readonly string[],
): DeckCard[] => {
  const ordered = [
    ...sources.filter((source) => first !== undefined && source.workspaceId === first),
    ...sources.filter((source) => first === undefined || source.workspaceId !== first),
  ];
  const cards = ordered.flatMap((source) =>
    source.asks.map((ask) => ({
      ask,
      workspaceId: source.workspaceId,
      workspace: source.name,
      threadId: askThread(ask, source.orchestratorThreadId),
    })),
  );
  const back = new Map(later.map((key, index) => [key, index]));
  return [
    ...cards.filter((card) => !back.has(card.ask.key)),
    ...cards
      .filter((card) => back.has(card.ask.key))
      .toSorted((a, b) => back.get(a.ask.key)! - back.get(b.ask.key)!),
  ];
};

/** Sends `key` to the back of the deck; the list keeps only keys still in it. */
export const sendLater = (
  later: readonly string[],
  key: string,
  live: ReadonlySet<string>,
): string[] => [...later.filter((each) => each !== key && live.has(each)), key];

/**
 * A dot's tone in the strip: what a glance should tell apart. Working runs a turn; waiting is busy
 * too, on CI, a review or another automation, and draws hollow; needs is stopped where somebody
 * has to act.
 */
export type DotTone = "working" | "waiting" | "needs" | "error" | "idle";

/** A tone as a strip dot: asks and attention alike need somebody, merged is at rest. */
const DOT_TONE: Readonly<Record<RailTone, DotTone>> = {
  needs: "needs",
  attention: "needs",
  error: "error",
  working: "working",
  waiting: "waiting",
  idle: "idle",
  merged: "idle",
};

/** A row's dot, by its tone (`liveWorkerTone`), the one the Board and the sidebar read. */
export const dotTone = (row: Pick<WorkerRow, "tone">): DotTone => DOT_TONE[row.tone];

/** A workspace in the strip: its live workers and what the Quiet summary counts. */
export interface StripWorkspace {
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly orchestratorThreadId: ThreadId | undefined;
  /** The Workers list's Now rows, in its order. */
  readonly workers: readonly WorkerRow[];
  readonly asks: number;
  /** Workers whose PR merged today. */
  readonly mergedToday: number;
}

const workers = (n: number) => (n === 1 ? "1 worker" : `${n} workers`);

/**
 * What the empty field says: "6 workers are busy: 3 working, 3 waiting on checks. 1 needs
 * attention. 2 PRs merged today." Busy counts a live turn and a wait on automation alike.
 */
export const quietSummary = (strip: readonly StripWorkspace[]): string => {
  const rows = strip.flatMap((w) => w.workers);
  const count = (activity: WorkerActivity) =>
    rows.filter((row) => row.activity === activity).length;
  const working = count("working");
  const waiting = count("automation");
  const attention = count("attention");
  const busy = working + waiting;
  const merged = strip.reduce((sum, w) => sum + w.mergedToday, 0);
  const is = busy === 1 ? "is" : "are";
  const parts = [
    busy === 0
      ? "No workers are busy."
      : waiting === 0
        ? `${workers(busy)} ${is} busy.`
        : working === 0
          ? `${workers(busy)} ${is} busy, ${WAITING}.`
          : `${workers(busy)} are busy: ${working} working, ${waiting} ${WAITING}.`,
  ];
  if (attention > 0) parts.push(`${attention} ${attention === 1 ? "needs" : "need"} attention.`);
  if (merged > 0) parts.push(merged === 1 ? "1 PR merged today." : `${merged} PRs merged today.`);
  return parts.join(" ");
};

/** Whether the window should drop into Quiet by itself now. */
export const shouldEnterQuiet = ({
  enabled,
  available,
  quiet,
  asks,
  idleFor,
}: {
  readonly enabled: boolean;
  /** Workspaces are on: Quiet has something to show. */
  readonly available: boolean;
  readonly quiet: boolean;
  readonly asks: number;
  readonly idleFor: number;
}): boolean => enabled && available && !quiet && asks === 0 && idleFor >= QUIET_IDLE_MS;
