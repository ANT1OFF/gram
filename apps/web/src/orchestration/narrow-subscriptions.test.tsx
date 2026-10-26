// @vitest-environment happy-dom
import type * as Router from "@tanstack/react-router";
import { DEFAULT_SETTINGS, type ThreadId, type WorkspaceState } from "@gram/contracts";
import { cleanup, waitFor } from "@testing-library/react";
import { Profiler, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockApi, type MockApi } from "@/api/mock";
import { renderWithApi } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";
import { useServerEvents } from "@/stores/feeds";
import { useThreadsStore } from "@/stores/threads";

import { useBoardWaiting } from "./board-waiting";
import { useRailFacts } from "./feature-sheet";
import { resetDerivedAsks } from "./needs-you-store";
import { OverviewDoneToday } from "./overview-extras";
import { NeedsYouSource } from "./use-needs-you";
import { useWorkspaces } from "./use-orchestration";
import { WorkersButton } from "./workers-list";

// The always-mounted views that derive a little from the whole thread map re-render only when what
// they derive changes, not on every change to any thread: the title bar's Workers button, the
// overview's Done today, the Board's chips and its Waiting on you.

const route = vi.hoisted(() => ({ workspaceId: "" }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof Router>()),
  useNavigate: () => () => Promise.resolve(),
  useParams: () => ({ workspaceId: route.workspaceId }),
}));

const commits = new Map<string, number>();
const counted = (id: string, children: ReactNode) => (
  <Profiler id={id} onRender={() => commits.set(id, (commits.get(id) ?? 0) + 1)}>
    {children}
  </Profiler>
);

/** The Board's own reads, as `RailBoard` makes them. */
function BoardReads({ state }: { state: WorkspaceState }) {
  commits.set("board", (commits.get("board") ?? 0) + 1);
  const facts = useRailFacts(state.workspace.id);
  const waiting = useBoardWaiting(state);
  return (
    <span data-testid="board">
      {facts.status(worker) ?? "none"} {facts.asking.size}/{waiting.count}
    </span>
  );
}

function Board() {
  const state = useWorkspaces().find((each) => each.workspace.id === route.workspaceId);
  return state === undefined ? null : <BoardReads state={state} />;
}

function Window() {
  useServerEvents();
  return (
    <>
      <NeedsYouSource />
      {counted("workers-button", <WorkersButton />)}
      {counted("done-today", <OverviewDoneToday />)}
      <Board />
    </>
  );
}

let api: MockApi;
let worker: ThreadId;

beforeEach(async () => {
  useServerSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
  api = createMockApi({ speed: 0, autoplay: false, persist: false });
  const sim = await api.simulateOrchestration("board");
  route.workspaceId = sim.workspaceId;
  commits.clear();
  // A worker on the Board's cards, with nothing asked.
  const { cards } = await api.featureCards(sim.workspaceId);
  const asking = new Set<string>();
  const abort = new AbortController();
  for await (const event of api.events(abort.signal)) {
    if (event.type !== "threads.snapshot") continue;
    for (const t of event.threads) if (t.pendingRequests.length > 0) asking.add(t.thread.id);
    break;
  }
  abort.abort();
  worker = cards
    .flatMap((card) => card.workers.map((each) => each.threadId))
    .find((threadId) => !asking.has(threadId))!;
});

afterEach(() => {
  cleanup();
  useThreadsStore.setState({ byId: {}, statusDetail: {} });
  resetDerivedAsks();
});

const settled = () => new Promise((resolve) => setTimeout(resolve, 150));

describe("always-mounted views", () => {
  it("sit out a working worker's activity line and its other changes", async () => {
    const view = renderWithApi(<Window />, api);
    await waitFor(() => expect(view.getByTestId("workers-button")).toBeTruthy());
    await waitFor(() => expect(view.getByTestId("board")).toBeTruthy());
    api.simulateStatus(worker, "running", "Reading a.ts");
    await waitFor(() =>
      expect(useThreadsStore.getState().statusDetail[worker]).toBe("Reading a.ts"),
    );
    await settled();
    const before = Object.fromEntries(commits);

    // What a working thread does many times a second: its activity line moves, and its summary
    // with it, while who works and what waits stay as they were.
    for (const [i, file] of ["b.ts", "c.ts", "d.ts"].entries()) {
      api.simulateStatus(worker, "running", `Reading ${file}`);
      api.simulateLastActivity(worker, 1_000 + i);
      await waitFor(() =>
        expect(useThreadsStore.getState().statusDetail[worker]).toBe(`Reading ${file}`),
      );
      await waitFor(() =>
        expect(useThreadsStore.getState().byId[worker]?.thread.lastActivityAt).toBe(1_000 + i),
      );
    }
    await settled();
    expect(Object.fromEntries(commits)).toEqual(before);
  });

  it("still follow a change that is theirs: a worker's status reaches its chip", async () => {
    const view = renderWithApi(<Window />, api);
    await waitFor(() => expect(view.getByTestId("board")).toBeTruthy());
    api.simulateStatus(worker, "idle");
    await waitFor(() => expect(view.getByTestId("board").textContent).toMatch(/^idle /));
    api.simulateStatus(worker, "running", "Reading a.ts");
    await waitFor(() => expect(view.getByTestId("board").textContent).toMatch(/^running /));
    api.simulateStatus(worker, "needsApproval");
    await waitFor(() => expect(view.getByTestId("board").textContent).toMatch(/^needsApproval /));
  });
});
