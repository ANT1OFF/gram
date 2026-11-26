// @vitest-environment happy-dom
/* oxlint-disable anti-slop/no-module-mocking -- fakes worker tallies, waits and view workspace */
import type { WorkspaceState } from "@gram/contracts";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useEmbedShell } from "@/embed/store";
import { useThreadsStore } from "@/stores/threads";
import { useViewStore } from "@/views/view-store";

import { renderInRouter } from "@/panels/test-utils";

import { PhoneTitle, phoneState } from "./phone-title";

const shown = () =>
  renderInRouter(<PhoneTitle />, {
    path: at.pathname,
    routes: ["/chat/$threadId", "/new-task", "/new-workspace", "/govern/limits"],
  });

// The phone header's title: where you are, and under it its place and state.

const at = vi.hoisted(() => ({
  pathname: "/",
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
  useEmbedShell.setState({ navigation: [], titles: {}, threadsPage: {} });
  Object.assign(at, {
    pathname: "/",
    workspace: undefined,
    solo: false,
    working: 0,
    waitings: {},
  });
  useThreadsStore.setState({ byId: {}, statusDetail: {} });
  useViewStore.setState({ view: "chat" });
});

describe("PhoneTitle", () => {
  it("names a thread, its workspace and its state", async () => {
    Object.assign(at, { pathname: "/t/a", workspace: api });
    thread("a", "running");
    await shown();
    expect(title()).toBe("Fix flaky retry test");
    expect(line().textContent).toBe("api · Running");
    expect(line().dataset.asks).toBeUndefined();
  });

  it("says a solo thread is Solo, and an ask in the asking colour", async () => {
    Object.assign(at, { pathname: "/t/a", solo: true });
    thread("a", "needsApproval");
    await shown();
    expect(line().textContent).toBe("Solo · Needs approval");
    expect(line().dataset.asks).toBe("true");
  });

  it("puts a thread an app shows in a place of its own under that place, and no kind of thread", async () => {
    Object.assign(at, { pathname: "/chat/a", solo: true });
    useEmbedShell.setState({
      threadsPage: { places: [{ name: "Chat", path: "/chat/$threadId", ids: ["a"] }] },
    });
    thread("a", "idle");
    await shown();
    expect(line().textContent).toBe("Chat");
    cleanup();
    thread("a", "running");
    await shown();
    expect(line().textContent).toBe("Chat · Running");
  });

  it("names a worker's heading as the wide header does", async () => {
    Object.assign(at, { pathname: "/t/a", workspace: api });
    thread("a", "idle", { spawnedBy: { threadId: "o", feature: "f" } });
    await shown();
    expect(screen.getByRole("heading", { name: "Worker: Fix flaky retry test" })).toBeTruthy();
  });

  it("says how many workers run under an orchestrator at rest, never Stopped over running work", async () => {
    Object.assign(at, { pathname: "/t/o", workspace: api, working: 3 });
    thread("o", "idle", { role: "orchestrator", title: "api", workspaceId: "w-api" });
    await shown();
    expect(line().textContent).toBe("Orchestrator · 3 working");
  });

  it("says what a worker at rest waits on, as its sidebar row does", async () => {
    Object.assign(at, {
      pathname: "/t/a",
      workspace: api,
      waitings: { a: { label: "Waiting · checks on #142" } },
    });
    thread("a", "idle", { spawnedBy: { threadId: "o", feature: "f" }, workspaceId: "w-api" });
    await shown();
    expect(line().textContent).toBe("api · Waiting · checks on #142");
  });

  it("names the Board by its workspace", async () => {
    Object.assign(at, { pathname: "/t/a", workspace: api });
    thread("a", "idle");
    useViewStore.setState({ view: "board" });
    await shown();
    expect(title()).toBe("api");
    expect(line().textContent).toBe("Board");
  });

  it("names a page without a thread", async () => {
    Object.assign(at, { pathname: "/w/w-api/memory", workspace: api });
    await shown();
    expect(title()).toBe("Memory");
    expect(line().textContent).toBe("api");
  });

  it("names the New form's pages as the title bar does, a workspace in the app's own noun", async () => {
    Object.assign(at, { pathname: "/new-task" });
    await shown();
    expect(title()).toBe("New task");
    cleanup();
    useEmbedShell.setState({
      threadsPage: { workspaces: { noun: "Project", plural: "Projects" } },
    });
    Object.assign(at, { pathname: "/new-workspace" });
    await shown();
    expect(title()).toBe("New project");
  });

  it("names a page an app in front of Gram added, over the group it is listed in", async () => {
    useEmbedShell.setState({
      titles: { "/govern/limits": "Limits" },
      navigation: [
        {
          id: "govern",
          label: "Govern",
          items: [{ id: "l", label: "Limits", to: "/govern/limits" }],
        },
      ],
    });
    Object.assign(at, { pathname: "/govern/limits", workspace: api });
    await shown();
    expect(title()).toBe("Limits");
    expect(line().textContent).toBe("Govern");
  });

  it("puts the place under an added page listed in no group", async () => {
    useEmbedShell.setState({ titles: { "/govern/limits": "Limits" } });
    Object.assign(at, { pathname: "/govern/limits", workspace: api });
    await shown();
    expect(title()).toBe("Limits");
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
