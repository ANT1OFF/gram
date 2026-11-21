import type { ProjectId, ThreadId, ThreadSummary } from "@gram/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";

import { createThreadsSlice, type ThreadsState } from "@/stores/threads";

import { folderBusy } from "./preview-webrtc";

const T = "t1" as ThreadId;
const idle: ThreadSummary = {
  status: "idle",
  pendingRequests: [],
  queue: [],
  thread: {
    id: T,
    projectId: "p" as ProjectId,
    title: "t",
    userNamed: false,
    model: { agent: "claude", model: "opus" },
    mode: "default",
    checkout: { kind: "main", path: "/" },
    labels: [],
    pinned: false,
    parked: false,
    unread: false,
    createdAt: 0,
    lastActivityAt: 0,
  },
};

const thread = (id: string, path: string, status: ThreadSummary["status"] = "idle") => ({
  ...idle,
  status,
  thread: { ...idle.thread, id: id as ThreadId, checkout: { kind: "main" as const, path } },
});

afterEach(() => vi.unstubAllGlobals());

const setUp = () => {
  const setWebRtc = vi.fn(async (_threadId: string, _allowed: boolean) => true);
  vi.stubGlobal("window", { gram: { preview: { setWebRtc } } });
  const store = createStore<ThreadsState>()((set, get) => createThreadsSlice(set, get));
  const status = (threadId: string, next: ThreadSummary["status"]) =>
    store
      .getState()
      .applyEvent({ type: "thread.status", threadId: threadId as ThreadId, status: next });
  return { setWebRtc, store, status };
};

// The switch gives WebRTC to whatever serves the page's address, which any agent working in that
// folder may write.
describe("the Preview page's WebRTC switch", () => {
  it("is turned off on every status of a turn under way, and on none other", () => {
    const { setWebRtc, store, status } = setUp();
    store.getState().applyEvent({ type: "threads.snapshot", threads: [idle] });
    expect(setWebRtc).not.toHaveBeenCalled();
    status(T, "starting");
    status(T, "running");
    status(T, "needsApproval");
    expect(setWebRtc.mock.calls).toEqual([
      [T, false],
      [T, false],
      [T, false],
    ]);
    status(T, "idle");
    expect(setWebRtc).toHaveBeenCalledTimes(3);
  });

  // A turn that started while the socket was down reaches the app only in the snapshot.
  it("is turned off by a reconnect's snapshot that holds a turn under way", () => {
    const { setWebRtc, store } = setUp();
    store.getState().applyEvent({ type: "threads.snapshot", threads: [idle] });
    store
      .getState()
      .applyEvent({ type: "threads.snapshot", threads: [{ ...idle, status: "running" }] });
    expect(setWebRtc.mock.calls).toEqual([[T, false]]);
  });

  it("is turned off by a turn in any thread on the same folder, and not by one elsewhere", () => {
    const { setWebRtc, store, status } = setUp();
    store.getState().applyEvent({
      type: "threads.snapshot",
      threads: [
        thread("page", "/work/app"),
        thread("worker", "/work/app/packages/ui"),
        thread("parent", "/work"),
        thread("elsewhere", "/work/other"),
        thread("prefix", "/work/app-two"),
      ],
    });
    status("worker", "running");
    expect(setWebRtc.mock.calls.map(([id]) => id).toSorted()).toEqual(["page", "parent", "worker"]);
    expect(folderBusy(store.getState().byId, "page")).toBe(true);
    status("worker", "idle");
    setWebRtc.mockClear();
    status("elsewhere", "running");
    expect(setWebRtc.mock.calls.map(([id]) => id).toSorted()).toEqual(["elsewhere", "parent"]);
    // The toggle stays off while any thread on the page's folder works.
    expect(folderBusy(store.getState().byId, "page")).toBe(false);
    status("parent", "running");
    expect(folderBusy(store.getState().byId, "page")).toBe(true);
  });
});
