import type { ThreadId, ThreadSummary } from "@gram/contracts";

import { formatRelative, formatStamp } from "@/lib/time";

import type { RailTone } from "./rail-model";
import { glyphState, STATUS_WORDS, type DotState } from "./status-words";
import { searchRows, type WorkerRow, type WorkersByTab } from "./workers-model";

// The panel's Workers tab: a workspace's workers by where they stand, in the few states every view
// says (`STATUS_WORDS`). Its rows are ⌘J's (`workersByTab`), so each worker's tone, and so its group
// and every count here, is the one selector the sidebar, the Board and the Inbox read
// (`liveWorkerTone`). Pure, so it is tested without a browser. No React.

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
 * A live worker's group by its tone. A failure is the Inbox's too (`needsYouFailures`), so a failed
 * worker is listed with what needs you, its red dot saying why; one stalled on its own next step
 * (attention) has stopped, as its grey dot says.
 */
const TONE_GROUP: Readonly<Record<RailTone, StatusGroupId>> = {
  needs: "needs",
  error: "needs",
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
  /** Compact age since it last did something or finished: `now`, `5m`, `3h`. */
  readonly age: string;
  /** That time in full (`formatStamp`), for the age's hover; absent with no time to go by. */
  readonly at?: string | undefined;
  /** Closed with its worktree or a solo thread: it opens in the main view only. */
  readonly mainOnly: boolean;
}

export interface StatusGroup extends StatusGroupSpec {
  readonly rows: readonly PanelRow[];
}

/** A row's dot: its live tone, or for finished work the done dot its glyph says. */
const dotOf = (row: WorkerRow): DotState => (row.tab === "done" ? glyphState(row.glyph) : row.tone);

/** When a row last moved: when it finished, else its thread's last activity. */
const lastAt = (row: WorkerRow, summary: ThreadSummary | undefined): number | undefined =>
  row.finishedAt ?? summary?.thread.lastActivityAt;

/** A ⌘J row as the panel's: its dot, its words and its age. */
export const panelRow = (
  row: WorkerRow,
  summary: ThreadSummary | undefined,
  now: number,
): PanelRow => {
  const dot = dotOf(row);
  const at = lastAt(row, summary);
  const word = row.waiting?.label ?? STATUS_WORDS[dot];
  return {
    threadId: row.threadId,
    title: row.title,
    dot,
    status: word === row.now || row.now === "" ? word : `${word} · ${row.now}`,
    age: at === undefined ? "" : formatRelative(at, now),
    at: at === undefined ? undefined : formatStamp(at, now),
    mainOnly: row.cleanedUp === true || row.solo === true,
  };
};

/** Which group a ⌘J row goes in. */
export const groupOf = (row: WorkerRow): StatusGroupId =>
  row.tab === "done" ? "done" : TONE_GROUP[row.tone];

/**
 * Every group in order, each with the rows of `tabs` that are its and that match `query`: Now's in
 * the ledger's feature and spawn order, so rows don't jump as they change, and Done's latest first.
 */
export const statusGroups = (
  tabs: WorkersByTab,
  byId: Readonly<Record<string, ThreadSummary | undefined>>,
  now: number,
  query = "",
): readonly StatusGroup[] => {
  const all = [...tabs.now, ...tabs.done].flatMap((feature) => feature.rows);
  const rows = new Map<StatusGroupId, PanelRow[]>(STATUS_GROUPS.map((spec) => [spec.id, []]));
  for (const row of searchRows(all, query)) {
    rows.get(groupOf(row))!.push(panelRow(row, byId[row.threadId], now));
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
