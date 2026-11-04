// @vitest-environment happy-dom
import type {
  FinishedWorker,
  FinishedWorkersCursor,
  FinishedWorkersPage,
  ThreadId,
  WorkspaceId,
} from "@gram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { ApiProvider } from "@/api/context";
import type { Api } from "@/api/types";

import { useFinishedWorkerPages } from "./use-finished-workers";

const WS = "w1" as WorkspaceId;
const IDS = [WS];

const worker = (n: number): FinishedWorker => ({
  threadId: `t-${n}` as ThreadId,
  workspaceId: WS,
  title: `Worker ${n}`,
  feature: "f",
  closedAt: 1_000_000 - n,
  prs: [],
  kept: "archived",
});

afterEach(cleanup);

describe("useFinishedWorkerPages", () => {
  it("keeps the rows it has while the next page loads", async () => {
    // Each page is two workers; the second waits until the test lets it through.
    let release: (() => void) | undefined;
    const finishedWorkersPage = (_id: WorkspaceId, after?: FinishedWorkersCursor) => {
      const start = after === undefined ? 0 : Number(after.threadId.slice(2)) + 1;
      const page: FinishedWorkersPage = {
        workers: [worker(start), worker(start + 1)],
        ...(start < 2 ? { next: { at: 1_000_000 - start - 1, threadId: `t-${start + 1}` } } : {}),
      };
      if (start === 0) return Promise.resolve(page);
      return new Promise<FinishedWorkersPage>((resolve) => {
        release = () => resolve(page);
      });
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ApiProvider api={{ finishedWorkersPage } as unknown as Api}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </ApiProvider>
    );
    const seen: (number | undefined)[] = [];
    const { result } = renderHook(
      () => {
        const pages = useFinishedWorkerPages(IDS);
        seen.push(pages.finished.get(WS)?.length);
        return pages;
      },
      { wrapper },
    );
    await waitFor(() => expect(result.current.finished.get(WS)).toHaveLength(2));
    expect(result.current.horizons.get(WS)).toBe(999_999);

    seen.length = 0;
    act(() => result.current.loadMore(WS));
    await waitFor(() => expect(release).toBeDefined());
    // Loading: the first page's rows and horizon stay, and it says it is busy.
    expect(result.current.finished.get(WS)).toHaveLength(2);
    expect(result.current.horizons.get(WS)).toBe(999_999);
    expect(result.current.busy).toBe(true);

    act(() => release!());
    await waitFor(() => expect(result.current.finished.get(WS)).toHaveLength(4));
    expect(result.current.horizons.has(WS)).toBe(false);
    expect(result.current.busy).toBe(false);
    // Never a render without the rows already read.
    expect(seen.every((length) => length !== undefined && length >= 2)).toBe(true);
  });
});
