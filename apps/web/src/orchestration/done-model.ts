import type { WorkspaceId } from "@gram/contracts";

import { formatStamp } from "@/lib/time";
import type { DoneGrouping } from "@/stores/layout";

import { doneDay } from "./workers-model";

// Done, as the overview and ⌘J both list it: every finished chat, workers and solo threads alike,
// latest first, grouped by date or by orchestrator, a page at a time. Pure, so the two lists group
// and page alike and are tested without a browser.

export type { DoneGrouping };

/** Each grouping, and how its control names it. */
export const DONE_GROUPINGS: readonly { readonly id: DoneGrouping; readonly hint: string }[] = [
  { id: "date", hint: "Group by date" },
  { id: "orchestrator", hint: "Group by orchestrator" },
];

/** The rows Done shows when opened, and how many more each "Show more" adds. */
export const DONE_PAGE = 30;

/** The group a row has by orchestrator: its workspace, or the solo threads'. */
export interface DoneOwner {
  /** The workspace's id, or `SOLO_OWNER.key`. */
  readonly key: string;
  /** The workspace's name, as the overview names it. */
  readonly label: string;
}

/** Threads outside any workspace, named as the overview's section names them. */
export const SOLO_OWNER: DoneOwner = { key: "solo", label: "Solo threads" };

/** What Done reads of a row to group and page it. */
export interface DoneEntry {
  readonly threadId: string;
  /** Epoch ms it finished; absent with no time to go by, which lists it last. */
  readonly finishedAt?: number | undefined;
  readonly owner: DoneOwner;
  /** Its workspace, whose older finished workers may still be loading; absent for a solo thread. */
  readonly workspaceId?: WorkspaceId | undefined;
}

/** A heading's rows. */
export interface DoneGroup<T> {
  readonly key: string;
  readonly label: string;
  readonly rows: readonly T[];
}

/** Latest first; a row with no time goes after every dated one. */
export const latestDoneFirst = <T extends DoneEntry>(a: T, b: T): number =>
  (b.finishedAt ?? -Infinity) - (a.finishedAt ?? -Infinity) || a.threadId.localeCompare(b.threadId);

/**
 * Rows, latest first (`latestDoneFirst`), under their headings. By date: a day for each of the last
 * `DONE_DAYS` days, then a month (`doneDay`). By orchestrator: one group per workspace and one for
 * the solo threads, the one with the latest finished row first, each latest first within.
 */
export const groupDone = <T extends DoneEntry>(
  rows: readonly T[],
  by: DoneGrouping,
  now: number,
): DoneGroup<T>[] => {
  const groups = new Map<string, { label: string; rows: T[] }>();
  for (const row of rows) {
    const { key, label } =
      by === "orchestrator"
        ? { key: `o:${row.owner.key}`, label: row.owner.label }
        : ((day) => ({ key: `d:${day.start}`, label: day.label }))(doneDay(row.finishedAt, now));
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { label, rows: [row] });
    else group.rows.push(row);
  }
  return [...groups].map(([key, group]) => ({ key, ...group }));
};

/** What of Done can be shown now, a page at a time across the whole list. */
export interface DoneWindow<T> {
  /** The rows to show, in their groups. */
  readonly groups: readonly DoneGroup<T>[];
  /** How many rows that is. */
  readonly shown: number;
  /** There are rows past these, or a workspace may still have older finished workers. */
  readonly more: boolean;
  /** The workspace whose next page of finished workers the shown rows wait on. */
  readonly load: WorkspaceId | undefined;
}

/**
 * The first `limit` rows of Done in their groups, paged across the whole list rather than per
 * group. `rows` is everything loaded, latest first. `horizons` holds, for each workspace with older
 * finished workers still to load, the time its next page starts at: a row it could precede isn't
 * shown until that page is in, so loading one never puts a row above what was already shown. When
 * the page is short for that reason, `load` names the workspace to load next.
 */
export const doneWindow = <T extends DoneEntry>(
  rows: readonly T[],
  by: DoneGrouping,
  now: number,
  horizons: ReadonlyMap<WorkspaceId, number>,
  limit: number,
): DoneWindow<T> => {
  const latest = [...horizons].reduce<[WorkspaceId, number] | undefined>(
    (best, each) => (best === undefined || each[1] > best[1] ? each : best),
    undefined,
  );
  // A workspace with more to load and nothing loaded yet: where its group goes isn't known.
  const unplaced = [...horizons.keys()].find((id) => !rows.some((row) => row.workspaceId === id));
  // The workspace still loading that could list something before `row`, if any.
  const waitsOn = (row: T): WorkspaceId | undefined => {
    const at = row.finishedAt ?? -Infinity;
    if (by === "date") return latest !== undefined && at < latest[1] ? latest[0] : undefined;
    if (unplaced !== undefined) return unplaced;
    const own = row.workspaceId === undefined ? undefined : horizons.get(row.workspaceId);
    return own !== undefined && at < own ? row.workspaceId : undefined;
  };
  const groups = groupDone(rows, by, now);
  const ordered = groups.flatMap((group) => group.rows);
  let settled = 0;
  let blocker: WorkspaceId | undefined;
  scan: for (const group of groups) {
    for (const row of group.rows) {
      blocker = waitsOn(row);
      if (blocker !== undefined) break scan;
      settled += 1;
    }
    // By orchestrator, a workspace's older workers go at the end of its group, before the next.
    const own = group.rows[0]?.workspaceId;
    if (by === "orchestrator" && own !== undefined && horizons.has(own)) {
      blocker = own;
      break;
    }
  }
  const visible = ordered.slice(0, Math.min(limit, settled));
  // Short of a page: load what the next row waits on, else whatever may still have more.
  const load = visible.length < limit ? (blocker ?? unplaced ?? latest?.[0]) : undefined;
  return {
    groups: groupDone(visible, by, now),
    shown: visible.length,
    more: ordered.length > visible.length || horizons.size > 0,
    load,
  };
};

/** A finished row's time: its 24-hour clock today, else its date before the clock (`formatStamp`). */
export const doneWhen = (at: number | undefined, now: number): string =>
  at === undefined ? "" : formatStamp(at, now);

/** A finished row's time for its name: `doneWhen`, or that none is on record. */
export const doneWhenLong = (at: number | undefined, now: number): string =>
  at === undefined ? "no time on record" : formatStamp(at, now);
