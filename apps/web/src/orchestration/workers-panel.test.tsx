// @vitest-environment happy-dom
/* oxlint-disable anti-slop/no-module-mocking -- the worker's ThreadView, DiffPanel, PrPanel and
   FilesPanel are stubbed (each has its own tests); the ledger, finished-worker and card hooks hand
   the list fixed facts at once */
import type {
  DocId,
  DocMeta,
  FinishedWorkerDetail,
  GitState,
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
import { renderInRouter } from "@/panels/test-utils";
import { EMPTY_GRID, useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import type { Ask } from "./ask-model";
import { besideShown, closeBeside, openRecordBeside, useBesideStore } from "./beside-store";
import { resetDerivedAsks, useDerivedAsks } from "./needs-you-store";
import { WorkerPane } from "./worker-pane";
import { FINISHED, FOLDER_MISSING, liveTools, NO_PR_YET, NO_REPOSITORY } from "./worker-tools";
import { useWorkersPanelStore, WorkersPanel } from "./workers-panel";

const WORKSPACE = "ws-1" as WorkspaceId;
const NOW = Date.now();

/** The workspace's docs, which the list's Docs slot lists under the groups. */
let docs: DocMeta[] = [];
let finished: FinishedWorkerDetail | undefined;
/** The files the PR of a finished worker in the list changed. */
let prFiles: { path: string; additions: number; deletions: number }[] = [];
const api: Partial<Api> = {
  listDocs: vi.fn(async () => ({ docs })),
  finishedWorker: vi.fn(async () => finished!),
  prDetail: vi.fn(async () => ({ available: true, detail: { files: prFiles } }) as never),
};
let ledger: Pick<OrchestratorLedger, "features"> | undefined;

vi.mock("./use-orchestration", () => ({
  useOrchestratorLedgers: () => new Map([[WORKSPACE, ledger]]),
  useOrchestratorLedger: () => ({ data: ledger }),
  useWorkspaces: () => [],
}));
vi.mock("./use-finished-workers", () => ({
  useFinishedWorkerPages: () => ({ finished: new Map(), horizons: new Map(), busy: false }),
}));
// The sidebar's cards: none here, so every row is drawn from the ledger's facts.
vi.mock("./overview-sidebar", () => ({ useOverviewFeatures: () => [] }));
// The worker's own views are tested where they live; here only which one shows.
vi.mock("@/thread/thread-view", () => ({
  ThreadView: ({ beside }: { beside?: { readOnly?: boolean } }) => (
    <div data-testid="thread-view" data-read-only={beside?.readOnly === true || undefined}>
      {beside?.readOnly !== true && <textarea aria-label="Steer" defaultValue="" />}
    </div>
  ),
}));
vi.mock("@/panels/diff-panel", () => ({ DiffPanel: () => <div data-testid="diff-panel" /> }));
vi.mock("@/panels/pr-panel", () => ({ PrPanel: () => <div data-testid="pr-panel" /> }));
vi.mock("@/panels/files/files-panel", () => ({
  FilesPanel: () => <div data-testid="files-panel" />,
}));

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

const summary = (
  id: string,
  status: ThreadStatus,
  extra: {
    completedAt?: number;
    orchestrator?: string;
    git?: object;
    boundPr?: { repo: string; number: number };
  } = {},
): ThreadSummary =>
  ({
    thread: {
      id: id as ThreadId,
      title: `Title of ${id}`,
      lastActivityAt: NOW - 2 * 60_000,
      workspaceId: WORKSPACE,
      checkout: { kind: "worktree", path: `/work/${id}` },
      ...(extra.completedAt === undefined ? {} : { completedAt: extra.completedAt }),
      ...(extra.boundPr === undefined ? {} : { boundPr: { ...extra.boundPr, monitor: false } }),
      ...(extra.orchestrator === undefined
        ? {}
        : { spawnedBy: { threadId: extra.orchestrator, feature: "refunds" } }),
    },
    status,
    pendingRequests: [],
    ...(extra.git === undefined ? {} : { git: extra.git }),
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

/** Workers of the orchestrator "orch", in the pane beside its chat. */
const seedTeam = (ids: { id: string; state: WorkerState; status?: ThreadStatus }[]) =>
  seed(
    ids.map(({ id, state, status }) => worker(id, state, status === undefined ? {} : { status })),
    [
      ...ids.map(({ id, status }) => summary(id, status ?? "idle", { orchestrator: "orch" })),
      summary("orch", "idle"),
    ],
  );

const group = (id: string) => screen.getByTestId(`workers-group-${id}`);
const heading = (id: string) => within(group(id)).getAllByRole("button")[0]!;
const rowOf = (id: string) =>
  screen
    .getAllByTestId("workers-panel-row")
    .find((row) => row.dataset.threadId === id) as HTMLElement;

const list = () => screen.getByTestId("workers-panel-list");
const title = () => screen.getByTestId("beside-title").textContent;

/** The pane as the right panel draws it in Workers mode: the list, or the worker open in it. */
function Pane() {
  const shown = useBesideStore((s) => besideShown(s));
  const record = useBesideStore((s) => s.record);
  return shown === undefined ? (
    <WorkersPanel workspaceId={WORKSPACE} closable />
  ) : (
    <WorkerPane workspaceId={WORKSPACE} worker={shown} record={record} />
  );
}

beforeEach(() => {
  docs = [];
  resetDerivedAsks();
  finished = undefined;
  prFiles = [];
  useWorkersPanelStore.setState({
    toggled: new Set(),
    shown: new Set(),
    doneAll: false,
    docsFolded: false,
    query: undefined,
    queryFor: undefined,
    place: undefined,
    focus: false,
  });
  // Focus moves on the next frame once a row is drawn.
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => setTimeout(run, 0));
});

afterEach(() => {
  cleanup();
  closeBeside();
  vi.unstubAllGlobals();
  useLayoutStore.setState({ grid: EMPTY_GRID });
  useThreadsStore.setState({ byId: {}, statusDetail: {} });
});

describe("the Workers list", () => {
  it("groups workers by status with quiet counts, Done folded, and draws no group that holds nothing", async () => {
    seed(
      [worker("run", "working", { status: "running" }), worker("shipped", "merged")],
      [summary("run", "running"), summary("shipped", "idle", { completedAt: NOW - 60 * 60_000 })],
    );
    await renderInRouter(<WorkersPanel workspaceId={WORKSPACE} />, { api });

    expect(within(group("running")).getByTestId("workers-group-count").textContent).toBe("1");
    expect(within(group("running")).getByText("Title of run")).toBeTruthy();
    // How many are on, and how many are done, beside its name; no workspace named.
    expect(screen.getByTestId("workers-panel-counts").textContent).toBe("1 · 1 done");

    // Done starts folded, its count still said.
    expect(heading("done").getAttribute("aria-expanded")).toBe("false");
    expect(within(group("done")).getByTestId("workers-group-count").textContent).toBe("1");
    fireEvent.click(heading("done"));
    expect(heading("done").getAttribute("aria-expanded")).toBe("true");
    expect(within(group("done")).getByText("Title of shipped")).toBeTruthy();

    // A group with nothing in it isn't there: no "Needs you 0", no "Stopped 0".
    for (const id of ["needs", "waiting", "stopped"]) {
      expect(screen.queryByTestId(`workers-group-${id}`)).toBeNull();
    }
  });

  it("draws each worker with the sidebar's own row, wide: its question whole, in the needs-you tone", async () => {
    seed([worker("asker", "working")], [summary("asker", "idle")]);
    useDerivedAsks.setState({
      asks: [
        {
          workspaceId: WORKSPACE,
          name: "Shop",
          orchestratorThreadId: undefined,
          asks: [
            {
              key: "ask-1",
              lead: "Where does the sheet go?",
              worker: {
                workspaceId: WORKSPACE,
                question: {
                  threadId: "asker",
                  question: "Put the sheet under Help or under Settings?",
                },
              },
            } as unknown as Ask,
          ],
        },
      ],
    });
    await renderInRouter(<WorkersPanel workspaceId={WORKSPACE} />, { api });
    const row = rowOf("asker");
    expect(within(row).getByTestId("overview-worker-title").textContent).toBe("Title of asker");
    const words = within(row).getByTestId("overview-worker-now");
    expect(words.textContent).toBe("Asks you: Put the sheet under Help or under Settings?");
    expect(words.closest(".text-status-needs")).toBeTruthy();
  });

  it("says once that there are no workers yet, with the orchestrator a click away, instead of five empty groups", async () => {
    seed([], []);
    await renderInRouter(<WorkersPanel workspaceId={WORKSPACE} />, { api });
    const empty = screen.getByTestId("workers-empty");
    expect(within(empty).getByTestId("empty-title").textContent).toBe("No workers yet");
    expect(within(empty).getByRole("button", { name: "Message the orchestrator" })).toBeTruthy();
    expect(screen.queryByTestId("workers-group-running")).toBeNull();
  });

  it("lists the workspace's docs under the groups, one line each, and nothing there without any", async () => {
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
    const { unmount } = await renderInRouter(<WorkersPanel workspaceId={WORKSPACE} />, { api });
    const strip = await screen.findByTestId("docs-strip");
    const doc = within(strip).getByTestId("doc-row");
    expect(doc.textContent).toBe("Gap analysis5m");
    // The worker that wrote it names it on its own row too, a chip that opens it.
    expect(within(rowOf("run").parentElement!).getByTestId("overview-worker-doc").textContent).toBe(
      "Gap analysis",
    );
    fireEvent.click(within(strip).getByRole("button", { name: "Docs, 1" }));
    expect(doc.closest("[hidden]")).toBeTruthy();
    // Under the status groups: the workers come first.
    expect(
      strip.compareDocumentPosition(group("running")) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
    unmount();

    docs = [];
    await renderInRouter(<WorkersPanel workspaceId={WORKSPACE} />, { api });
    await waitFor(() => expect(api.listDocs).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("docs-strip")).toBeNull();
  });

  it("opens an orchestrator's worker in the pane, keeping the chat, and with ⌘ in the main view", async () => {
    seedTeam([{ id: "run", state: "working", status: "running" }]);
    const { router } = await renderInRouter(<Pane />, { api });
    fireEvent.click(rowOf("run"));
    // The orchestrator stays the chat; the worker is in the pane, under its crumb.
    await waitFor(() => expect(router.state.location.pathname).toBe("/t/orch"));
    expect(useBesideStore.getState()).toMatchObject({ worker: "run", shown: true });
    expect(screen.getByTestId("beside-title").textContent).toBe("Title of run");
    expect(screen.getByTestId("beside-crumb").textContent).toBe("Workers");
    act(() => closeBeside());
    fireEvent.click(rowOf("run"), { metaKey: true });
    await waitFor(() => expect(router.state.location.pathname).toBe("/t/run"));
    expect(useBesideStore.getState().worker).toBeUndefined();
  });

  it("searches from the header, listing only groups with a match", async () => {
    seed(
      [worker("run", "working", { status: "running" }), worker("rest", "working")],
      [summary("run", "running"), summary("rest", "idle")],
    );
    await renderInRouter(<WorkersPanel workspaceId={WORKSPACE} />, { api });
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
    expect(group("running")).toBeTruthy();
  });

  it("shows only the groups the filter picks", async () => {
    seed([worker("run", "working", { status: "running" })], [summary("run", "running")]);
    await renderInRouter(<WorkersPanel workspaceId={WORKSPACE} />, { api });
    act(() => useWorkersPanelStore.getState().setShown("running", true));
    expect(screen.queryByTestId("workers-group-needs")).toBeNull();
    expect(group("running")).toBeTruthy();
    expect(screen.getByTestId("workers-panel-filter").getAttribute("aria-label")).toBe(
      "Filter: Running",
    );
    act(() => useWorkersPanelStore.setState({ shown: new Set(["stopped"]) }));
    expect(screen.queryByTestId("workers-group-running")).toBeNull();
    expect(screen.getByTestId("workers-filter-empty").textContent).toBe("No workers in Stopped");
  });
});

describe("a worker open in the pane", () => {
  const team = [
    { id: "a", state: "working" as const, status: "running" as const },
    { id: "b", state: "working" as const, status: "running" as const },
    { id: "c", state: "working" as const, status: "running" as const },
  ];

  it("goes back by ‹, the crumb or Esc to the list as it was: its groups, its scroll, the worker current and holding the keys", async () => {
    seedTeam([...team, { id: "shipped", state: "merged" }]);
    await renderInRouter(<Pane />, { api });
    fireEvent.click(heading("done"));
    list().scrollTop = 120;
    fireEvent.click(rowOf("b"));
    expect(screen.queryByTestId("workers-panel")).toBeNull();

    // ‹ goes back.
    fireEvent.click(screen.getByTestId("beside-back"));
    await waitFor(() => expect(document.activeElement).toBe(rowOf("b")));
    expect(heading("done").getAttribute("aria-expanded")).toBe("true");
    expect(list().scrollTop).toBe(120);
    // The worker last open is current, drawn apart from the keys' focus.
    expect(rowOf("b").getAttribute("aria-current")).toBe("true");
    expect(rowOf("a").getAttribute("aria-current")).toBeNull();

    // Esc goes back too, with the keys in the pane and nothing typed; it is marked as handled for
    // an app around Gram, never stopped.
    fireEvent.click(rowOf("c"));
    const outside = vi.fn((event: KeyboardEvent) => event.defaultPrevented);
    document.addEventListener("keydown", outside);
    fireEvent.keyDown(screen.getByTestId("beside-title"), { key: "Escape" });
    document.removeEventListener("keydown", outside);
    expect(outside).toHaveReturnedWith(true);
    await waitFor(() => expect(document.activeElement).toBe(rowOf("c")));

    // A draft keeps its Esc: the pane stays on the worker.
    fireEvent.click(rowOf("a"));
    const draft = within(screen.getByTestId("thread-view")).getByRole("textbox");
    fireEvent.change(draft, { target: { value: "half a thought" } });
    fireEvent.keyDown(draft, { key: "Escape" });
    expect(screen.getByTestId("beside-title").textContent).toBe("Title of a");
  });

  it("takes the keys when it opens from the list, on its title, so Esc goes back at once", async () => {
    seedTeam(team);
    await renderInRouter(<Pane />, { api });
    fireEvent.click(rowOf("b"));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("beside-title")));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(rowOf("b")));
  });

  it("steps keeping the tool shown, and Back puts the keys on the worker stepped to", async () => {
    seed(
      team.map(({ id, state, status }) => worker(id, state, { status })),
      [
        ...team.map(({ id }) =>
          summary(id, "running", { orchestrator: "orch", git: { repo: true, changedFiles: 2 } }),
        ),
        summary("orch", "idle"),
      ],
    );
    await renderInRouter(<Pane />, { api });
    fireEvent.click(rowOf("a"));
    fireEvent.click(screen.getByTestId("beside-tab-changes"));
    fireEvent.keyDown(screen.getByTestId("beside-title"), { key: "ArrowDown" });
    expect(title()).toBe("Title of b");
    expect(screen.getByTestId("beside-tab-changes").getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByTestId("beside-back"));
    await waitFor(() => expect(document.activeElement).toBe(rowOf("b")));
  });

  it("steps to the worker before or after with ↑ ↓ on its head, never from the composer or outside the pane", async () => {
    seedTeam(team);
    await renderInRouter(<Pane />, { api });
    fireEvent.click(rowOf("b"));

    fireEvent.keyDown(screen.getByTestId("beside-title"), { key: "ArrowDown" });
    expect(title()).toBe("Title of c");
    // On the tools too, where ← → move between them.
    fireEvent.keyDown(screen.getByTestId("beside-tab-thread"), { key: "ArrowUp" });
    expect(title()).toBe("Title of b");
    // The neighbours are named on the buttons that do the same.
    expect(screen.getByTestId("beside-prev").getAttribute("aria-label")).toBe(
      "Previous: Title of a",
    );

    // In the composer the arrows are the caret's; outside the pane they are someone else's.
    const draft = within(screen.getByTestId("thread-view")).getByRole("textbox");
    fireEvent.keyDown(draft, { key: "ArrowDown" });
    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    expect(title()).toBe("Title of b");
  });

  it("opens any worker from its title's switcher: by group, narrowed by typing, ↓ and ⏎", async () => {
    seedTeam(team);
    await renderInRouter(<Pane />, { api });
    fireEvent.click(rowOf("a"));
    fireEvent.click(screen.getByTestId("beside-title"));
    const switcher = await screen.findByTestId("beside-switcher");
    expect(within(switcher).getByRole("group", { name: "Running" })).toBeTruthy();
    const filter = within(switcher).getByTestId("beside-switcher-filter");
    fireEvent.change(filter, { target: { value: "of c" } });
    expect(within(switcher).getAllByTestId("beside-switcher-row")).toHaveLength(1);
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    fireEvent.keyDown(filter, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("beside-title").textContent).toBe("Title of c"));
  });

  it("says why a tool it doesn't have is off: no PR yet", async () => {
    seed(
      [worker("run", "working", { status: "running" })],
      [
        summary("run", "running", {
          orchestrator: "orch",
          git: { repo: true, changedFiles: 3, aheadBase: 1 },
        }),
        summary("orch", "idle"),
      ],
    );
    await renderInRouter(<Pane />, { api });
    fireEvent.click(rowOf("run"));
    expect(screen.getByTestId("beside-tab-changes").textContent).toContain("3");
    const pr = screen.getByTestId("beside-tab-pr");
    expect(pr.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(pr.getAttribute("aria-describedby")!)?.textContent).toBe(
      "No pull request yet",
    );
    fireEvent.click(pr);
    expect(screen.getByTestId("beside-tab-thread").getAttribute("aria-selected")).toBe("true");
  });

  it("keeps a finished worker read only though its worktree is still there: no composer, no Terminal or Files, Changes from its PR", async () => {
    prFiles = [
      { path: "src/history.ts", additions: 30, deletions: 8 },
      { path: "src/history.test.ts", additions: 4, deletions: 1 },
    ];
    seed(
      [worker("shipped", "merged")],
      [
        summary("shipped", "idle", {
          orchestrator: "orch",
          completedAt: NOW - 10 * 60_000,
          git: { repo: true, changedFiles: 0 },
          boundPr: { repo: "acme/app", number: 141 },
        }),
        summary("orch", "idle"),
      ],
    );
    await renderInRouter(<Pane />, { api });
    fireEvent.click(heading("done"));
    fireEvent.click(rowOf("shipped"));
    expect(screen.getByTestId("thread-view").dataset.readOnly).toBe("true");
    expect(within(screen.getByTestId("thread-view")).queryByRole("textbox")).toBeNull();
    for (const id of ["terminal", "files"]) {
      const tool = screen.getByTestId(`beside-tab-${id}`);
      expect(tool.getAttribute("aria-disabled")).toBe("true");
      expect(document.getElementById(tool.getAttribute("aria-describedby")!)?.textContent).toBe(
        "Finished: read only",
      );
    }
    expect(screen.getByTestId("beside-tab-pr").getAttribute("aria-disabled")).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("beside-tab-changes").textContent).toBe("Changes2"),
    );
    fireEvent.click(screen.getByTestId("beside-tab-changes"));
    expect(screen.getByTestId("finished-files-all").querySelectorAll("li")).toHaveLength(2);
    expect(screen.queryByTestId("diff-panel")).toBeNull();
  });

  it("opens a finished worker whose worktree is gone as its record: Terminal and Files off and why, Changes counted from the record", async () => {
    finished = {
      worker: {
        threadId: "gone" as ThreadId,
        workspaceId: WORKSPACE,
        title: "Stable sort in History",
        feature: "history",
        closedAt: NOW - 30 * 60_000,
        completedReason: "prMerged",
        prs: [{ repo: "acme/app", number: 141, url: "https://example.test/141", merged: true }],
        kept: "closed",
      },
      reports: [],
      files: [
        { path: "src/history.ts", additions: 30, deletions: 8 },
        { path: "src/history.test.ts", additions: 4, deletions: 1 },
      ],
      messages: [],
      earlierOmitted: 0,
    };
    seed([], []);
    act(() => {
      openRecordBeside("gone" as ThreadId);
    });
    await renderInRouter(<Pane />, { api });
    await waitFor(() =>
      expect(screen.getByTestId("beside-tab-changes").textContent).toBe("Changes2"),
    );
    for (const id of ["terminal", "files"]) {
      const tool = screen.getByTestId(`beside-tab-${id}`);
      expect(tool.getAttribute("aria-disabled")).toBe("true");
      expect(document.getElementById(tool.getAttribute("aria-describedby")!)?.textContent).toBe(
        "Worktree cleaned up",
      );
      fireEvent.click(tool);
      expect(screen.getByTestId("beside-tab-thread").getAttribute("aria-selected")).toBe("true");
    }
    // Its record's files are what Changes shows: the count and the list agree.
    fireEvent.click(screen.getByTestId("beside-tab-changes"));
    expect(screen.getByTestId("finished-files-all").querySelectorAll("li")).toHaveLength(2);
    expect(screen.getByTestId("beside-tab-pr").textContent).toContain("#141");
    expect(screen.getByTestId("beside-record-note").textContent).toContain("read only");
    // Read only: no composer.
    expect(screen.queryByTestId("thread-view")).toBeNull();
  });
});

const BOUND_142 = { repo: "example/gram", number: 142 };

/** Each tool's reason it is off, else its count, else "on". */
const off = (facts: Parameters<typeof liveTools>[0]) =>
  Object.fromEntries(liveTools(facts).map((tool) => [tool.id, tool.off ?? tool.count ?? "on"]));

describe("a worker's tools", () => {
  it("offers PR only with a PR to open, and Terminal and Files only with a checkout to read, each off saying why", () => {
    // A PR it is bound to opens before its badge has loaded.
    expect(off({ git: { repo: true, changedFiles: 0 }, boundPr: BOUND_142 }).pr).toBe("#142");
    expect(off({ git: { repo: true, changedFiles: 3 } })).toMatchObject({
      pr: NO_PR_YET,
      changes: "3",
      terminal: "on",
      files: "on",
    });
    // Its folder deleted outside Gram: nothing to read from it.
    const bound7 = { repo: "example/gram", number: 7 };
    expect(
      off({ git: { repo: true, changedFiles: 0, missing: true }, boundPr: bound7 }),
    ).toMatchObject({
      pr: "#7",
      changes: FOLDER_MISSING,
      terminal: FOLDER_MISSING,
      files: FOLDER_MISSING,
    });
    expect(off({ git: { repo: false, changedFiles: 0 } })).toMatchObject({
      changes: NO_REPOSITORY,
      pr: NO_REPOSITORY,
      files: "on",
    });
    // Finished: read only, its Changes its PR's, counted from them.
    expect(off({ git: { repo: true, changedFiles: 0 }, finished: true, prFiles: 4 })).toMatchObject(
      { changes: "4", terminal: FINISHED, files: FINISHED },
    );
  });

  it("offers Proof only where the repository names checks, counting what covers the change", () => {
    const git = { repo: true, changedFiles: 1 };
    expect(off({ git })).not.toHaveProperty("proof");
    expect(off({ git, verify: { recipe: "none", drivers: [] } })).not.toHaveProperty("proof");
    const verify = {
      recipe: "ok",
      head: "a".repeat(40),
      drivers: [
        { name: "unit", run: "t", status: "passed" },
        { name: "lint", run: "l", status: "notRun" },
        { name: "rust", run: "r", status: "notRun", coversChange: false },
      ],
    } as const;
    expect(off({ git, verify }).proof).toBe("1/2");
    // Outside git there is no commit to have checked.
    expect(off({ git: { repo: false, changedFiles: 0 }, verify })).not.toHaveProperty("proof");
  });

  it("names the PR its panel opens: the bound one, over a badge that still names another", () => {
    const stale = {
      number: 913,
      url: "https://github.com/example/gram/pull/913",
    } as NonNullable<GitState["pr"]>;
    const git = { repo: true, changedFiles: 0, origin: "example/gram", pr: stale };
    expect(off({ git, boundPr: BOUND_142 }).pr).toBe("#142");
    // Unbound, the branch's PR is the one it opens.
    expect(off({ git }).pr).toBe("#913");
  });
});
