// @vitest-environment happy-dom
import type { ProjectId, Thread, ThreadId, ThreadStatus } from "@gram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiProvider } from "@/api/context";
import type { Api, ApiServerEvent } from "@/api/types";

import { useServerEvents } from "./feeds";
import { useThreadsStore } from "./threads";

// The event feed as the shell mounts it, against a server whose events the test pushes in bursts:
// a burst must reach the stores whole and in order, and React must render it once, not once per
// event.

const thread = (id: string, title = id, createdAt = 0): Thread => ({
  id: id as ThreadId,
  projectId: "p" as ProjectId,
  title,
  userNamed: false,
  model: { agent: "claude", model: "opus" },
  mode: "default",
  checkout: { kind: "main", path: "/" },
  labels: [],
  pinned: false,
  parked: false,
  unread: false,
  createdAt,
  lastActivityAt: 0,
});

/** A server whose event feed the test fills; `burst` delivers events back to back. */
const fakeServer = () => {
  const queued: ApiServerEvent[] = [];
  let wake: (() => void) | undefined;
  const api = {
    events: async function* (signal: AbortSignal) {
      while (!signal.aborted) {
        const next = queued.shift();
        if (next !== undefined) yield next;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  } as unknown as Api;
  return {
    api,
    burst: (events: readonly ApiServerEvent[]) => {
      queued.push(...events);
      wake?.();
    },
  };
};

/** The sidebar's shape: one component reading the whole thread map. */
function Sidebar() {
  const byId = useThreadsStore((s) => s.byId);
  return <span data-testid="rows">{Object.keys(byId).length}</span>;
}

function Shell() {
  useServerEvents();
  return <Sidebar />;
}

const mount = (api: Api) => {
  let commits = 0;
  const client = new QueryClient();
  const view = render(
    <ApiProvider api={api}>
      <QueryClientProvider client={client}>
        <Profiler id="sidebar" onRender={() => commits++}>
          <Shell />
        </Profiler>
      </QueryClientProvider>
    </ApiProvider>,
  );
  return { view, commits: () => commits };
};

/** Thread `a`'s status, as its turn moves. */
const status = (s: ThreadStatus) =>
  ({ type: "thread.status", threadId: "a" as ThreadId, status: s }) as const;

const reset = () =>
  useThreadsStore.getState().applyEvent({ type: "threads.snapshot", threads: [] });

beforeEach(() => {
  reset();
  // Renders as the app's do, outside `act`, which would batch them all whatever the feed did.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

afterEach(() => {
  cleanup();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe("server events", () => {
  it("renders 150 threads arriving at once in a frame, not one commit each", async () => {
    const server = fakeServer();
    const { view, commits } = mount(server.api);
    const before = commits();
    server.burst(
      Array.from({ length: 150 }, (_, i) => ({
        type: "thread.upsert" as const,
        thread: thread(`t${i}`),
      })),
    );
    await waitFor(() => expect(view.getByTestId("rows").textContent).toBe("150"));
    // One a frame: the whole burst normally lands in one, at most a couple on a slow runner. Each
    // event committing on its own was 150.
    expect(commits() - before).toBeLessThanOrEqual(3);
  });

  it("applies a burst in order: created then updated, deleted then re-added", async () => {
    const server = fakeServer();
    const { view } = mount(server.api);
    server.burst([
      { type: "thread.upsert", thread: thread("a", "first") },
      { type: "thread.upsert", thread: thread("a", "renamed") },
      { type: "thread.upsert", thread: thread("b") },
      { type: "thread.removed", threadId: "b" as ThreadId },
      { type: "thread.upsert", thread: thread("c") },
      { type: "thread.removed", threadId: "c" as ThreadId },
      { type: "thread.upsert", thread: thread("c", "back", 5) },
      { type: "thread.status", threadId: "a" as ThreadId, status: "running", detail: "Reading" },
      { type: "thread.status", threadId: "a" as ThreadId, status: "running", detail: "Reading a" },
      {
        type: "thread.status",
        threadId: "a" as ThreadId,
        status: "running",
        detail: "Reading a.ts",
      },
    ]);
    await waitFor(() => expect(view.getByTestId("rows").textContent).toBe("2"));
    const { byId, statusDetail } = useThreadsStore.getState();
    expect(byId["a"]?.thread.title).toBe("renamed");
    expect(byId["b"]).toBeUndefined();
    expect(byId["c"]?.thread.title).toBe("back");
    expect(byId["c"]?.thread.createdAt).toBe(5);
    expect(byId["a"]?.status).toBe("running");
    expect(statusDetail["a"]).toBe("Reading a.ts");
  });

  it("still shows a store subscriber every step of a burst, a turn that starts and ends included", async () => {
    const server = fakeServer();
    const { view } = mount(server.api);
    server.burst([{ type: "thread.upsert", thread: thread("a") }]);
    await waitFor(() => expect(view.getByTestId("rows").textContent).toBe("1"));
    // What the composer and the recap card count turns by: each change of status as it happens.
    const seen: (ThreadStatus | undefined)[] = [];
    const unsubscribe = useThreadsStore.subscribe((s, previous) => {
      if (s.byId["a"]?.status !== previous.byId["a"]?.status) seen.push(s.byId["a"]?.status);
    });
    server.burst([status("running"), status("idle"), status("running"), status("idle")]);
    await waitFor(() => expect(seen).toHaveLength(4));
    unsubscribe();
    expect(seen).toEqual(["running", "idle", "running", "idle"]);
  });

  it("reads queries and keybindings again when the feed resubscribes, not on its first snapshot", async () => {
    const server = fakeServer();
    const getKeybindings = vi.fn(async () => ({ path: "", bindings: [], problems: [] }));
    const api = { ...server.api, getKeybindings } as unknown as Api;
    const client = new QueryClient();
    client.setQueryData(["openPrs"], []);
    render(
      <ApiProvider api={api}>
        <QueryClientProvider client={client}>
          <Shell />
        </QueryClientProvider>
      </ApiProvider>,
    );
    const stale = () => client.getQueryState(["openPrs"])?.isInvalidated;

    server.burst([
      { type: "threads.snapshot", threads: [] },
      { type: "thread.upsert", thread: thread("a") },
    ]);
    await waitFor(() => expect(useThreadsStore.getState().byId["a"]).toBeDefined());
    expect(stale()).toBe(false);
    expect(getKeybindings).not.toHaveBeenCalled();

    // A dropped socket: the openPrs.changed sent meanwhile is gone, and the new feed starts over.
    server.burst([{ type: "threads.snapshot", threads: [] }]);
    await waitFor(() => expect(stale()).toBe(true));
    expect(getKeybindings).toHaveBeenCalledTimes(1);
  });
});
