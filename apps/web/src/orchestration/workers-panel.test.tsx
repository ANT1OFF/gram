// @vitest-environment happy-dom
import type {
  DocId,
  DocMeta,
  OrchestratorLedger,
  ProjectId,
  ThreadId,
  ThreadStatus,
  ThreadSummary,
  WorkerLedgerEntry,
  WorkerState,
  WorkspaceId,
} from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Api } from "@/api/types";
import { renderWithApi } from "@/panels/test-utils";
import { useThreadsStore } from "@/stores/threads";

import { closeBeside, useBesideStore } from "./beside-store";
import { useWorkersPanelStore, WorkersPanel } from "./workers-panel";

const WORKSPACE = "ws-1" as WorkspaceId;
const NOW = Date.now();

const opened = vi.fn<(threadId: ThreadId) => void>();
/** The workspace's docs, which the tab's Docs slot lists above the groups. */
let docs: DocMeta[] = [];
const api: Partial<Api> = { listDocs: vi.fn(async () => ({ docs })) };
let ledger: Pick<OrchestratorLedger, "features"> | undefined;

vi.mock("@tanstack/react-router", () => ({ useParams: () => ({}) }));
vi.mock("@/shell/thread-switcher", () => ({ useOpenThread: () => opened }));
vi.mock("./use-orchestration", () => ({
  useOrchestratorLedgers: () => new Map([[WORKSPACE, ledger]]),
}));
vi.mock("./use-finished-workers", () => ({
  useFinishedWorkerPages: () => ({ finished: new Map(), horizons: new Map(), busy: false }),
}));
vi.mock("./ask-stack", () => ({ useWorkspaceAsks: () => [] }));

const worker = (
  id: string,
  state: WorkerState,
  extra: Partial<WorkerLedgerEntry> = {},
): WorkerLedgerEntry => ({
  feature: "refunds",
  projectId: "p-api" as ProjectId,
  project: "api",
  threadId: id as ThreadId,
  title: `Title of ${id}`,
  state,
  status: "idle",
  pendingRequests: [],
  changedFiles: 0,
  overlapsWith: [],
  userIntervened: false,
  messagesFromOrchestrator: 0,
  ...extra,
});

const summary = (id: string, status: ThreadStatus, completedAt?: number): ThreadSummary =>
  ({
    thread: {
      id: id as ThreadId,
      title: `Title of ${id}`,
      lastActivityAt: NOW - 2 * 60_000,
      workspaceId: WORKSPACE,
      ...(completedAt === undefined ? {} : { completedAt }),
    },
    status,
    pendingRequests: [],
  }) as unknown as ThreadSummary;

const seed = (workers: WorkerLedgerEntry[], summaries: ThreadSummary[]) => {
  ledger = { features: [{ feature: "refunds", workers }] } as unknown as Pick<
    OrchestratorLedger,
    "features"
  >;
  useThreadsStore.setState({
    byId: Object.fromEntries(summaries.map((each) => [each.thread.id, each])),
    statusDetail: {},
  });
};

const group = (id: string) => screen.getByTestId(`workers-group-${id}`);
const heading = (id: string) => within(group(id)).getAllByRole("button")[0]!;

beforeEach(() => {
  docs = [];
  opened.mockClear();
  useWorkersPanelStore.setState({ toggled: new Set(), shown: new Set(), doneAll: false });
});

afterEach(() => {
  cleanup();
  useThreadsStore.setState({ byId: {}, statusDetail: {} });
});

describe("the Workers tab", () => {
  it("groups workers by status with quiet counts, Done folded and empty groups saying what goes there", () => {
    seed(
      [worker("run", "working", { status: "running" }), worker("shipped", "merged")],
      [summary("run", "running"), summary("shipped", "idle", NOW - 60 * 60_000)],
    );
    renderWithApi(<WorkersPanel workspaceId={WORKSPACE} />, api);

    expect(within(group("running")).getByTestId("workers-group-count").textContent).toBe("1");
    expect(within(group("running")).getByText("Title of run")).toBeTruthy();
    expect(within(group("running")).getByTestId("workers-panel-age").textContent).toBe("2m");

    // Done starts folded, its count still said.
    expect(heading("done").getAttribute("aria-expanded")).toBe("false");
    expect(within(group("done")).getByTestId("workers-group-count").textContent).toBe("1");
    fireEvent.click(heading("done"));
    expect(heading("done").getAttribute("aria-expanded")).toBe("true");
    expect(within(group("done")).getByText("Title of shipped")).toBeTruthy();

    // An empty group says what would be listed there.
    expect(within(group("needs")).getByTestId("workers-group-empty").textContent).toBe(
      "Approvals, questions and failures for you",
    );
    expect(within(group("waiting")).getByTestId("workers-group-count").textContent).toBe("0");
  });

  it("lists the workspace's docs in the slot above the groups, and nothing there without any", async () => {
    seed([worker("run", "working", { status: "running" })], [summary("run", "running")]);
    docs = [
      {
        id: "gap-analysis-3f9a2c" as DocId,
        workspaceId: WORKSPACE,
        title: "Gap analysis",
        authorThreadId: "run" as ThreadId,
        authorTitle: "Title of run",
        createdAt: NOW - 5 * 60_000,
        updatedAt: NOW - 5 * 60_000,
        updatedBy: "agent",
        revision: 1,
        bytes: 10,
        excerpt: "What Gram lacks.",
      },
    ];
    const { unmount } = renderWithApi(<WorkersPanel workspaceId={WORKSPACE} />, api);
    const strip = await screen.findByTestId("docs-strip");
    expect(within(strip).getByTestId("doc-row").textContent).toContain("Gap analysis");
    expect(within(strip).getByTestId("docs-view-all")).toBeTruthy();
    // Above the status groups, in the tab's one scroll column.
    expect(
      strip.compareDocumentPosition(group("running")) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    unmount();

    docs = [];
    renderWithApi(<WorkersPanel workspaceId={WORKSPACE} />, api);
    await waitFor(() => expect(api.listDocs).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("docs-strip")).toBeNull();
    expect(group("running")).toBeTruthy();
  });

  it("collapses a group from its heading", () => {
    seed([worker("run", "working", { status: "running" })], [summary("run", "running")]);
    renderWithApi(<WorkersPanel workspaceId={WORKSPACE} />, api);
    fireEvent.click(heading("running"));
    expect(heading("running").getAttribute("aria-expanded")).toBe("false");
    expect(within(group("running")).queryByText("Title of run")?.closest("[hidden]")).toBeTruthy();
  });

  it("opens a worker from its row: in its own view while it is no orchestrator's", () => {
    seed([worker("run", "working", { status: "running" })], [summary("run", "running")]);
    renderWithApi(<WorkersPanel workspaceId={WORKSPACE} />, api);
    fireEvent.click(screen.getByTestId("workers-panel-row"));
    expect(opened).toHaveBeenCalledWith("run");
    expect(useBesideStore.getState().worker).toBeUndefined();
  });

  it("opens an orchestrator's live worker beside its chat, and with ⌘ in its own view", () => {
    // Focus moves on the next frame, which a node test doesn't have.
    vi.stubGlobal("requestAnimationFrame", () => 0);
    const run = summary("run", "running");
    seed([worker("run", "working", { status: "running" })], [
      { ...run, thread: { ...run.thread, spawnedBy: { threadId: "orch", feature: "refunds" } } },
      summary("orch", "idle"),
    ] as ThreadSummary[]);
    renderWithApi(<WorkersPanel workspaceId={WORKSPACE} />, {});
    fireEvent.click(screen.getByTestId("workers-panel-row"));
    // The orchestrator stays the chat; the worker is in the Thread tab beside it.
    expect(opened).toHaveBeenCalledWith("orch");
    expect(useBesideStore.getState()).toMatchObject({ worker: "run", shown: true });
    closeBeside();
    opened.mockClear();
    fireEvent.click(screen.getByTestId("workers-panel-row"), { metaKey: true });
    expect(opened).toHaveBeenCalledWith("run");
    expect(useBesideStore.getState().worker).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("searches from the header, listing only groups with a match", () => {
    seed(
      [worker("run", "working", { status: "running" }), worker("rest", "working")],
      [summary("run", "running"), summary("rest", "idle")],
    );
    renderWithApi(<WorkersPanel workspaceId={WORKSPACE} />, api);
    fireEvent.click(screen.getByTestId("workers-panel-search-toggle"));
    const input = screen.getByTestId("workers-panel-search");
    fireEvent.change(input, { target: { value: "of run" } });
    expect(screen.queryByTestId("workers-group-stopped")).toBeNull();
    expect(within(group("running")).getAllByTestId("workers-panel-row")).toHaveLength(1);
    fireEvent.change(input, { target: { value: "nothing like it" } });
    expect(screen.getByRole("status").textContent).toBe("No matches");
    // Escape closes the search and every group is back.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("workers-panel-search")).toBeNull();
    expect(group("stopped")).toBeTruthy();
  });

  it("shows only the groups the filter picks", () => {
    seed([worker("run", "working", { status: "running" })], [summary("run", "running")]);
    renderWithApi(<WorkersPanel workspaceId={WORKSPACE} />, api);
    act(() => useWorkersPanelStore.getState().setShown("running", true));
    expect(screen.queryByTestId("workers-group-needs")).toBeNull();
    expect(group("running")).toBeTruthy();
    expect(screen.getByTestId("workers-panel-filter").getAttribute("aria-label")).toBe(
      "Filter: Running",
    );
  });
});
