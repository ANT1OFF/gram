import {
  effectiveCheckout,
  type FeatureStation,
  STATION_LABELS,
  type HostId,
  type SentTo,
  isLocalHost,
  type ThreadId,
  type ThreadSummary,
  type WorkerPlacement,
} from "@gram/contracts";

import type { OnDemandChoice } from "@/api/on-demand";

import { formatRelative, formatStamp } from "@/lib/time";

import { ASKS_YOU, type OverviewWorkerRow } from "./overview-model";
import type { RailTone } from "./rail-model";
import { glyphState, STARTING, STATUS_WORDS, type DotState } from "./status-words";
import { searchRows, type WorkerRow, type WorkersByTab } from "./workers-model";

export type StatusGroupId = "needs" | "running" | "waiting" | "stopped" | "done";

export interface StatusGroupSpec {
  readonly id: StatusGroupId;
  /** Its heading: the state's word, the one every surface says. */
  readonly label: string;
}

/** The groups in the panel's order: what needs you first, finished work last. */
export const STATUS_GROUPS: readonly StatusGroupSpec[] = [
  { id: "needs", label: STATUS_WORDS.needs },
  { id: "running", label: STATUS_WORDS.working },
  { id: "waiting", label: STATUS_WORDS.waiting },
  { id: "stopped", label: STATUS_WORDS.idle },
  { id: "done", label: STATUS_WORDS.done },
];

/** The groups that start folded: finished work is looked back at, not watched. */
export const FOLDED_BY_DEFAULT: readonly StatusGroupId[] = ["done"];

/** How many of Done's rows show before the rest fold behind "N more", as in the sidebar. */
export const DONE_SHOWN = 5;

const TONE_GROUP: Readonly<Record<RailTone, StatusGroupId>> = {
  needs: "stopped",
  error: "stopped",
  working: "running",
  waiting: "waiting",
  attention: "stopped",
  idle: "stopped",
  merged: "waiting",
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
  /** The server it was sent to, which runs it; absent for a worker that runs here or on a machine. */
  readonly sent?: SentTo | undefined;
  /** Where its orchestrator put it, when that is a machine for workers, and why. */
  readonly placement?: WorkerPlacement | undefined;
  /** When it last moved, as epoch ms: its finish, else its thread's last activity. */
  readonly atMs?: number | undefined;
  /** The ⌘J row it is drawn from, which the shared worker row reads when no card has it. */
  readonly source: WorkerRow;
}

export interface StatusGroup extends StatusGroupSpec {
  readonly rows: readonly PanelRow[];
}

const dotOf = (row: WorkerRow): DotState => (row.tab === "done" ? glyphState(row.glyph) : row.tone);

const lastAt = (row: WorkerRow, summary: ThreadSummary | undefined): number | undefined =>
  row.finishedAt ?? summary?.thread.lastActivityAt;

/** `status` less its leading state word, sentence-cased: "Waiting · checks on #88" is "Checks on #88". */
export const lineOf = (status: string, dot: DotState): string => {
  const prefix = `${STATUS_WORDS[dot]} · `;
  if (!status.startsWith(prefix)) return status;
  const rest = status.slice(prefix.length);
  return rest.charAt(0).toUpperCase() + rest.slice(1);
};

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
    sent: summary?.thread.sentTo,
    placement:
      summary?.thread.sentTo === undefined ? summary?.thread.spawnedBy?.placement : undefined,
    atMs: at,
    source: row,
  };
};

/**
 * A placement in a few words: "Shared" for a machine another worker has, else "Own" and what the
 * orchestrator named, each by the option's short label where the provider's choices name it.
 */
export const placementWords = (
  placement: WorkerPlacement,
  choices: ReadonlyArray<OnDemandChoice> = [],
): string => {
  if (placement.shared === true) return "Shared";
  const named = Object.entries(placement.picks ?? {}).map(([id, value]) => {
    const option = choices.find((choice) => choice.id === id)?.options.find((o) => o.id === value);
    return option?.short ?? option?.label ?? value;
  });
  return ["Own", ...named].join(" · ");
};

/**
 * Which group a ⌘J row goes in: Needs you when the needs-you list has an item on its thread
 * (`needing`, from `needsYouThreads` over the workspace's `needsYouIn`), Done when its work is over,
 * else by its tone. Over is its tab, the rule the sidebar keeps a worker by (`workerShown`): one
 * merged or delivered with something still pending (a wake, a monitored run, an open PR, you
 * holding it) has a merged tone yet counts among the sidebar's live workers, so it is in Waiting.
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

/**
 * A panel row as the shared worker row reads it (`OverviewWorkerRow`), for a worker no feature card
 * has (a finished one, or one its card doesn't list yet): the same facts from the ⌘J row it came
 * from. `askKey` is the ask of its in the stack.
 */
export const overviewRowOf = (row: PanelRow, askKey: string | undefined): OverviewWorkerRow => {
  const worker = row.source;
  const done = worker.tab === "done";
  const station: FeatureStation = done ? "merged" : "working";
  return {
    threadId: worker.threadId,
    title: worker.title,
    state: worker.state,
    now: askKey !== undefined ? ASKS_YOU : done ? row.line : worker.now,
    station,
    stationLabel: STATION_LABELS[station],
    failed: worker.tone === "error",
    askKey,
    pr: undefined,
    prs: [],
    held: worker.held,
    activity: worker.activity,
    tone: done ? "merged" : worker.tone,
    waiting: askKey === undefined && !done ? worker.waiting : undefined,
  };
};

/** Every row of `groups` in their order, the one ↑ ↓ and the switcher step through. */
export const rowsInOrder = (groups: readonly StatusGroup[]): readonly PanelRow[] =>
  groups.flatMap((group) => group.rows);

/** The row before or after `threadId` in `order`, if any. */
export const neighbour = (
  order: readonly PanelRow[],
  threadId: ThreadId,
  step: -1 | 1,
): PanelRow | undefined => {
  const at = order.findIndex((row) => row.threadId === threadId);
  return at === -1 ? undefined : order[at + step];
};
