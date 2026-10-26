// @vitest-environment happy-dom
import { DEFAULT_SETTINGS } from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockApi, type MockApi } from "@/api/mock";
import { renderWithApi } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";
import { useThreadsStore } from "@/stores/threads";

import { OutputsView } from "./outputs-view";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

let api: MockApi;
let workspaceId: Awaited<ReturnType<MockApi["simulateOrchestration"]>>["workspaceId"];

beforeEach(async () => {
  // The scenario's newest output is 40 minutes old: keep this "Today" fixture away from midnight.
  vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 9, 16, 12).getTime());
  useServerSettings.setState({
    settings: { ...DEFAULT_SETTINGS },
  });
  api = createMockApi({ speed: 0, autoplay: false, persist: false });
  ({ workspaceId } = await api.simulateOrchestration("board"));
  const abort = new AbortController();
  for await (const event of api.events(abort.signal)) {
    act(() => useThreadsStore.getState().applyEvent(event));
    if (event.type === "threads.snapshot") break;
  }
  abort.abort();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  navigate.mockReset();
  useThreadsStore.setState({ byId: {} });
});

const tiles = () => screen.getAllByTestId("output-tile");

describe("OutputsView", () => {
  it("shows the workspace's outputs as tiles by day, one-line labels with a 24-hour time", async () => {
    const listOutputs = vi.spyOn(api, "listOutputs");
    renderWithApi(<OutputsView workspaceId={workspaceId} />, api);
    await waitFor(() => expect(tiles().length).toBeGreaterThan(5));
    expect(listOutputs).toHaveBeenCalledWith(workspaceId, {});
    const groups = screen.getAllByTestId("output-group");
    expect(groups[0]?.getAttribute("aria-label")).toBe("Today");
    for (const tile of tiles()) {
      expect(tile.textContent).toMatch(/^\S+\.(png|gif|md|svg|pdf|txt)\d{2}:\d{2}$/);
    }
    // Every worker of the board scenario made something; the orchestrator its plan.
    const threads = new Set(tiles().map((tile) => tile.getAttribute("data-thread-id")));
    expect(threads.size).toBeGreaterThan(3);
  });

  it("filters by kind on the server, and groups by feature", async () => {
    const listOutputs = vi.spyOn(api, "listOutputs");
    renderWithApi(<OutputsView workspaceId={workspaceId} />, api);
    await waitFor(() => expect(tiles().length).toBeGreaterThan(5));
    fireEvent.click(screen.getByRole("radio", { name: "Recordings" }));
    await waitFor(() =>
      expect(tiles().every((tile) => tile.getAttribute("data-kind") === "recording")).toBe(true),
    );
    expect(listOutputs).toHaveBeenLastCalledWith(workspaceId, { kind: "recording" });
    fireEvent.click(screen.getByRole("radio", { name: "All" }));
    fireEvent.click(screen.getByRole("radio", { name: "Feature" }));
    await waitFor(() =>
      expect(
        screen.getAllByTestId("output-group").map((group) => group.getAttribute("aria-label")),
      ).toContain("mail-trigger"),
    );
  });

  it("opens a screenshot at full size through its thread, and a document in its thread", async () => {
    const fsImage = vi.spyOn(api, "fsImage");
    renderWithApi(<OutputsView workspaceId={workspaceId} />, api);
    await waitFor(() => expect(tiles().length).toBeGreaterThan(5));
    const shot = tiles().find((tile) => tile.getAttribute("data-kind") === "screenshot")!;
    const name = shot.textContent!.replace(/\d{2}:\d{2}$/, "");
    fireEvent.click(within(shot).getByRole("button", { name: `Open ${name}` }));
    const viewer = await screen.findByTestId("output-viewer");
    await waitFor(() => expect(within(viewer).getByRole("img")).toBeTruthy());
    const threadId = shot.getAttribute("data-thread-id");
    expect(fsImage.mock.calls.some(([, options]) => options?.threadId === threadId)).toBe(true);
    fireEvent.click(within(viewer).getByTestId("output-viewer-thread"));
    expect(navigate).toHaveBeenLastCalledWith({ to: "/t/$threadId", params: { threadId } });

    const doc = tiles().find(
      (tile) =>
        tile.getAttribute("data-kind") === "document" &&
        tile.getAttribute("data-openable") === "true",
    )!;
    fireEvent.click(within(doc).getAllByRole("button")[0]!);
    expect(navigate).toHaveBeenLastCalledWith({
      to: "/t/$threadId",
      params: { threadId: doc.getAttribute("data-thread-id") },
    });
  });

  it("offers no Open for a document sent from outside its thread's checkouts", async () => {
    renderWithApi(<OutputsView workspaceId={workspaceId} />, api);
    await waitFor(() => expect(tiles().length).toBeGreaterThan(5));
    const away = tiles().find((tile) => tile.textContent?.includes("-summary.txt"))!;
    expect(away.getAttribute("data-openable")).toBe("false");
    expect(within(away).queryByRole("button", { name: /^Open .*summary/ })).toBeNull();
    expect(within(away).getByTestId("output-open-thread")).toBeTruthy();
  });

  it("says so when nothing was made yet", async () => {
    vi.spyOn(api, "listOutputs").mockResolvedValue({ outputs: [] });
    renderWithApi(<OutputsView workspaceId={workspaceId} />, api);
    expect((await screen.findByTestId("outputs-empty")).textContent).toBe("No files yet");
  });
});
