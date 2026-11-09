import {
  effectiveCheckout,
  type HostId,
  isLocalHost,
  type ThreadId,
  type ThreadSummary,
} from "@gram/contracts";

import { formatRelative, formatStamp } from "@/lib/time";

import type { RailTone } from "./rail-model";
import { glyphState, STARTING, STATUS_WORDS, type DotState } from "./status-words";
import { searchRows, type WorkerRow, type WorkersByTab } from "./workers-model";

// The panel's Workers tab: a workspace's workers by where they stand, in the few states every view
// says (`STATUS_WORDS`). Its rows are ⌘J's (`workersByTab`), so each worker's tone, and so its group,
// is the one selector the sidebar and the Board read (`liveWorkerTone`); what puts a worker under
// Needs you is the one needs-you selector the pill, the badges and the Inbox count by (`needsYouIn`),
// so Needs you here lists exactly the workers the workspace's badge counts items for. Pure, so it is
// tested without a browser. No React.

export type StatusGroupId = "needs" | "running" | "waiting" | "stopped" | "done";

export interface StatusGroupSpec {
  readonly id: StatusGroupId;
  /** Its heading: the state's word, the one every surface says. */
  readonly label: string;
  /** What would be listed there, said while nothing is. */
  readonly empty: string;
}

/** The groups in the panel's order: what needs you first, finished work last. */
export const STATUS_GROUPS: readonly StatusGroupSpec[] = [
  { id: "needs", label: STATUS_WORDS.needs, empty: "Approvals, questions and failures for you" },
  { id: "running", label: STATUS_WORDS.working, empty: "Workers taking a turn now" },
  {
    id: "waiting",
    label: STATUS_WORDS.waiting,
    empty: "Workers waiting on checks, a review, a wake or a limit",
  },
  { id: "stopped", label: STATUS_WORDS.idle, empty: "Workers at rest with nothing running" },
  { id: "done", label: STATUS_WORDS.done, empty: "Merged and finished workers" },
];

/** The groups that start folded: finished work is looked back at, not watched. */
export const FOLDED_BY_DEFAULT: readonly StatusGroupId[] = ["done"];

/** How many of Done's rows show before the rest fold behind "N more", as in the sidebar. */
export const DONE_SHOWN = 5;

/**
 * A live worker's group by its tone, once Needs you has taken the workers the needs-you list has an
 * item for (`groupOf`). One whose tone still says needs or error without an item (its ask put away
 * for Later, its failure dismissed, a report the orchestrator answers) is at rest: Stopped, its dot
 * still saying why. One stalled on its own next step (attention) has stopped too.
 */
const TONE_GROUP: Readonly<Record<RailTone, StatusGroupId>> = {
  needs: "stopped",
  error: "stopped",
  working: "running",
  waiting: "waiting",
  attention: "stopped",
  idle: "stopped",
  merged: "done",
};

export interface PanelRow {
  readonly threadId: ThreadId;
  readonly title: string;
  /** Its dot, the one the sidebar and the Board draw for it. */
  readonly dot: DotState;
  /** Its state in words, for a screen reader and the row's hover: "Waiting · checks on #142". */
  readonly status: string;
  /**
   * Its status line under the title: `status` without the state word its group's heading already
   * says ("Checks on #142"), or that word alone when it says nothing more.
   */
  readonly line: string;
  /** Compact age since it last did something or finished: `now`, `5m`, `3h`. */
  readonly age: string;
  /** That time in full (`formatStamp`), for the age's hover; absent with no time to go by. */
  readonly at?: string | undefined;
  /** Closed with its worktree or a solo thread: it opens in the main view only. */
  readonly mainOnly: boolean;
  /** The joined machine its checkout is on; absent for this one. */
  readonly hostId?: HostId | undefined;
}

export interface StatusGroup extends StatusGroupSpec {
  readonly rows: readonly PanelRow[];
}

/** A row's dot: its live tone, or for finished work the done dot its glyph says. */
const dotOf = (row: WorkerRow): DotState => (row.tab === "done" ? glyphState(row.glyph) : row.tone);

/** When a row last moved: when it finished, else its thread's last activity. */
const lastAt = (row: WorkerRow, summary: ThreadSummary | undefined): number | undefined =>
  row.finishedAt ?? summary?.thread.lastActivityAt;

/** `status` less its leading state word, sentence-cased: "Waiting · checks on #88" is "Checks on #88". */
export const lineOf = (status: string, dot: DotState): string => {
  const prefix = `${STATUS_WORDS[dot]} · `;
  if (!status.startsWith(prefix)) return status;
  const rest = status.slice(prefix.length);
  return rest.charAt(0).toUpperCase() + rest.slice(1);
};

/** The joined machine a thread's checkout is on, or `undefined` for this one. */
const hostOfSummary = (summary: ThreadSummary | undefined): HostId | undefined => {
  const checkout = summary === undefined ? undefined : effectiveCheckout(summary.thread);
  return checkout === undefined || isLocalHost(checkout) ? undefined : checkout.hostId;
};

/** A ⌘J row as the panel's: its dot, its words and its age. */
export const panelRow = (
  row: WorkerRow,
  summary: ThreadSummary | undefined,
  now: number,
): PanelRow => {
  const dot = dotOf(row);
  const at = lastAt(row, summary);
  const word = row.waiting?.label ?? STATUS_WORDS[dot];
  // Starting is the whole of what it says: its now line says it too.
  const status =
    row.starting === true
      ? STARTING
      : word === row.now || row.now === ""
        ? word
        : `${word} · ${row.now}`;
  return {
    threadId: row.threadId,
    title: row.title,
    dot,
    status,
    line: lineOf(status, dot),
    age: at === undefined ? "" : formatRelative(at, now),
    at: at === undefined ? undefined : formatStamp(at, now),
    mainOnly: row.cleanedUp === true || row.solo === true,
    hostId: hostOfSummary(summary),
  };
};

/**
 * Which group a ⌘J row goes in: Needs you when the needs-you list has an item on its thread
 * (`needing`, from `needsYouThreads` over the workspace's `needsYouIn`), Done when its work is over,
 * else by its tone.
 */
export const groupOf = (row: WorkerRow, needing: ReadonlySet<ThreadId>): StatusGroupId =>
  needing.has(row.threadId) ? "needs" : row.tab === "done" ? "done" : TONE_GROUP[row.tone];

/**
 * Every group in order, each with the rows of `tabs` that are its and that match `query`: Now's in
 * the ledger's feature and spawn order, so rows don't jump as they change, and Done's latest first.
 * `needing` are the threads the workspace's needs-you items are on.
 */
export const statusGroups = (
  tabs: WorkersByTab,
  byId: Readonly<Record<string, ThreadSummary | undefined>>,
  now: number,
  needing: ReadonlySet<ThreadId>,
  query = "",
): readonly StatusGroup[] => {
  const all = [...tabs.now, ...tabs.done].flatMap((feature) => feature.rows);
  const rows = new Map<StatusGroupId, PanelRow[]>(STATUS_GROUPS.map((spec) => [spec.id, []]));
  for (const row of searchRows(all, query)) {
    rows.get(groupOf(row, needing))!.push(panelRow(row, byId[row.threadId], now));
  }
  return STATUS_GROUPS.map((spec) => ({ ...spec, rows: rows.get(spec.id)! }));
};

/** The groups shown under a filter: every one when none is picked. */
export const filteredGroups = (
  groups: readonly StatusGroup[],
  shown: ReadonlySet<StatusGroupId>,
): readonly StatusGroup[] =>
  shown.size === 0 ? groups : groups.filter((group) => shown.has(group.id));

/** The filter's name in words: "All workers", or the groups it shows. */
export const filterLabel = (shown: ReadonlySet<StatusGroupId>): string =>
  shown.size === 0 || shown.size === STATUS_GROUPS.length
    ? "All workers"
    : STATUS_GROUPS.filter((spec) => shown.has(spec.id))
        .map((spec) => spec.label)
        .join(", ");

/**
 * What needs you outside the panel's workspace, said under its Needs you so that count reads as
 * this workspace's share of the pill's: "2 need you elsewhere", or "1 more needs you elsewhere"
 * beside rows of its own.
 */
export const elsewhereLine = (elsewhere: number, here: number): string =>
  `${elsewhere}${here > 0 ? " more" : ""} ${elsewhere === 1 ? "needs" : "need"} you elsewhere`;
