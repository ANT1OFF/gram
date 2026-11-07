// @vitest-environment happy-dom
import type { Thread, ThreadId, ThreadSummary } from "@gram/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { currentWindow } from "@/desktop/window-identity";
import { useDraftStore } from "@/stores/drafts";
import { EMPTY_GRID, useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import {
  BESIDE_WIDTH,
  besideShown,
  besideToggle,
  checkRestored,
  closeBeside,
  keepBeside,
  openBesideFrom,
  useBesideStore,
} from "./beside-store";

const ORCH = "t-orch" as ThreadId;
const WORKER = "t-worker" as ThreadId;
const PLAIN = "t-plain" as ThreadId;

const summary = (id: ThreadId, patch: Partial<Thread> = {}) =>
  ({
    thread: { id, title: id, ...patch },
    status: "running",
    pendingRequests: [],
  }) as unknown as ThreadSummary;

beforeEach(() => {
  // Focus moves on the next frame, which a node test doesn't have.
  vi.stubGlobal("requestAnimationFrame", () => 0);
  useThreadsStore.setState({
    byId: {
      [ORCH]: summary(ORCH, { role: "orchestrator" }),
      [WORKER]: summary(WORKER, { spawnedBy: { threadId: ORCH, feature: "f" } }),
      [PLAIN]: summary(PLAIN),
    },
  });
  useLayoutStore.getState().setGrid({ ...EMPTY_GRID, panes: [WORKER] });
  useBesideStore.setState({
    worker: undefined,
    last: undefined,
    tab: "thread",
    shown: false,
    focused: false,
    before: undefined,
    widenedFrom: undefined,
    restored: false,
  });
  useLayoutStore.setState({
    panelOpen: false,
    panelPeek: false,
    panelExpanded: false,
    panelWidth: 352,
    reviewFocus: false,
    focusMode: false,
    threadInView: true,
    windowWidth: 1600,
  });
  useDraftStore.setState({ text: {} });
});

describe("open beside", () => {
  it("puts the orchestrator in the worker's pane and the worker in the Thread tab, sending nothing", () => {
    const open = vi.fn((threadId: ThreadId) => useLayoutStore.getState().openThread(threadId));
    expect(keepBeside(WORKER, open)).toBe(true);
    expect(open).toHaveBeenCalledWith(ORCH);
    expect(useLayoutStore.getState().grid.panes).toEqual([ORCH]);
    expect(useBesideStore.getState()).toMatchObject({ worker: WORKER, last: WORKER, shown: true });
    // The worker opens on its conversation, in a panel shown for it.
    expect(useBesideStore.getState().tab).toBe("thread");
    expect(besideShown(useBesideStore.getState())).toBe(WORKER);
    expect(useLayoutStore.getState().panelOpen).toBe(true);
    // Opening only moves views: no draft is written for either thread, and it takes no API at all,
    // so it has no way to send to the worker or hold it.
    expect(useDraftStore.getState().text).toEqual({});
    expect(keepBeside.length).toBe(2);
  });

  it("toggles on ⌘\\: close, open the focused worker, bring the last one back, else split", () => {
    expect(besideToggle(WORKER)).toBe(WORKER);
    expect(besideToggle(PLAIN)).toBeUndefined();
    expect(besideToggle(ORCH)).toBeUndefined();
    keepBeside(WORKER, (threadId) => useLayoutStore.getState().openThread(threadId));
    expect(besideToggle(ORCH)).toBe("close");
    closeBeside();
    expect(useBesideStore.getState().worker).toBeUndefined();
    expect(besideToggle(ORCH)).toBe(WORKER);
    expect(besideToggle(PLAIN)).toBeUndefined();
  });

  it("shows the worker again on ⌘\\ while the panel is on another of its tabs", () => {
    keepBeside(WORKER, (threadId) => useLayoutStore.getState().openThread(threadId));
    useBesideStore.getState().setShown(false);
    expect(besideShown(useBesideStore.getState())).toBeUndefined();
    expect(besideToggle(ORCH)).toBe(WORKER);
  });

  it("puts the panel back as it stood when opening showed it", () => {
    keepBeside(WORKER, (threadId) => useLayoutStore.getState().openThread(threadId));
    expect(useLayoutStore.getState().panelOpen).toBe(true);
    expect(useLayoutStore.getState().panelWidth).toBe(BESIDE_WIDTH);
    closeBeside();
    expect(useLayoutStore.getState()).toMatchObject({ panelOpen: false, panelPeek: false });
    // As wide as a conversation needs while it shows, and back to the width it had after.
    expect(useLayoutStore.getState().panelWidth).toBe(352);
    // Open already, it stays open.
    useLayoutStore.setState({ panelOpen: true });
    keepBeside(WORKER, (threadId) => useLayoutStore.getState().openThread(threadId));
    closeBeside();
    expect(useLayoutStore.getState().panelOpen).toBe(true);
  });

  it("opens a worker linked from its orchestrator's chat, and no other thread", () => {
    expect(openBesideFrom(ORCH, PLAIN)).toBe(false);
    expect(openBesideFrom(PLAIN, WORKER)).toBe(false);
    expect(useBesideStore.getState().worker).toBeUndefined();
    expect(openBesideFrom(ORCH, WORKER)).toBe(true);
    expect(besideShown(useBesideStore.getState())).toBe(WORKER);
    // The chat stays where it is, and nothing is drafted for either thread.
    expect(useLayoutStore.getState().grid.panes).toEqual([WORKER]);
    expect(useDraftStore.getState().text).toEqual({});
  });

  it("does nothing for a thread that isn't a worker", () => {
    const open = vi.fn();
    expect(keepBeside(PLAIN, open)).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(useBesideStore.getState().worker).toBeUndefined();
  });
});

describe("open beside across a reload", () => {
  const key = useBesideStore.persist.getOptions().name ?? "";
  const reload = async (stored: object) => {
    sessionStorage.setItem(key, JSON.stringify({ state: stored, version: 1 }));
    await useBesideStore.persist.rehydrate();
  };
  const stored = (): Record<string, unknown> | undefined =>
    (JSON.parse(sessionStorage.getItem(key) ?? "null") as { state?: Record<string, unknown> })
      ?.state;

  it("is kept per window, under this window's id, with the worker and its view", () => {
    expect(key).toBe(`gram.beside.${currentWindow().id}`);
    keepBeside(WORKER, (threadId) => useLayoutStore.getState().openThread(threadId));
    useBesideStore.getState().setTab("terminal");
    expect(stored()).toEqual({ worker: WORKER, last: WORKER, tab: "terminal", shown: true });
  });

  it("comes back, on its tab, while the worker still reports to the orchestrator in view", async () => {
    useLayoutStore.getState().setGrid({ ...EMPTY_GRID, panes: [ORCH] });
    await reload({ worker: WORKER, last: WORKER, tab: "changes" });
    // Not shown until checked against the loaded thread list.
    expect(useBesideStore.getState()).toMatchObject({ worker: WORKER, restored: true });
    checkRestored(undefined);
    expect(useBesideStore.getState()).toMatchObject({
      worker: WORKER,
      tab: "changes",
      restored: false,
    });
  });

  it("counts the route's thread as in view before its pane is filled", async () => {
    useLayoutStore.getState().setGrid(EMPTY_GRID);
    await reload({ worker: WORKER, tab: "log" });
    checkRestored(ORCH);
    // The read-only dock's Log is the Thread view now.
    expect(useBesideStore.getState()).toMatchObject({
      worker: WORKER,
      tab: "thread",
      restored: false,
    });
  });

  it("is dropped when its orchestrator isn't in view", async () => {
    useLayoutStore.getState().setGrid({ ...EMPTY_GRID, panes: [PLAIN] });
    await reload({ worker: WORKER, last: WORKER, tab: "terminal" });
    checkRestored(PLAIN);
    expect(useBesideStore.getState()).toMatchObject({ worker: undefined, restored: false });
    expect(stored()?.["worker"]).toBeUndefined();
  });

  it("is dropped when the worker is gone or no longer a worker", async () => {
    useLayoutStore.getState().setGrid({ ...EMPTY_GRID, panes: [ORCH] });
    await reload({ worker: "t-gone", tab: "log" });
    checkRestored(ORCH);
    expect(useBesideStore.getState().worker).toBeUndefined();
    await reload({ worker: PLAIN, tab: "log" });
    checkRestored(ORCH);
    expect(useBesideStore.getState().worker).toBeUndefined();
  });

  it("ignores a malformed record, and leaves one opened this session alone", async () => {
    await reload({ worker: 7, tab: "shell" });
    expect(useBesideStore.getState()).toMatchObject({
      worker: undefined,
      tab: "thread",
      restored: false,
    });
    keepBeside(WORKER, (threadId) => useLayoutStore.getState().openThread(threadId));
    useLayoutStore.getState().setGrid({ ...EMPTY_GRID, panes: [PLAIN] });
    checkRestored(PLAIN);
    expect(useBesideStore.getState().worker).toBe(WORKER);
  });
});
