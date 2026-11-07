import type { ThreadSummary, WorkspaceState } from "@gram/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  doneSoloThreads,
  inHistory,
  parkedSoloThreads,
  snoozedSoloThreads,
  soloThreads,
} from "./solo-threads";
import { chatRoute, switcherChecked, useViewStore } from "./view-store";
import { viewWorkspace } from "./view-workspace";

const s = useViewStore.getState;

beforeEach(() =>
  useViewStore.setState({ view: "chat", quiet: false, carry: undefined, lastChat: undefined }),
);

describe("the view", () => {
  it("goes back to Chat on a route change, unless a workspace switch carries it there", () => {
    s().setView("board");
    s().routeChanged("/t/worker");
    expect(s().view).toBe("chat");

    s().setView("board");
    s().carryView("/t/orch-b");
    s().routeChanged("/t/orch-b");
    expect(s().view).toBe("board");
    // Carried once: the next route change resets it.
    s().routeChanged("/settings");
    expect(s().view).toBe("chat");

    s().setView("board");
    s().carryView("/t/orch-b");
    s().routeChanged("/t/somewhere-else");
    expect(s()).toMatchObject({ view: "chat", carry: undefined });
  });

  it("counts every pick, the view already shown included", () => {
    const before = s().picks;
    s().setView("board");
    s().setView("board");
    expect(s()).toMatchObject({ view: "board", picks: before + 2 });
    // A route change isn't a pick.
    s().routeChanged("/settings");
    expect(s()).toMatchObject({ view: "chat", picks: before + 2 });
  });

  it("marks Chat only on a chat route, so Settings, Memory and New never read as Chat", () => {
    // Round 8 found Chat highlighted on Memory, Settings, New and New workspace.
    for (const page of [
      "/settings/general",
      "/w/ws-1/memory",
      "/new",
      "/new-task",
      "/new-workspace",
      "/usage",
    ]) {
      expect(chatRoute(page)).toBe(false);
      expect(switcherChecked("chat", page)).toBeUndefined();
      // Board draws over any route, and is marked wherever it shows.
      expect(switcherChecked("board", page)).toBe("board");
    }
    expect(switcherChecked("chat", "/t/t-1")).toBe("chat");
    expect(switcherChecked("chat", "/")).toBe("chat");
  });

  it("remembers the last chat route, which Chat goes back to from a page of its own", () => {
    s().routeChanged("/t/t-1");
    s().routeChanged("/settings/general");
    expect(s().lastChat).toBe("/t/t-1");
    s().routeChanged("/w/ws-1/memory");
    expect(s().lastChat).toBe("/t/t-1");
    s().routeChanged("/t/t-2");
    expect(s().lastChat).toBe("/t/t-2");
  });

  it("keeps Quiet apart from the view", () => {
    s().setView("board");
    s().toggleQuiet();
    expect(s()).toMatchObject({ view: "board", quiet: true });
    s().setQuiet(false);
    expect(s()).toMatchObject({ view: "board", quiet: false });
  });
});

const workspace = (id: string): WorkspaceState =>
  ({
    workspace: { id, name: id, orchestratorThreadId: `orch-${id}` },
  }) as unknown as WorkspaceState;

describe("viewWorkspace", () => {
  const all = [workspace("api"), workspace("billing")];

  it("is the thread's own, else the one shown last, else the first", () => {
    expect(viewWorkspace({ workspaceId: "billing" } as never, all, "api")?.workspace.id).toBe(
      "billing",
    );
    expect(viewWorkspace(undefined, all, "billing")?.workspace.id).toBe("billing");
    expect(viewWorkspace({}, all, "gone")?.workspace.id).toBe("api");
    expect(viewWorkspace(undefined, [], "api")).toBeUndefined();
  });
});

const summary = (
  id: string,
  thread: Partial<ThreadSummary["thread"]>,
  lastActivityAt: number,
  status: ThreadSummary["status"] = "idle",
): ThreadSummary =>
  ({
    thread: { id, title: id, projectId: "p", parked: false, lastActivityAt, ...thread },
    status,
    pendingRequests: [],
  }) as unknown as ThreadSummary;

const ids = (list: readonly ThreadSummary[]) => list.map((each) => each.thread.id);

describe("soloThreads", () => {
  it("lists the threads outside every workspace, unparked, latest first", () => {
    const threads = [
      summary("readme", {}, 3),
      summary("deps", {}, 5),
      summary("parked", { parked: true }, 9),
      summary("orch", { role: "orchestrator", workspaceId: "api" } as never, 8),
      summary("worker", { workspaceId: "api", spawnedBy: { threadId: "orch" } } as never, 7),
      // A workspace that was removed leaves its threads outside any.
      summary("left", { role: "orchestrator", workspaceId: "gone" } as never, 1),
    ];
    expect(soloThreads(threads, new Set(["api"])).map((each) => each.thread.id)).toEqual([
      "deps",
      "readme",
      "left",
    ]);
    // The parked one is under the folded Parked line instead.
    expect(parkedSoloThreads(threads, new Set(["api"])).map((each) => each.thread.id)).toEqual([
      "parked",
    ]);
  });

  it("folds done threads under Done, until they work or ask again", () => {
    const done = { completedAt: 1, completedReason: "user" } as const;
    const threads = [
      summary("open", {}, 4),
      summary("done", done, 3),
      summary("resumed", done, 2, "running"),
      summary("asking", done, 1, "needsApproval"),
      summary("pinned", { ...done, pinned: true }, 6),
      summary("parked", { ...done, parked: true }, 5),
    ];
    // What needs you leads, however old.
    expect(ids(soloThreads(threads, new Set()))).toEqual(["asking", "pinned", "open", "resumed"]);
    expect(ids(doneSoloThreads(threads, new Set()))).toEqual(["done"]);
    expect(ids(parkedSoloThreads(threads, new Set()))).toEqual(["parked"]);
  });

  it("folds snoozed threads under Snoozed, soonest back first, and never settles them", () => {
    const DAY = 86_400_000;
    const now = Date.UTC(2026, 10, 7, 12);
    const threads = [
      summary("open", {}, now),
      summary("tomorrow", { snoozedUntil: now + DAY }, now - 30 * DAY),
      summary("tonight", { snoozedUntil: now + 6 * 3_600_000 }, now),
      summary("done", { snoozedUntil: now + DAY, completedAt: 1, completedReason: "user" }, now),
      // Archived wins: it stays under Archived.
      summary("parked", { snoozedUntil: now + DAY, parked: true }, now),
    ];
    expect(ids(soloThreads(threads, new Set(), { now, days: 7 }))).toEqual(["open"]);
    expect(ids(snoozedSoloThreads(threads, new Set()))).toEqual(["tonight", "tomorrow", "done"]);
    expect(ids(doneSoloThreads(threads, new Set()))).toEqual([]);
    expect(ids(parkedSoloThreads(threads, new Set()))).toEqual(["parked"]);
    // Snoozed past the settle rule's days, it isn't History's yet: it comes back.
    expect(inHistory(threads[1]!, { now, days: 7 })).toBe(false);
  });

  it("settles a thread idle past the rule's days into History, unless it is kept", () => {
    // A pinned clock: the rule's `now`, never Date.now().
    const DAY = 86_400_000;
    const now = Date.UTC(2026, 10, 7, 12);
    const rule = { now, days: 7 };
    const threads = [
      summary("fresh", {}, now - 6 * DAY),
      summary("stale", {}, now - 8 * DAY),
      summary("pinned", { pinned: true }, now - 30 * DAY),
      summary("unread", { unread: true }, now - 30 * DAY),
      summary("asking", {}, now - 30 * DAY, "needsInput"),
      summary("running", {}, now - 30 * DAY, "running"),
    ];
    expect(ids(soloThreads(threads, new Set(), rule))).toEqual([
      "asking",
      "fresh",
      "pinned",
      "unread",
      "running",
    ]);
    expect(threads.filter((each) => inHistory(each, rule)).map((each) => each.thread.id)).toEqual([
      "stale",
    ]);
    // Turned off, nothing idle settles; without a rule, nothing does.
    expect(ids(soloThreads(threads, new Set(), { now, days: 0 }))).toContain("stale");
    expect(ids(soloThreads(threads, new Set()))).toContain("stale");
    // New activity brings it back.
    expect(ids(soloThreads(threads, new Set(), { now: now - 2 * DAY, days: 7 }))).toContain(
      "stale",
    );
  });
});
