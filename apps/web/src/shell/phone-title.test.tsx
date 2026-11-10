// @vitest-environment happy-dom
import type { WorkspaceState } from "@gram/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useThreadsStore } from "@/stores/threads";
import { useViewStore } from "@/views/view-store";

import { PhoneTitle, phoneState } from "./phone-title";

// The phone header's title: where you are, and under it its place and state.

const at = vi.hoisted(() => ({
  pathname: "/",
  threadId: undefined as string | undefined,
  workspace: undefined as WorkspaceState | undefined,
  solo: false,
  working: 0,
  waitings: {} as Record<string, { label: string }>,
}));

// What the workspace knows of its workers, which the sidebar's own tests cover.
vi.mock("@/orchestration/use-orchestration", () => ({
  useOrchestratorLedger: () => ({ data: undefined }),
}));
vi.mock("@/orchestration/ask-stack", () => ({ useWorkspaceAsks: () => [] }));
vi.mock("@/orchestration/use-workspace-statuses", () => ({
  useWorkerTally: () => ({ live: at.working, working: at.working }),
}));
vi.mock("@/orchestration/use-waiting-on", () => ({ useWorkerWaitings: () => at.waitings }));

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ threadId: at.threadId }),
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => string }) =>
    select({ location: { pathname: at.pathname } }),
}));

vi.mock("@/views/view-workspace", () => ({
  useViewWorkspace: () => at.workspace,
  useViewSolo: () => at.solo,
}));

const api = { workspace: { id: "w-api", name: "api" } } as unknown as WorkspaceState;

const thread = (id: string, status: string, extra: Record<string, unknown> = {}) =>
  useThreadsStore.setState({
    byId: { [id]: { status, thread: { id, title: "Fix flaky retry test", ...extra } } as never },
  });

const title = () => screen.getByRole("heading").textContent;
const line = () => screen.getByTestId("phone-title-line");

afterEach(() => {
  cleanup();
  Object.assign(at, {
    pathname: "/",
    threadId: undefined,
    workspace: undefined,
    solo: false,
    working: 0,
    waitings: {},
  });
  useThreadsStore.setState({ byId: {}, statusDetail: {} });
  useViewStore.setState({ view: "chat" });
});

describe("PhoneTitle", () => {
  it("names a thread, its workspace and its state", () => {
    Object.assign(at, { pathname: "/t/a", threadId: "a", workspace: api });
    thread("a", "running");
    render(<PhoneTitle />);
    expect(title()).toBe("Fix flaky retry test");
    expect(line().textContent).toBe("api · Running");
    expect(line().dataset.asks).toBeUndefined();
  });

  it("says a solo thread is Solo, and an ask in the asking colour", () => {
    Object.assign(at, { pathname: "/t/a", threadId: "a", solo: true });
    thread("a", "needsApproval");
    render(<PhoneTitle />);
    expect(line().textContent).toBe("Solo · Needs approval");
    expect(line().dataset.asks).toBe("true");
  });

  it("names a worker's heading as the wide header does", () => {
    Object.assign(at, { pathname: "/t/a", threadId: "a", workspace: api });
    thread("a", "idle", { spawnedBy: { threadId: "o", feature: "f" } });
    render(<PhoneTitle />);
    expect(screen.getByRole("heading", { name: "Worker: Fix flaky retry test" })).toBeTruthy();
  });

  it("says how many workers run under an orchestrator at rest, never Stopped over running work", () => {
    Object.assign(at, { pathname: "/t/o", threadId: "o", workspace: api, working: 3 });
    thread("o", "idle", { role: "orchestrator", title: "api", workspaceId: "w-api" });
    render(<PhoneTitle />);
    expect(line().textContent).toBe("Orchestrator · 3 working");
  });

  it("says what a worker at rest waits on, as its sidebar row does", () => {
    Object.assign(at, {
      pathname: "/t/a",
      threadId: "a",
      workspace: api,
      waitings: { a: { label: "Waiting · checks on #142" } },
    });
    thread("a", "idle", { spawnedBy: { threadId: "o", feature: "f" }, workspaceId: "w-api" });
    render(<PhoneTitle />);
    expect(line().textContent).toBe("api · Waiting · checks on #142");
  });

  it("names the Board by its workspace", () => {
    Object.assign(at, { pathname: "/t/a", threadId: "a", workspace: api });
    thread("a", "idle");
    useViewStore.setState({ view: "board" });
    render(<PhoneTitle />);
    expect(title()).toBe("api");
    expect(line().textContent).toBe("Board");
  });

  it("names a page without a thread", () => {
    Object.assign(at, { pathname: "/w/w-api/memory", workspace: api });
    render(<PhoneTitle />);
    expect(title()).toBe("Memory");
    expect(line().textContent).toBe("api");
  });
});

describe("phoneState", () => {
  it("keeps a thread's own word while it does something or asks", () => {
    const facts = { orchestrator: true, working: 3, waiting: "Waiting · checks on #142" };
    expect(phoneState({ state: "Running", ...facts })).toBe("Running");
    expect(phoneState({ state: "Needs approval", ...facts })).toBe("Needs approval");
  });

  it("says Stopped only when nothing runs or waits", () => {
    expect(
      phoneState({ state: "Stopped", orchestrator: true, working: 0, waiting: undefined }),
    ).toBe("Stopped");
    expect(
      phoneState({ state: "Stopped", orchestrator: false, working: 2, waiting: undefined }),
    ).toBe("Stopped");
  });
});
