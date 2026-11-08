// @vitest-environment happy-dom
import type { WorkspaceState } from "@gram/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useThreadsStore } from "@/stores/threads";
import { useViewStore } from "@/views/view-store";

import { PhoneTitle } from "./phone-title";

// The phone header's title: where you are, and under it its place and state.

const at = vi.hoisted(() => ({
  pathname: "/",
  threadId: undefined as string | undefined,
  workspace: undefined as WorkspaceState | undefined,
  solo: false,
}));

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
  Object.assign(at, { pathname: "/", threadId: undefined, workspace: undefined, solo: false });
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
