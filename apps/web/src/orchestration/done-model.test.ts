import type { WorkspaceId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import {
  DONE_PAGE,
  doneWhen,
  doneWhenLong,
  doneWindow,
  groupDone,
  latestDoneFirst,
  SOLO_OWNER,
  type DoneEntry,
} from "./done-model";

// Thursday 15 October 2026, 14:40 local time.
const NOW = new Date(2026, 9, 15, 14, 40).getTime();
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

const API = { key: "w-api", label: "agent-platform" };
const INFRA = { key: "w-infra", label: "infra" };

const row = (threadId: string, finishedAt: number | undefined, owner = API): DoneEntry => ({
  threadId,
  finishedAt,
  owner,
  ...(owner === SOLO_OWNER ? {} : { workspaceId: owner.key as WorkspaceId }),
});

const ids = (rows: readonly DoneEntry[]) => rows.map((each) => each.threadId);
const labels = <T extends DoneEntry>(groups: readonly { label: string; rows: readonly T[] }[]) =>
  groups.map((group) => [group.label, ids(group.rows)]);

// Latest first, across two workspaces and the solo threads, back past the week into earlier months.
const rows = [
  row("api-today", NOW - HOUR),
  row("solo-today", NOW - 2 * HOUR, SOLO_OWNER),
  row("infra-yesterday", NOW - DAY, INFRA),
  row("api-mon", NOW - 3 * DAY),
  row("solo-oct", NOW - 9 * DAY, SOLO_OWNER),
  row("infra-oct", NOW - 12 * DAY, INFRA),
  row("api-sep", new Date(2026, 8, 20, 10).getTime()),
  row("solo-2025", new Date(2025, 11, 31, 23).getTime(), SOLO_OWNER),
  row("api-undated", undefined),
].toSorted(latestDoneFirst);

describe("Done's groups", () => {
  it("sorts latest first, with no time last", () => {
    expect(ids(rows)).toEqual([
      "api-today",
      "solo-today",
      "infra-yesterday",
      "api-mon",
      "solo-oct",
      "infra-oct",
      "api-sep",
      "solo-2025",
      "api-undated",
    ]);
  });

  it("by date: a day for each of the last seven, then a month, solo threads among the workers", () => {
    expect(labels(groupDone(rows, "date", NOW))).toEqual([
      ["Today", ["api-today", "solo-today"]],
      ["Yesterday", ["infra-yesterday"]],
      ["Mon 12 Oct", ["api-mon"]],
      ["October 2026", ["solo-oct", "infra-oct"]],
      ["September 2026", ["api-sep"]],
      ["December 2025", ["solo-2025"]],
      ["Earlier", ["api-undated"]],
    ]);
  });

  it("by orchestrator: one per workspace and one for solo threads, the latest first", () => {
    expect(labels(groupDone(rows, "orchestrator", NOW))).toEqual([
      ["agent-platform", ["api-today", "api-mon", "api-sep", "api-undated"]],
      ["Solo threads", ["solo-today", "solo-oct", "solo-2025"]],
      ["infra", ["infra-yesterday", "infra-oct"]],
    ]);
    // A group moves up when something in it finishes later than the others' latest.
    const later = [row("infra-now", NOW, INFRA), ...rows];
    expect(groupDone(later, "orchestrator", NOW).map((group) => group.label)).toEqual([
      "infra",
      "agent-platform",
      "Solo threads",
    ]);
  });

  it("says each row's time where its heading doesn't", () => {
    // By date: the clock this week, the date before, the year once it isn't this one's.
    expect(doneWhen(NOW - HOUR, "date", NOW)).toBe("13:40");
    expect(doneWhen(NOW - 3 * DAY, "date", NOW)).toBe("14:40");
    expect(doneWhen(NOW - 9 * DAY, "date", NOW)).toBe("6 Oct");
    expect(doneWhen(new Date(2025, 11, 31, 23).getTime(), "date", NOW)).toBe("31 Dec 2025");
    // By orchestrator: the clock today, the date before.
    expect(doneWhen(NOW - HOUR, "orchestrator", NOW)).toBe("13:40");
    expect(doneWhen(NOW - DAY, "orchestrator", NOW)).toBe("14 Oct");
    expect(doneWhen(undefined, "orchestrator", NOW)).toBe("");
    expect(doneWhenLong(NOW - HOUR, NOW)).toBe("Today 13:40");
    expect(doneWhenLong(NOW - 3 * DAY, NOW)).toBe("Mon 12 Oct 14:40");
    expect(doneWhenLong(new Date(2025, 11, 31, 23).getTime(), NOW)).toBe("31 Dec 2025 23:00");
  });
});

describe("Done's pages", () => {
  const none = new Map<WorkspaceId, number>();
  // Two hundred finished chats, an hour apart, alternating between a workspace and solo threads.
  const many = Array.from({ length: 200 }, (_, i) =>
    row(`r${String(i).padStart(3, "0")}`, NOW - i * HOUR, i % 2 === 0 ? API : SOLO_OWNER),
  );

  it("shows a page, then the next, across the whole list", () => {
    const first = doneWindow(many, "date", NOW, none, DONE_PAGE);
    expect(first.shown).toBe(DONE_PAGE);
    expect(first.groups.flatMap((group) => ids(group.rows))).toEqual(ids(many.slice(0, 30)));
    expect(first.more).toBe(true);
    expect(first.load).toBeUndefined();
    const second = doneWindow(many, "date", NOW, none, 2 * DONE_PAGE);
    expect(second.groups.flatMap((group) => ids(group.rows))).toEqual(ids(many.slice(0, 60)));
    // By orchestrator the page runs through the groups in order: the first group fills it here.
    const byOwner = doneWindow(many, "orchestrator", NOW, none, DONE_PAGE);
    expect(labels(byOwner.groups)).toEqual([
      ["agent-platform", ids(many.filter((_, i) => i % 2 === 0).slice(0, 30))],
    ]);
    // The last page has nothing after it.
    const all = doneWindow(many, "orchestrator", NOW, none, 1_000);
    expect(all.shown).toBe(200);
    expect(all.more).toBe(false);
  });

  it("by date, holds back what a workspace's unread pages could come before, and loads them", () => {
    // infra has read down to three days ago; older rows wait for its next page.
    const horizons = new Map([[INFRA.key as WorkspaceId, NOW - 3 * DAY + HOUR]]);
    const page = doneWindow(rows, "date", NOW, horizons, DONE_PAGE);
    expect(page.groups.flatMap((group) => ids(group.rows))).toEqual([
      "api-today",
      "solo-today",
      "infra-yesterday",
    ]);
    expect(page.more).toBe(true);
    expect(page.load).toBe(INFRA.key);
    // A full page needs nothing loaded, however much is still to come.
    expect(doneWindow(rows, "date", NOW, horizons, 2).load).toBeUndefined();
    // Of two workspaces still loading, the one whose pages stop latest goes first.
    const two = new Map([
      [API.key as WorkspaceId, NOW - 20 * DAY],
      [INFRA.key as WorkspaceId, NOW - 3 * DAY + HOUR],
    ]);
    expect(doneWindow(rows, "date", NOW, two, DONE_PAGE).load).toBe(INFRA.key);
  });

  it("by orchestrator, holds back a group's later neighbours until its own pages are read", () => {
    const horizons = new Map([[API.key as WorkspaceId, NOW - 5 * DAY]]);
    const page = doneWindow(rows, "orchestrator", NOW, horizons, DONE_PAGE);
    // agent-platform's rows newer than where its pages stop show; the rest, and the groups after
    // it, wait for its next page.
    expect(labels(page.groups)).toEqual([["agent-platform", ["api-today", "api-mon"]]]);
    expect(page.load).toBe(API.key);
    // Once read to the end, everything shows.
    expect(doneWindow(rows, "orchestrator", NOW, none, DONE_PAGE).shown).toBe(rows.length);
  });

  it("loads a workspace with more to read once every loaded row is shown", () => {
    const horizons = new Map([[INFRA.key as WorkspaceId, NOW - 400 * DAY]]);
    const page = doneWindow(rows, "date", NOW, horizons, DONE_PAGE);
    // Everything loaded is newer than where infra's pages stop, bar the undated row.
    expect(page.shown).toBe(rows.length - 1);
    expect(page.load).toBe(INFRA.key);
    expect(page.more).toBe(true);
  });

  it("loads a workspace that has more to read and nothing read yet, before placing its group", () => {
    const fresh = new Map([["w-new" as WorkspaceId, NOW]]);
    const byOwner = doneWindow(rows, "orchestrator", NOW, fresh, DONE_PAGE);
    expect(byOwner.shown).toBe(0);
    expect(byOwner.load).toBe("w-new");
    expect(doneWindow([], "date", NOW, fresh, DONE_PAGE).load).toBe("w-new");
  });
});
