import type { ProjectId, ThreadId, ThreadSummary } from "@gram/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";

import { createThreadsSlice, type ThreadsState } from "@/stores/threads";

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

afterEach(() => vi.unstubAllGlobals());

// The switch gives WebRTC to whatever serves the page's address, which the thread's agent writes.
describe("the Preview page's WebRTC switch", () => {
  it("is turned off as the thread's agent starts a turn, once per turn", () => {
    const setWebRtc = vi.fn(async () => true);
    vi.stubGlobal("window", { gram: { preview: { setWebRtc } } });
    const store = createStore<ThreadsState>()((set, get) => createThreadsSlice(set, get));
    store.getState().applyEvent({ type: "threads.snapshot", threads: [idle] });
    const status = (next: ThreadSummary["status"]) =>
      store.getState().applyEvent({ type: "thread.status", threadId: T, status: next });

    status("starting");
    expect(setWebRtc.mock.calls).toEqual([[T, false]]);
    status("running");
    status("needsApproval");
    status("running");
    expect(setWebRtc).toHaveBeenCalledTimes(1);
    status("idle");
    expect(setWebRtc).toHaveBeenCalledTimes(1);
    status("running");
    expect(setWebRtc.mock.calls).toEqual([
      [T, false],
      [T, false],
    ]);
  });
});
