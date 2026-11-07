// @vitest-environment happy-dom
import type { ThreadId } from "@gram/contracts";
import { act, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiProvider } from "@/api/context";
import type { Api } from "@/api/types";
import { useThreadFeed } from "./feeds";

function Viewer() {
  const phase = useThreadFeed("abandoned-render" as ThreadId, (state) => state.phase);
  return <span>{phase}</span>;
}

afterEach(() => vi.useRealTimers());

describe("feed ownership", () => {
  it("does not open a socket subscription for a render that never commits", () => {
    const threadFeed = vi.fn(async function* () {});
    const api = { threadFeed } as unknown as Api;
    expect(
      renderToString(
        <ApiProvider api={api}>
          <Viewer />
        </ApiProvider>,
      ),
    ).toContain("loading");
    expect(threadFeed).not.toHaveBeenCalled();
  });
  it("holds one subscription across StrictMode commits, then releases it", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const threadFeed = vi.fn(async function* (_threadId: ThreadId, abort: AbortSignal) {
      signal = abort;
      yield { type: "caughtUp", rev: 0 } as const;
      await new Promise<void>((resolve) =>
        abort.addEventListener("abort", () => resolve(), { once: true }),
      );
    });
    const api = { threadFeed } as unknown as Api;
    const view = render(
      <StrictMode>
        <ApiProvider api={api}>
          <Viewer />
        </ApiProvider>
      </StrictMode>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
    });
    expect(screen.getByText("live")).toBeTruthy();
    expect(threadFeed).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(signal?.aborted).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(signal?.aborted).toBe(true);
  });
});
