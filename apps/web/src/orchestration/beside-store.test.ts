// @vitest-environment happy-dom
import type { Thread, ThreadId, ThreadSummary } from "@gram/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { currentWindow } from "@/desktop/window-identity";
import { useDraftStore } from "@/stores/drafts";
import { EMPTY_GRID, useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import {
  besideToggle,
  checkRestored,
  closeBeside,
  keepBeside,
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
  useBesideStore.setState({ worker: undefined, last: undefined, tab: "log", restored: false });
  useDraftStore.setState({ text: {} });
});

describe("keep beside", () => {
  it("puts the orchestrator in the worker's pane and the worker in the dock, sending nothing", () => {
    const open = vi.fn((threadId: ThreadId) => useLayoutStore.getState().openThread(threadId));
    expect(keepBeside(WORKER, open)).toBe(true);
    expect(open).toHaveBeenCalledWith(ORCH);
    expect(useLayoutStore.getState().grid.panes).toEqual([ORCH]);
    expect(useBesideStore.getState()).toMatchObject({ worker: WORKER, last: WORKER });
    // Docking only moves views: no draft is written for either thread, and it takes no API at all,
    // so it has no way to send to the worker or hold it.
    expect(useDraftStore.getState().text).toEqual({});
    expect(keepBeside.length).toBe(2);
  });

  it("toggles on ⌘\\: undock, dock the focused worker, bring the last one back, else split", () => {
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

  it("does nothing for a thread that isn't a worker", () => {
    const open = vi.fn();
    expect(keepBeside(PLAIN, open)).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(useBesideStore.getState().worker).toBeUndefined();
  });
});

describe("keep beside across a reload", () => {
  const key = useBesideStore.persist.getOptions().name ?? "";
  const reload = async (stored: object) => {
    sessionStorage.setItem(key, JSON.stringify({ state: stored, version: 1 }));
    await useBesideStore.persist.rehydrate();
  };
  const stored = (): Record<string, unknown> | undefined =>
    (JSON.parse(sessionStorage.getItem(key) ?? "null") as { state?: Record<string, unknown> })
      ?.state;

  it("is kept per window, under this window's id, with the worker and the tab", () => {
    expect(key).toBe(`gram.beside.${currentWindow().id}`);
    keepBeside(WORKER, (threadId) => useLayoutStore.getState().openThread(threadId));
    useBesideStore.getState().setTab("terminal");
    expect(stored()).toEqual({ worker: WORKER, last: WORKER, tab: "terminal" });
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
    expect(useBesideStore.getState()).toMatchObject({ worker: WORKER, restored: false });
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

  it("ignores a malformed record, and leaves a dock docked this session alone", async () => {
    await reload({ worker: 7, tab: "shell" });
    expect(useBesideStore.getState()).toMatchObject({
      worker: undefined,
      tab: "log",
      restored: false,
    });
    keepBeside(WORKER, (threadId) => useLayoutStore.getState().openThread(threadId));
    useLayoutStore.getState().setGrid({ ...EMPTY_GRID, panes: [PLAIN] });
    checkRestored(PLAIN);
    expect(useBesideStore.getState().worker).toBe(WORKER);
  });
});
