// @vitest-environment happy-dom
import { DEFAULT_SETTINGS, type ThreadId, type WorkspaceId } from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { WorkspaceMenuItems } from "@/orchestration/workspace-menu-items";
import { RowMenuItems, WorkerMenuItems, WorkerRowMenuItems } from "@/thread/row-menu";
import { ThreadMenu } from "@/thread/thread-menu";
import { createMockApi, type MockApi } from "@/api/mock";
import { renderWithApi } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";
import { FOLD_ALL, useTitlebarSlot } from "@/shell/titlebar-slot";
import { useLayoutStore, type PaletteScope } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import { CommandPalette } from "./command-palette";
import { LABEL_WORD_CAP, labelWords } from "./menu-caps";
import { expectCapped, labelOf } from "./menu-test-utils";

/** The route the palette reads: the thread or workspace in view. */
let params: Record<string, string> = {};

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to: _to, params: _params, ...rest }: Record<string, unknown>) => (
    <a href="#" {...rest}>
      {children as ReactNode}
    </a>
  ),
  useNavigate: () => vi.fn(),
  useParams: () => params,
  useLocation: (options?: { select?: (location: { pathname: string }) => unknown }) =>
    options?.select ? options.select({ pathname: "/" }) : { pathname: "/" },
}));

let api: MockApi;
let made: Awaited<ReturnType<MockApi["simulateOrchestration"]>> & { workspaceId: WorkspaceId };
/** A worker that is held and merged at once: both of a worker's own menu verbs show. */
let busiest: ThreadId;

async function seed() {
  const abort = new AbortController();
  for await (const event of api.events(abort.signal)) {
    act(() => useThreadsStore.getState().applyEvent(event));
    if (event.type === "threads.snapshot") break;
  }
  abort.abort();
}

beforeEach(async () => {
  sessionStorage.clear();
  useServerSettings.setState({ settings: DEFAULT_SETTINGS });
  api = createMockApi({ speed: 0, autoplay: false, persist: false });
  made = (await api.simulateOrchestration("board")) as typeof made;
  await seed();
  // The ledger's held worker, given a merged PR in a worktree of its own.
  const ledger = await api.orchestratorLedger(made.workspaceId);
  busiest = ledger.features
    .flatMap((feature) => feature.workers)
    .find((worker) => worker.userIntervened)!.threadId;
  const { byId } = useThreadsStore.getState();
  const pr = Object.values(byId).find((summary) => summary.git?.pr !== undefined)!.git!.pr!;
  const held = byId[busiest]!;
  act(() =>
    useThreadsStore.setState({
      byId: {
        ...byId,
        [busiest]: {
          ...held,
          thread: { ...held.thread, checkout: { ...held.thread.checkout, kind: "worktree" } },
          git: { ...held.git!, origin: "acme/api", pr: { ...pr, state: "MERGED" } },
        },
      },
    }),
  );
  params = {};
});

afterEach(() => {
  cleanup();
  useLayoutStore.getState().closePalette();
});

/** Renders `items` as an open context menu and reads its top-level items. */
async function itemsOf(items: ReactNode): Promise<string[]> {
  const view = renderWithApi(
    <ContextMenu open>
      <ContextMenuTrigger render={<div />} />
      <ContextMenuContent>{items}</ContextMenuContent>
    </ContextMenu>,
    api,
  );
  const menu = await screen.findByRole("menu");
  await within(menu).findByRole("menuitem", { name: "More…" });
  const labels = within(menu)
    .getAllByRole("menuitem")
    .filter((item) => item.closest('[role="menu"]') === menu)
    .map(labelOf);
  view.unmount();
  return labels;
}

describe("labelWords", () => {
  it("counts a proper name once and skips marks", () => {
    expect(labelWords("Add reply to Waiting on you")).toBe(4);
    expect(labelWords("Show / hide right panel")).toBe(4);
    expect(labelWords("2 columns × 3 rows")).toBe(4);
    expect(labelWords("Next thread that needs you")).toBe(5);
  });
});

describe("context menu caps", () => {
  // Every row the overview draws for a thread gets its menu from `RowMenuItems`: the row's own
  // group, then the thread's verbs and More…. Each kind of row is checked at its fullest.
  it("keeps a solo thread's menu to the cap", async () => {
    expectCapped("solo thread", await itemsOf(<RowMenuItems threadId={"t-flaky" as ThreadId} />));
  });

  it("keeps a workspace line's menu to the cap", async () => {
    const state = (await api.listWorkspaces()).find(
      (each) => each.workspace.id === made.workspaceId,
    )!;
    expectCapped("workspace", await itemsOf(<WorkspaceMenuItems state={state} />));
  });

  it("keeps a held, merged worker's menu to the cap", async () => {
    const items = await itemsOf(
      <RowMenuItems
        threadId={busiest}
        menuItems={<WorkerMenuItems threadId={busiest} held cleanable />}
      />,
    );
    expectCapped("worker", items);
    expect(items.slice(0, 2)).toEqual(["Hand back to orchestrator", "Clean up worktree…"]);
  });

  it("keeps the pane header's thread menu to the cap", async () => {
    for (const threadId of ["t-flaky" as ThreadId, busiest, made.orchestratorThreadId]) {
      const view = renderWithApi(<ThreadMenu threadId={threadId} />, api);
      fireEvent.click(screen.getByRole("button", { name: "Thread menu" }));
      const menu = await screen.findByTestId("thread-menu");
      await within(menu).findByRole("menuitem", { name: "More…" });
      expectCapped(`header of ${threadId}`, within(menu).getAllByRole("menuitem").map(labelOf));
      view.unmount();
    }
  });

  it("keeps a folded title bar's thread menu to the cap, for a worker with a branch to push", async () => {
    // The worst case: a worker whose branch has commits to push, with the bar folded all the way.
    const { byId } = useThreadsStore.getState();
    const worker = byId[busiest]!;
    act(() =>
      useThreadsStore.setState({
        byId: {
          ...byId,
          [busiest]: {
            ...worker,
            git: { ...worker.git!, repo: true, branch: "feat/retry", upstream: "ahead" },
          },
        },
      }),
    );
    act(() => useTitlebarSlot.getState().setFold(FOLD_ALL));
    const view = renderWithApi(
      <ThreadMenu threadId={busiest} folded={{ orchestration: true, worker: true }} />,
      api,
    );
    fireEvent.click(screen.getByRole("button", { name: "Thread menu" }));
    const menu = await screen.findByTestId("thread-menu");
    await within(menu).findByRole("menuitem", { name: "More…" });
    const items = within(menu)
      .getAllByRole("menuitem")
      .filter((item) => item.closest('[role="menu"]') === menu)
      .map(labelOf);
    expectCapped("folded worker header", items);
    expect(items).toContain("Title bar");
    // The branch and its push are the agents' working detail: More… has them.
    expect(items.join(" ")).not.toMatch(/feat\/retry|Push|Publish/);
    view.unmount();
    act(() => useTitlebarSlot.getState().setFold(0));

    await openPalette("", { kind: "thread", threadId: busiest });
    expect(paletteSections()["Branch"]).toEqual(["Copy feat/retry", "Push"]);
  });

  it("reads a worker row's own group from its workspace's ledger", async () => {
    const items = await itemsOf(<WorkerRowMenuItems threadId={busiest} />);
    expect(items.slice(0, 2)).toEqual(["Hand back to orchestrator", "Clean up worktree…"]);
  });

  it("opens ⌘K scoped to the row's thread, or the orchestrator's workspace, from More…", async () => {
    const scopes: (PaletteScope | undefined)[] = [];
    for (const id of [busiest, made.orchestratorThreadId]) {
      const view = renderWithApi(
        <ContextMenu open>
          <ContextMenuTrigger render={<div />} />
          <ContextMenuContent>
            <RowMenuItems threadId={id} />
          </ContextMenuContent>
        </ContextMenu>,
        api,
      );
      fireEvent.click(await screen.findByRole("menuitem", { name: "More…" }));
      // It opens once the menu has closed and given focus back.
      await waitFor(() => expect(useLayoutStore.getState().paletteOpen).toBe(true));
      scopes.push(useLayoutStore.getState().paletteScope);
      act(() => useLayoutStore.getState().closePalette());
      view.unmount();
    }
    expect(scopes).toEqual([
      { kind: "thread", threadId: busiest },
      { kind: "workspace", workspaceId: made.workspaceId },
    ]);
  });
});

/** The palette's options, by section, as they read. */
const paletteSections = () =>
  Object.fromEntries(
    within(screen.getByTestId("command-palette"))
      .getAllByRole("group")
      .map((group) => [
        group.getAttribute("aria-label")!,
        within(group).getAllByRole("option").map(labelOf),
      ]),
  );

/** Renders the palette open on `query`, scoped or not, and waits for its commands. */
async function openPalette(query: string, scope?: PaletteScope) {
  act(() => useLayoutStore.getState().openPalette(query, scope));
  const view = renderWithApi(<CommandPalette />, api);
  await screen.findAllByRole("option");
  await new Promise((resolve) => setTimeout(resolve, 50));
  return view;
}

/** No command carries a subtitle, and every command's label is short. */
function expectNoSubtitles(name: string) {
  const palette = screen.getByTestId("command-palette");
  expect(palette.querySelectorAll("[data-palette-hint]"), name).toHaveLength(0);
  for (const option of within(palette).getAllByRole("option")) {
    const label = labelOf(option);
    expect(labelWords(label), `${name}: "${label}"`).toBeLessThanOrEqual(LABEL_WORD_CAP);
  }
}

describe("palette commands", () => {
  it("carry no subtitle and a short label, on a thread, an orchestrator and a board", async () => {
    const views: Record<string, string>[] = [
      { threadId: "t-flaky" },
      { threadId: made.orchestratorThreadId },
      { threadId: busiest },
      { workspaceId: made.workspaceId },
      {},
    ];
    for (const view of views) {
      params = view;
      const rendered = await openPalette(">");
      expectNoSubtitles(`> on ${JSON.stringify(view)}`);
      // Typed, the commands of what is in view join them, under the same caps.
      act(() => {
        fireEvent.change(screen.getByRole("combobox"), { target: { value: ">e" } });
      });
      expectNoSubtitles(`>e on ${JSON.stringify(view)}`);
      rendered.unmount();
      useLayoutStore.getState().closePalette();
    }
  });

  it("carry no subtitle in a scoped palette", async () => {
    for (const scope of [
      { kind: "thread", threadId: "t-flaky" as ThreadId },
      { kind: "thread", threadId: busiest },
      { kind: "workspace", workspaceId: made.workspaceId },
    ] satisfies PaletteScope[]) {
      const rendered = await openPalette("", scope);
      expectNoSubtitles(JSON.stringify(scope));
      rendered.unmount();
      useLayoutStore.getState().closePalette();
    }
  });

  it("fold the layouts into one Layout… with a picker", async () => {
    await openPalette(">layout");
    expect(paletteSections()).toEqual({ Commands: ["Layout…"] });
    fireEvent.click(screen.getByRole("option", { name: "Layout…" }));
    expect(Object.keys(paletteSections())).toEqual(["Layout"]);
    expect(screen.getAllByRole("option")).toHaveLength(6);
  });

  it("go to threads, workers, features and PRs first, with commands behind >", async () => {
    await openPalette("");
    const sections = Object.keys(paletteSections());
    expect(sections.slice(0, 4)).toEqual(["Threads", "Workers", "Features", "Pull requests"]);
    expect(sections).not.toContain("Commands");
  });
});

describe("what left the menus", () => {
  it("is in a worker's More…", async () => {
    // A held worker's verbs come from the workspace's ledger, which can load after the palette
    // has opened and settled, as it did on a busy CI runner: held back here until then.
    const ledger = api.orchestratorLedger.bind(api);
    let release!: () => void;
    const loaded = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(api, "orchestratorLedger").mockImplementation(async (...args) => {
      await loaded;
      return ledger(...args);
    });
    const watch = api.watchLedger.bind(api);
    vi.spyOn(api, "watchLedger").mockImplementation(async function* (...args) {
      await loaded;
      yield* watch(...args);
    });
    await openPalette("", { kind: "thread", threadId: busiest });
    release();
    await waitFor(() =>
      expect(Object.values(paletteSections()).flat()).toEqual(
        expect.arrayContaining([
          "Open in pane…",
          "Open in new window",
          "Worktrees…",
          "Label…",
          "Restart session",
          "Go to orchestrator",
          "Open board",
          "Hand back to orchestrator",
          "Remove from workspace",
          "Bind PR…",
        ]),
      ),
    );
  });

  it("is in a plain thread's More…, Fork thread among it", async () => {
    await openPalette("", { kind: "thread", threadId: "t-flaky" as ThreadId });
    expect(Object.values(paletteSections()).flat()).toEqual(
      expect.arrayContaining([
        "Open in pane…",
        "Open in new window",
        "Worktrees…",
        "Fork thread",
        "Fork into worktree…",
        "Open folder in editor",
      ]),
    );
  });

  it("lists what can't run now, dimmed, and says why when it is picked", async () => {
    const fork = vi.spyOn(api, "forkThread");
    await openPalette("", { kind: "thread", threadId: busiest });
    const option = screen.getByRole("option", { name: "Fork thread" });
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(option.getAttribute("title")).toBeTruthy();
    fireEvent.click(option);
    expect(fork).not.toHaveBeenCalled();
    expect(useLayoutStore.getState().paletteOpen).toBe(true);
  });

  it("is in the workspace's More…, with the orchestrator's thread verbs", async () => {
    await openPalette("", { kind: "workspace", workspaceId: made.workspaceId });
    const sections = paletteSections();
    expect(sections["Workspace"]).toEqual(
      expect.arrayContaining([
        "Add repository…",
        "New workspace like this…",
        "Remove workspace…",
        "Open memory",
        "Pause workspace",
      ]),
    );
    expect(sections["Thread"]).toEqual(
      expect.arrayContaining(["Pin thread", "Fresh session…", "Restart session", "Label…"]),
    );
  });
});
