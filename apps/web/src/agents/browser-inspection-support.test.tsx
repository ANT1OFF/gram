// @vitest-environment happy-dom
import {
  BROWSER_INSPECTION_CAPABILITIES,
  type DesktopPreview,
  type PreviewState,
  type SelectedHarnessSupport,
  type ThreadId,
} from "@gram/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HarnessSupportDetails } from "./support-details";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "gram");
});

const threadId = "synthetic-browser-thread" as ThreadId;
const observation: SelectedHarnessSupport = {
  model: { agent: "codex", model: "synthetic-model" },
  checkedAt: 1,
  availability: { state: "available" },
  support: { browser: { state: "unknown", reason: "Provider browser support is unverified." } },
};
const page: PreviewState = {
  url: "http://localhost:1234",
  title: "Synthetic page",
  loading: false,
  canGoBack: false,
  canGoForward: false,
};

function shell() {
  let listener: ((state: PreviewState) => void) | undefined;
  const unsubscribe = vi.fn();
  const bridge: DesktopPreview = {
    state: vi.fn(async () => page),
    onState: vi.fn((_id, next) => {
      listener = next;
      return unsubscribe;
    }),
    open: vi.fn(async () => true),
    setBounds: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    reload: vi.fn(),
    inspect: vi.fn(),
    viewport: vi.fn(),
    takeOver: vi.fn(),
  };
  Object.defineProperty(window, "gram", { configurable: true, value: { preview: bridge } });
  return { bridge, unsubscribe, emit: (state: PreviewState) => listener?.(state) };
}

describe("attached preview capability presentation", () => {
  it("reads current shell evidence without qualifying the provider or performing browser actions", async () => {
    const { bridge, emit, unsubscribe } = shell();
    const view = render(<HarnessSupportDetails observation={observation} threadId={threadId} />);
    await screen.findByText("Attached preview inspection · Unavailable");
    expect(screen.getByText("Provider browser support is unverified.")).toBeTruthy();
    act(() =>
      emit({ ...page, browserInspection: { capabilities: BROWSER_INSPECTION_CAPABILITIES } }),
    );
    await screen.findByText("Attached preview inspection · Available");
    expect(screen.getByText(/Screenshot metadata; top-frame CSS target geometry/)).toBeTruthy();
    expect(screen.getByText("Preview browser tools · Unverified")).toBeTruthy();
    expect(bridge.state).toHaveBeenCalledWith(threadId);
    for (const action of [bridge.open, bridge.inspect, bridge.viewport, bridge.takeOver]) {
      expect(action).not.toHaveBeenCalled();
    }
    // An observation from an existing thread must not carry into a new thread's preflight.
    view.rerender(<HarnessSupportDetails observation={observation} />);
    expect(screen.getByText("Attached preview inspection · Unavailable")).toBeTruthy();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("keeps a failed observation unknown and supports an explicit read-only retry", async () => {
    const { bridge } = shell();
    vi.mocked(bridge.state).mockRejectedValueOnce(new Error("Synthetic shell disconnected"));
    render(<HarnessSupportDetails observation={observation} threadId={threadId} />);
    await screen.findByText("Attached preview inspection · Unverified");
    fireEvent.click(screen.getByRole("button", { name: "Retry preview check" }));
    await screen.findByText("Attached preview inspection · Unavailable");
    await waitFor(() => expect(bridge.state).toHaveBeenCalledTimes(2));
    expect(bridge.open).not.toHaveBeenCalled();
    expect(bridge.inspect).not.toHaveBeenCalled();
  });

  it("does not read a shell page when there is no existing thread", () => {
    const { bridge } = shell();
    render(<HarnessSupportDetails observation={observation} />);
    expect(screen.getByText("Attached preview inspection · Unavailable")).toBeTruthy();
    expect(bridge.state).not.toHaveBeenCalled();
    expect(bridge.onState).not.toHaveBeenCalled();
  });
});
