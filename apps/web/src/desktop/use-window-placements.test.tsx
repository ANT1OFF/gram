// @vitest-environment happy-dom
import type { ThreadId, WindowPlacements } from "@gram/contracts";
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithApi } from "@/panels/test-utils";
import { useLayoutStore } from "@/stores/layout";

import { useWindowPlacementsSync } from "./use-window-placements";
import { currentWindow } from "./window-identity";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

function Harness() {
  useWindowPlacementsSync();
  return null;
}

/** A watch that yields whatever `emit` pushes, like the server's placement stream. */
const makeWatch = () => {
  const queue: WindowPlacements[] = [];
  let wake: (() => void) | undefined;
  const emit = (placements: WindowPlacements) => {
    queue.push(placements);
    wake?.();
  };
  async function* iterate(signal: AbortSignal): AsyncGenerator<WindowPlacements> {
    while (!signal.aborted) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      wake = undefined;
      while (queue.length > 0) yield queue.shift()!;
    }
  }
  return { emit, iterate };
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useWindowPlacementsSync", () => {
  it("reports the panes once, without echoing its own reports", async () => {
    const self = currentWindow();
    const watch = makeWatch();
    const reportWindow = vi.fn(
      async (
        windowId: string,
        threadIds: readonly ThreadId[],
        _state?: { readonly visible?: boolean },
      ) => {
        // The server echoes every report to every watcher, this window included.
        watch.emit({ windows: [{ windowId, name: self.name, threadIds: [...threadIds] }] });
      },
    );
    act(() => {
      useLayoutStore.getState().openThread("t-a" as ThreadId);
    });

    renderWithApi(<Harness />, {
      watchWindows: (window, signal) => {
        watch.emit({ windows: [{ windowId: window.windowId, name: window.name, threadIds: [] }] });
        return watch.iterate(signal);
      },
      reportWindow,
    });

    await waitFor(() =>
      expect(reportWindow).toHaveBeenCalledWith(self.id, ["t-a"], expect.any(Object)),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(reportWindow.mock.calls.length).toBeLessThanOrEqual(2);

    act(() => useLayoutStore.getState().openThread("t-b" as ThreadId));
    await waitFor(() =>
      expect(reportWindow).toHaveBeenLastCalledWith(self.id, ["t-b"], expect.any(Object)),
    );
    const settled = reportWindow.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(reportWindow.mock.calls.length).toBe(settled);
  });

  it("reports the thread in the focused pane, and again when the user moves to another", async () => {
    const self = currentWindow();
    const watch = makeWatch();
    const reportWindow = vi.fn(async () => {});
    act(() => {
      useLayoutStore.getState().openThread("t-a" as ThreadId);
    });

    renderWithApi(<Harness />, {
      watchWindows: (window, signal) => {
        watch.emit({ windows: [{ windowId: window.windowId, name: window.name, threadIds: [] }] });
        return watch.iterate(signal);
      },
      reportWindow,
    });

    await waitFor(() =>
      expect(reportWindow).toHaveBeenLastCalledWith(
        self.id,
        ["t-a"],
        expect.objectContaining({ focusedThreadId: "t-a" }),
      ),
    );
    // The same panes can't tell a click from nothing: the focused thread is what changed.
    act(() => useLayoutStore.getState().openThread("t-b" as ThreadId));
    await waitFor(() =>
      expect(reportWindow).toHaveBeenLastCalledWith(
        self.id,
        expect.arrayContaining(["t-b"]),
        expect.objectContaining({ focusedThreadId: "t-b" }),
      ),
    );
  });
});
