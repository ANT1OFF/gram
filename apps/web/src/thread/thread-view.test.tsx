// @vitest-environment happy-dom
import { ThreadNotFound, type ThreadId } from "@gram/contracts";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockApi, type MockApi } from "@/api/mock";
import { renderWithApi } from "@/panels/test-utils";
import { feedMessages } from "@/stores/feeds";
import { useThreadsStore } from "@/stores/threads";

import { pendingRestartHint } from "@/composer/pending-restart";

import { ThreadView } from "./thread-view";

// NumberFlow's custom element doesn't upgrade in happy-dom, so an animated ticker throws on update.
vi.mock("@/motion/number-ticker", () => ({
  NumberTicker: ({ value }: { value: number }) => <span>{value}</span>,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: ReactNode }) => children,
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));

const FLAKY = "t-flaky" as ThreadId;
let api: MockApi;

beforeEach(async () => {
  api = createMockApi({ speed: 0, autoplay: false });
  const abort = new AbortController();
  for await (const event of api.events(abort.signal)) {
    useThreadsStore.getState().applyEvent(event);
    if (event.type === "threads.snapshot") break;
  }
  abort.abort();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ThreadView usage ring", () => {
  it("shows the summary's usage when the feed has none, across a resubscribe", async () => {
    const DOCS = "t-docs" as ThreadId;
    useThreadsStore.getState().applyEvent({
      type: "thread.usage",
      threadId: DOCS,
      usage: {
        tokens: { inputTokens: 42_000, outputTokens: 1_200 },
        contextWindow: 200_000,
        contextTokens: 43_000,
      },
    });
    renderWithApi(<ThreadView threadId={DOCS} focused={false} />, api);
    expect((await screen.findByTestId("usage-ring")).getAttribute("aria-label")).toBe(
      "Usage: 22% of the context window",
    );
    cleanup();

    // A remount subscribes to the feed again, which starts over from the stored messages.
    renderWithApi(<ThreadView threadId={DOCS} focused={false} />, api);
    expect((await screen.findByTestId("usage-ring")).getAttribute("aria-label")).toBe(
      "Usage: 22% of the context window",
    );
  });

  it("follows the hub's usage while the turn is still running", async () => {
    const DOCS = "t-docs" as ThreadId;
    const apply = (contextTokens: number) =>
      useThreadsStore.getState().applyEvent({
        type: "thread.usage",
        threadId: DOCS,
        usage: {
          tokens: { inputTokens: contextTokens, outputTokens: 100 },
          contextWindow: 200_000,
          contextTokens,
        },
      });
    apply(20_000);
    renderWithApi(<ThreadView threadId={DOCS} focused={false} />, api);
    const ring = await screen.findByTestId("usage-ring");
    expect(ring.getAttribute("aria-label")).toBe("Usage: 10% of the context window");

    act(() => apply(120_000));
    expect(ring.getAttribute("aria-label")).toBe("Usage: 60% of the context window");
  });
});

describe("ThreadView startup explanation", () => {
  it("announces the full starting explanation and clears it when absent or no longer starting", async () => {
    const DOCS = "t-docs" as ThreadId;
    const detail =
      "Waiting for the previous Codex server to exit. Other sessions can keep working.";
    const apply = (status: "starting" | "running", explanation?: string) =>
      useThreadsStore.getState().applyEvent({
        type: "thread.status",
        threadId: DOCS,
        status,
        ...(explanation === undefined ? {} : { detail: explanation }),
      });
    renderWithApi(<ThreadView threadId={DOCS} focused={false} />, api);
    await screen.findByTestId("thread-view");
    expect(screen.queryByTestId("thread-starting-detail")).toBeNull();
    act(() => apply("starting", detail));
    const explanation = await screen.findByTestId("thread-starting-detail");
    expect(explanation.textContent).toBe(detail);
    expect(explanation.getAttribute("role")).toBe("status");
    expect(explanation.getAttribute("aria-live")).toBe("polite");
    act(() => apply("starting"));
    expect(screen.queryByTestId("thread-starting-detail")).toBeNull();
    act(() => apply("starting", detail));
    expect(screen.getByTestId("thread-starting-detail").textContent).toBe(detail);
    act(() => apply("running", detail));
    expect(screen.queryByTestId("thread-starting-detail")).toBeNull();
  });
});

describe("ThreadView pending restart", () => {
  it("shows a quiet glyph while a restart waits, saying what it waits for", async () => {
    const DOCS = "t-docs" as ThreadId;
    const { applyEvent } = useThreadsStore.getState();
    applyEvent({ type: "thread.pendingRestart", threadId: DOCS, reason: "mcpConfig" });
    renderWithApi(<ThreadView threadId={DOCS} focused={false} />, api);
    const glyph = await screen.findByTestId("pending-restart");
    expect(glyph.getAttribute("aria-label")).toBe("Restart pending: MCP config changed");
    expect(pendingRestartHint(useThreadsStore.getState().byId[DOCS])).toContain(
      "once this turn and the queue are done",
    );
    act(() =>
      applyEvent({
        type: "thread.background",
        threadId: DOCS,
        tasks: [{ taskId: "b1", kind: "shell", description: "Run the checks", startedAt: 1 }],
      }),
    );
    expect(pendingRestartHint(useThreadsStore.getState().byId[DOCS])).toContain(
      "once its background tasks finish",
    );

    act(() => applyEvent({ type: "thread.pendingRestart", threadId: DOCS }));
    expect(screen.queryByTestId("pending-restart")).toBeNull();
    expect(pendingRestartHint(useThreadsStore.getState().byId[DOCS])).toBeUndefined();
  });
});

describe("ThreadView of a thread the server doesn't have", () => {
  it("says it's gone instead of loading or reconnecting", async () => {
    const GONE = "t-gone" as ThreadId;
    const { thread } = useThreadsStore.getState().byId["t-docs"]!;
    useThreadsStore
      .getState()
      .applyEvent({ type: "thread.upsert", thread: { ...thread, id: GONE } });
    renderWithApi(<ThreadView threadId={GONE} focused={false} />, api);

    expect(await screen.findByTestId("thread-gone")).toBeTruthy();
    expect(screen.queryByTestId("thread-view")).toBeNull();
    expect(api.connection.get().status).not.toBe("reconnecting");
  });

  it("subscribes again when a closed thread is reopened under its id", async () => {
    const DARK = "t-dark" as ThreadId;
    const abort = new AbortController();
    void (async () => {
      for await (const event of api.events(abort.signal)) {
        act(() => useThreadsStore.getState().applyEvent(event));
      }
    })();
    renderWithApi(<ThreadView threadId={DARK} focused={false} />, api);
    await screen.findByTestId("thread-view");
    await vi.waitFor(() => expect(feedMessages(DARK).length).toBeGreaterThan(0));

    // The server's feed of a closed thread goes quiet; a resubscription is what fails.
    api.simulateDisconnect();
    await api.closeThread(DARK);
    expect(await screen.findByTestId("thread-gone")).toBeTruthy();
    await vi.waitFor(
      () => {
        api.connection.retryNow();
        expect(feedMessages(DARK)).toEqual([]);
      },
      { timeout: 5000 },
    );

    await api.reopenClosedThread();
    expect(await screen.findByTestId("thread-view")).toBeTruthy();
    abort.abort();
  }, 15_000);

  it("subscribes again on a snapshot that has the thread back, removal unseen", async () => {
    const DEPS = "t-deps" as ThreadId;
    renderWithApi(<ThreadView threadId={DEPS} focused={false} />, api);
    await screen.findByTestId("thread-view");
    await vi.waitFor(() => expect(feedMessages(DEPS).length).toBeGreaterThan(0));

    // Closed and reopened elsewhere while this window's event stream was down.
    api.simulateDisconnect();
    await api.closeThread(DEPS);
    await vi.waitFor(
      () => {
        api.connection.retryNow();
        expect(screen.queryByTestId("thread-gone")).not.toBeNull();
      },
      { timeout: 5000 },
    );
    await api.reopenClosedThread();

    const abort = new AbortController();
    for await (const event of api.events(abort.signal)) {
      act(() => useThreadsStore.getState().applyEvent(event));
      if (event.type === "threads.snapshot") break;
    }
    abort.abort();
    expect(await screen.findByTestId("thread-view")).toBeTruthy();
  }, 15_000);

  it("subscribes again when the reopened thread's summary beat the refusal", async () => {
    const PLAN = "t-plan" as ThreadId;
    const { thread } = useThreadsStore.getState().byId[PLAN]!;
    let refused = false;
    const racing = Object.assign(Object.create(api) as MockApi, {
      threadFeed: (threadId: ThreadId, signal: AbortSignal) => {
        if (refused) return api.threadFeed(threadId, signal);
        refused = true;
        return {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              useThreadsStore
                .getState()
                .applyEvent({ type: "thread.upsert", thread: { ...thread } });
              throw new ThreadNotFound({ threadId });
            },
          }),
        };
      },
    });
    renderWithApi(<ThreadView threadId={PLAN} focused={false} />, racing);
    expect(await screen.findByTestId("thread-view")).toBeTruthy();
    await vi.waitFor(() => expect(feedMessages(PLAN).length).toBeGreaterThan(0));
  });

  it("says it's gone once the thread list no longer has it", async () => {
    renderWithApi(<ThreadView threadId={"t-removed" as ThreadId} focused={false} />, api);
    expect(await screen.findByTestId("thread-gone")).toBeTruthy();
  });
});

describe("ThreadView header", () => {
  it("shows the thread's pending wakes on a chip whose list cancels one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 8, 12, 0));
    const DOCS = "t-docs" as ThreadId;
    const at = Date.now() + 45 * 60_000;
    api.simulateThreadWake({ id: "w1", threadId: DOCS, at, note: "check the canary", setAt: 1 });
    api.simulateThreadWake({ id: "w2", threadId: FLAKY, at, note: "another thread's", setAt: 1 });
    renderWithApi(<ThreadView threadId={DOCS} focused={false} />, api);

    const chip = await screen.findByTestId("pane-wake");
    expect(chip.getAttribute("title")).toBe("Wakes at 12:45: check the canary");
    act(() => chip.click());
    const popup = await screen.findByTestId("pane-wake-popup");
    expect(popup.textContent).toContain("check the canary");
    expect(popup.textContent).not.toContain("another thread's");
    act(() => screen.getByRole("button", { name: /^Cancel the wake at / }).click());
    await vi.waitFor(async () =>
      expect((await api.listThreadWakes()).wakes.map((wake) => wake.id)).toEqual(["w2"]),
    );
  });

  it("labels a wake on the viewer's day by its time and one after midnight by its weekday", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 8, 23, 30));
    const DOCS = "t-docs" as ThreadId;
    api.simulateThreadWake({
      id: "w1",
      threadId: DOCS,
      at: new Date(2026, 9, 8, 23, 45).getTime(),
      note: "tonight",
      setAt: 1,
    });
    api.simulateThreadWake({
      id: "w2",
      threadId: DOCS,
      at: new Date(2026, 9, 9, 0, 3).getTime(),
      note: "tomorrow",
      setAt: 1,
    });
    renderWithApi(<ThreadView threadId={DOCS} focused={false} />, api);

    const chip = await screen.findByTestId("pane-wake");
    expect(chip.getAttribute("title")).toBe(
      "Wakes at 23:45: tonight\nWakes at Fri 00:03: tomorrow",
    );
    expect(chip.getAttribute("aria-label")).toBe("2 wakes pending, the first at 23:45");
  });

  it("names a Codex thread's agent on the composer's model picker, not in the header", async () => {
    const { thread } = useThreadsStore.getState().byId[FLAKY]!;
    useThreadsStore.getState().applyEvent({
      type: "thread.upsert",
      thread: { ...thread, mode: "default", model: { agent: "codex", model: "gpt-5.5" } },
    });
    renderWithApi(<ThreadView threadId={FLAKY} focused={false} />, api);

    const header = await screen.findByTestId("pane-header");
    expect(header.textContent).not.toContain("Codex");
    const picker = screen.getByRole("combobox", { name: "Model" });
    expect(picker.getAttribute("aria-description")).toBe("Codex");
    expect(picker.getAttribute("title")).toMatch(/^Codex · Model/);
  });

  it("titles an orchestrator by its workspace even with workspaces off, with no branch in its header", async () => {
    const DOCS = "t-docs" as ThreadId;
    const { thread } = useThreadsStore.getState().byId[DOCS]!;
    useThreadsStore.getState().applyEvent({
      type: "thread.upsert",
      thread: { ...thread, role: "orchestrator", title: "Orchestrator · api" },
    });
    renderWithApi(<ThreadView threadId={DOCS} focused={false} />, api);

    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading.getAttribute("aria-label")).toBe("Orchestrator: api");
    expect(heading.textContent).not.toContain("Orchestrator ·");
    expect(screen.queryByTestId("branch-chip")).toBeNull();
  });

  it("names the thread's label and tints the header with it", async () => {
    const [label] = await api.labels();
    const { thread } = useThreadsStore.getState().byId[FLAKY]!;
    useThreadsStore.getState().applyEvent({
      type: "thread.upsert",
      thread: { ...thread, labels: [label!.id] },
    });
    renderWithApi(<ThreadView threadId={FLAKY} focused={false} />, api);

    expect((await screen.findByTestId("pane-label")).textContent).toContain(label!.name);
    expect(screen.getByTestId("pane-header").dataset["labelTint"]).toBe(label!.name);
  });

  it("leaves pushing to the PR panel, with no push button of its own", async () => {
    renderWithApi(<ThreadView threadId={"t-dark" as ThreadId} focused={false} />, api);
    await screen.findByTestId("pane-header");
    expect(screen.queryByTestId("push-button")).toBeNull();
  });

  it("keeps the branch out of the header and its thread menu", async () => {
    for (const threadId of [FLAKY, "t-docs" as ThreadId]) {
      renderWithApi(<ThreadView threadId={threadId} focused={false} />, api);
      // The agents' working detail: More…, ⌘K on the thread, has it to copy and push.
      expect(within(screen.getByTestId("pane-header")).queryByTestId("branch-chip")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Thread menu" }));
      const menu = await screen.findByTestId("thread-menu");
      await within(menu).findByRole("menuitem", { name: "More…" });
      expect(within(menu).queryByTestId("branch-chip")).toBeNull();
      cleanup();
    }
  });
});
