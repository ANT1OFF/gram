// @vitest-environment happy-dom
import { DEFAULT_SETTINGS, type ThreadId, type PaletteFilter } from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMockApi, type MockApi } from "@/api/mock";
import { renderWithApi } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { CommandPalette } from "./command-palette";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate, useParams: () => ({}) }));
let api: MockApi;
beforeEach(async () => {
  sessionStorage.clear();
  useServerSettings.setState({ settings: { ...DEFAULT_SETTINGS, helpers: { enabled: false } } });
  api = createMockApi({ speed: 0, autoplay: false, persist: false });
  await api.simulateOrchestration("board");
  const abort = new AbortController();
  for await (const event of api.events(abort.signal)) {
    act(() => useThreadsStore.getState().applyEvent(event));
    if (event.type === "threads.snapshot") break;
  }
  abort.abort();
  navigate.mockClear();
});
afterEach(() => {
  cleanup();
  useLayoutStore.getState().closePalette();
  vi.useRealTimers();
});
const open = (query: string) => {
  useLayoutStore.getState().openPalette(query);
  renderWithApi(<CommandPalette />, api);
  return screen.getByRole("combobox", { name: "Go to, or > for commands" });
};
it("renders plain matches before parsing and keeps them first after filters change", async () => {
  // The literal title matches the whole sentence, independently of its worker filter.
  const { byId } = useThreadsStore.getState();
  const plain = Object.values(byId).find((s) => !s.thread.spawnedBy)!;
  useThreadsStore.setState({
    byId: {
      ...byId,
      [plain.thread.id]: { ...plain, thread: { ...plain.thread, title: "workers waiting on me" } },
    },
  });
  open("workers waiting on me");
  expect(screen.getByRole("group", { name: "Threads" }).textContent).toContain(
    "workers waiting on me",
  );
  expect(screen.queryByRole("group", { name: "Filtered results" })).toBeNull();
  await screen.findByRole("combobox", { name: "Kind" });
  const groups = screen.getAllByRole("group");
  expect(groups[0]?.getAttribute("aria-label")).toBe("Threads");
  expect(groups.at(-1)?.getAttribute("aria-label")).toBe("Filtered results");
  fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), { target: { value: "pr" } });
  expect(screen.getByRole("group", { name: "Threads" }).textContent).toContain(
    "workers waiting on me",
  );
});
it("edits and removes chips with keyboard without changing typing or navigating", async () => {
  const input = open("workers waiting on me");
  const kind = await screen.findByRole("combobox", { name: "Kind" });
  fireEvent.keyDown(kind, { key: "ArrowDown" });
  expect((kind as HTMLSelectElement).value).toBe("pr");
  fireEvent.keyDown(kind, { key: "ArrowUp" });
  expect((kind as HTMLSelectElement).value).toBe("worker");
  const filtered = screen.getByRole("group", { name: "Filtered results" });
  const before = filtered.textContent;
  fireEvent.change(kind, { target: { value: "thread" } });
  expect(filtered.textContent).not.toBe(before);
  fireEvent.keyDown(kind, { key: "Delete" });
  expect(screen.queryByRole("combobox", { name: "Kind" })).toBeNull();
  expect(document.activeElement).toBe(input);
  expect((input as HTMLInputElement).value).toBe("workers waiting on me");
  const home = new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true });
  input.dispatchEvent(home);
  expect(home.defaultPrevented).toBe(false);
  const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  input.dispatchEvent(tab);
  expect(tab.defaultPrevented).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
});
it("keeps edited and removed chips when typing continues", async () => {
  const input = open("workers waiting on me");
  const kind = await screen.findByRole("combobox", { name: "Kind" });
  fireEvent.change(kind, { target: { value: "pr" } });
  fireEvent.change(input, { target: { value: "workers waiting on me ack" } });
  await waitFor(() =>
    expect((screen.getByRole("combobox", { name: "Kind" }) as HTMLSelectElement).value).toBe("pr"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Remove kind" }));
  fireEvent.change(input, { target: { value: "workers waiting on me ack retry" } });
  await screen.findByRole("combobox", { name: "State" });
  expect(screen.queryByRole("combobox", { name: "Kind" })).toBeNull();
});
it("runs unmodified message search and shows helper proposals without applying them", async () => {
  useServerSettings.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      helpers: { enabled: true, source: "codex", codexContext: "conversation", suggest: true },
    },
  });
  let resolve!: (value: readonly PaletteFilter[]) => void;
  const suggest = vi.spyOn(api, "paletteFilters").mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const search = vi.spyOn(api, "searchThreads").mockResolvedValue({
    hits: [
      {
        threadId: "t-flaky" as ThreadId,
        title: "Literal match",
        snippet: "the broken builds around here",
        highlights: [],
      },
    ],
    truncated: false,
  } as Awaited<ReturnType<MockApi["searchThreads"]>>);
  open("the broken builds around here");
  await waitFor(() =>
    expect(search).toHaveBeenCalledWith("the broken builds around here", { limit: 20 }),
  );
  expect(suggest).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole("button", { name: "Suggest filters" }));
  await waitFor(() => expect(suggest).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("group", { name: "Messages" }).textContent).toContain("Literal match");
  await act(async () => resolve([{ field: "state", value: "failing" }]));
  const add = await screen.findByRole("button", { name: "Add Checks failing" });
  expect(screen.queryByRole("combobox", { name: "State" })).toBeNull();
  expect(screen.queryByRole("group", { name: "Filtered results" })).toBeNull();
  expect(navigate).not.toHaveBeenCalled();
  fireEvent.click(add);
  expect((screen.getByRole("combobox", { name: "State" }) as HTMLSelectElement).value).toBe(
    "failing",
  );
  expect(screen.getAllByRole("group")[0]?.getAttribute("aria-label")).toBe("Messages");
  expect(
    within(screen.getByRole("group", { name: "Filtered results" })).queryAllByRole("option").length,
  ).toBeGreaterThan(0);
});
it("lets Tab reach optional helper controls when a literal row has a command scope", async () => {
  useServerSettings.setState({
    settings: { ...DEFAULT_SETTINGS, helpers: { enabled: true, codexContext: "conversation" } },
  });
  const { byId } = useThreadsStore.getState();
  const plain = Object.values(byId).find((summary) => !summary.thread.spawnedBy)!;
  useThreadsStore.setState({
    byId: {
      ...byId,
      [plain.thread.id]: {
        ...plain,
        thread: { ...plain.thread, title: "show broken builds please" },
      },
    },
  });
  const input = open("show broken builds please");
  await screen.findByRole("button", { name: "Suggest filters" });
  const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  input.dispatchEvent(tab);
  expect(tab.defaultPrevented).toBe(false);
  expect(screen.queryByTestId("palette-scope")).toBeNull();
});
it("discards late helper proposals when the sentence changes", async () => {
  useServerSettings.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      helpers: { enabled: true, source: "codex", codexContext: "conversation", suggest: true },
    },
  });
  let resolve!: (value: readonly PaletteFilter[]) => void;
  vi.spyOn(api, "paletteFilters").mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const input = open("show broken builds please");
  fireEvent.click(await screen.findByRole("button", { name: "Suggest filters" }));
  await waitFor(() => expect(resolve).toBeDefined());
  fireEvent.change(input, { target: { value: "different sentence now" } });
  await act(async () => resolve([{ field: "state", value: "failing" }]));
  expect(screen.queryByRole("button", { name: "Add Checks failing" })).toBeNull();
});
it("keeps command mode free of word filters and helpers", async () => {
  open(">workers waiting on me");
  await waitFor(() => expect(screen.queryByLabelText("Search filters")).toBeNull());
  expect(screen.queryByRole("group", { name: "Filtered results" })).toBeNull();
  expect(
    within(screen.getByTestId("command-palette")).queryByRole("combobox", { name: "Kind" }),
  ).toBeNull();
});
