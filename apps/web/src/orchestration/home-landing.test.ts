// @vitest-environment happy-dom
import { DEFAULT_SETTINGS, type ThreadSummary, type WorkspaceState } from "@gram/contracts";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useServerSettings } from "@/settings-sync/store";
import { useThreadsStore } from "@/stores/threads";

const navigate = vi.fn();
let pathname = "/";
let query: { workspaces: readonly WorkspaceState[]; settled: boolean; error: unknown } = {
  workspaces: [],
  settled: false,
  error: null,
};

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useParams: () => ({}),
  useLocation: ({ select }: { select: (location: { pathname: string }) => unknown }) =>
    select({ pathname }),
}));
vi.mock("./use-orchestration", () => ({ useWorkspacesQuery: () => query }));

const { LANDING_WAIT_MS, resetLaunchForTests, useForgoLandingAway, useLandOnOrchestrator } =
  await import("./home");

const workspace = (id: string, orchestratorThreadId?: string) =>
  ({
    workspace: {
      id,
      name: id,
      ...(orchestratorThreadId === undefined ? {} : { orchestratorThreadId }),
    },
  }) as unknown as WorkspaceState;

const summary = (id: string, lastActivityAt: number) =>
  ({ thread: { id, lastActivityAt } }) as unknown as ThreadSummary;

beforeEach(() => {
  vi.useFakeTimers();
  navigate.mockReset();
  pathname = "/";
  query = { workspaces: [], settled: false, error: null };
  resetLaunchForTests("/");
  localStorage.clear();
  useThreadsStore.setState({ ready: true, byId: { "t-a": summary("t-a", 1) } });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useThreadsStore.setState({ ready: false, byId: {} });
  useServerSettings.setState({ settings: undefined });
});

const landing = () => renderHook(() => useLandOnOrchestrator());

describe("useLandOnOrchestrator", () => {
  it("holds the home page until the workspaces are known, then lands on the orchestrator", () => {
    const { result, rerender } = landing();
    expect(result.current).toBe(true);
    expect(navigate).not.toHaveBeenCalled();

    query = { workspaces: [workspace("w-a", "t-a")], settled: true, error: null };
    rerender();
    expect(navigate).toHaveBeenCalledWith({
      to: "/t/$threadId",
      params: { threadId: "t-a" },
      replace: true,
    });
    // On its way there, the home page stays empty.
    expect(result.current).toBe(true);
  });

  it("shows the home page with no workspace, and stays put when one turns up later", () => {
    query = { workspaces: [], settled: true, error: null };
    const { result, rerender } = landing();
    expect(result.current).toBe(false);

    query = { workspaces: [workspace("w-a", "t-a")], settled: true, error: null };
    rerender();
    expect(result.current).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("gives up after a while when the server doesn't answer, and never lands after", () => {
    const { result, rerender } = landing();
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(LANDING_WAIT_MS));
    expect(result.current).toBe(false);

    query = { workspaces: [workspace("w-a", "t-a")], settled: true, error: null };
    rerender();
    expect(result.current).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("doesn't land once the user went elsewhere before the workspaces came", () => {
    pathname = "/settings/general";
    renderHook(() => useForgoLandingAway());
    pathname = "/";
    query = { workspaces: [workspace("w-a", "t-a")], settled: true, error: null };
    const { result } = landing();
    expect(result.current).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("opens the thread shown last with Open at launch at Last thread, once the threads are known", () => {
    useServerSettings.setState({
      settings: { ...DEFAULT_SETTINGS, layout: { openAtLaunch: "thread" } },
    });
    localStorage.setItem("gram.lastThread", "t-b");
    useThreadsStore.setState({ ready: false, byId: {} });
    query = { workspaces: [workspace("w-a", "t-a")], settled: true, error: null };
    const { result, rerender } = landing();
    expect(result.current).toBe(true);
    expect(navigate).not.toHaveBeenCalled();

    useThreadsStore.setState({
      ready: true,
      byId: { "t-a": summary("t-a", 9), "t-b": summary("t-b", 1) },
    });
    rerender();
    expect(navigate).toHaveBeenCalledWith({
      to: "/t/$threadId",
      params: { threadId: "t-b" },
      replace: true,
    });
  });

  it("falls back to the orchestrator when the last thread is gone", () => {
    useServerSettings.setState({
      settings: { ...DEFAULT_SETTINGS, layout: { openAtLaunch: "thread" } },
    });
    localStorage.setItem("gram.lastThread", "t-gone");
    query = { workspaces: [workspace("w-a", "t-a")], settled: true, error: null };
    landing();
    expect(navigate).toHaveBeenCalledWith({
      to: "/t/$threadId",
      params: { threadId: "t-a" },
      replace: true,
    });
  });

  it("keeps opening the orchestrator at Last orchestrator, whatever thread was shown last", () => {
    useServerSettings.setState({ settings: DEFAULT_SETTINGS });
    localStorage.setItem("gram.lastThread", "t-b");
    useThreadsStore.setState({
      ready: true,
      byId: { "t-a": summary("t-a", 1), "t-b": summary("t-b", 9) },
    });
    query = { workspaces: [workspace("w-a", "t-a")], settled: true, error: null };
    landing();
    expect(navigate).toHaveBeenCalledWith({
      to: "/t/$threadId",
      params: { threadId: "t-a" },
      replace: true,
    });
  });

  it("doesn't land a launch that opened anywhere but home", () => {
    resetLaunchForTests("/t/t-b");
    query = { workspaces: [workspace("w-a", "t-a")], settled: true, error: null };
    const { result } = landing();
    expect(result.current).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});
