// @vitest-environment happy-dom
import type { PrStatus, ThreadId, ThreadSummary } from "@gram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiProvider } from "@/api/context";
import type { Api } from "@/api/types";
import { useThreadsStore } from "@/stores/threads";

import { PREWARM_DWELL_MS, usePrDetailPrewarm } from "./use-pr-detail-prewarm";

const pr: PrStatus = {
  number: 7,
  state: "OPEN",
  url: "https://github.com/example/api/pull/7",
  title: "t",
  isDraft: false,
  checks: "pending",
  headMatches: true,
  aheadOfPr: false,
  updatedAt: "2026-09-16T10:00:00Z",
};

const KEY = ["git.prDetail", "a", "example/api#7:2026-09-16T10:00:00Z:pending"];

const summary = (id: string, withPr: boolean) =>
  ({
    status: "idle",
    pendingRequests: [],
    queue: [],
    thread: { id },
    ...(withPr ? { git: { pr } } : {}),
  }) as unknown as ThreadSummary;

const setup = (threadId: string) => {
  const prDetail = vi.fn(async () => ({ available: true }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApiProvider api={{ prDetail } as unknown as Api}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </ApiProvider>
  );
  const hook = renderHook(() => usePrDetailPrewarm(threadId as ThreadId), { wrapper });
  return { prDetail, client, handlers: hook.result.current, unmount: hook.unmount };
};

beforeEach(() => {
  vi.useFakeTimers();
  useThreadsStore.setState({
    byId: { a: summary("a", true), b: summary("b", false) } as never,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useThreadsStore.setState({ byId: {} as never });
});

describe("usePrDetailPrewarm", () => {
  it("fetches nothing on mount, and the panel's cache entry once the pointer rests", async () => {
    const { prDetail, client, handlers } = setup("a");
    await vi.advanceTimersByTimeAsync(PREWARM_DWELL_MS * 2);
    expect(prDetail).not.toHaveBeenCalled();

    handlers.onPointerEnter();
    await vi.advanceTimersByTimeAsync(PREWARM_DWELL_MS - 1);
    expect(prDetail).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(prDetail).toHaveBeenCalledExactlyOnceWith("a");
    expect(client.getQueryData(KEY)).toEqual({ available: true });
  });

  it("fetches on keyboard focus too", async () => {
    const { prDetail, handlers } = setup("a");
    handlers.onFocus();
    await vi.advanceTimersByTimeAsync(PREWARM_DWELL_MS);
    expect(prDetail).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("fetches nothing when the pointer or focus moves on, or the opener unmounts, first", async () => {
    const { prDetail, handlers, unmount } = setup("a");
    handlers.onPointerEnter();
    await vi.advanceTimersByTimeAsync(PREWARM_DWELL_MS - 1);
    handlers.onPointerLeave();
    handlers.onFocus();
    handlers.onBlur();
    handlers.onPointerEnter();
    unmount();
    await vi.advanceTimersByTimeAsync(PREWARM_DWELL_MS * 2);
    expect(prDetail).not.toHaveBeenCalled();
  });

  it("asks once for a PR rested on again while the detail is fresh", async () => {
    const { prDetail, handlers } = setup("a");
    handlers.onPointerEnter();
    await vi.advanceTimersByTimeAsync(PREWARM_DWELL_MS);
    handlers.onPointerLeave();
    handlers.onPointerEnter();
    await vi.advanceTimersByTimeAsync(PREWARM_DWELL_MS);
    expect(prDetail).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    handlers.onPointerEnter();
    await vi.advanceTimersByTimeAsync(PREWARM_DWELL_MS);
    expect(prDetail).toHaveBeenCalledTimes(2);
  });

  it("fetches nothing for a thread without a PR", async () => {
    const { prDetail, handlers } = setup("b");
    handlers.onPointerEnter();
    await vi.advanceTimersByTimeAsync(PREWARM_DWELL_MS);
    expect(prDetail).not.toHaveBeenCalled();
  });
});
