// @vitest-environment happy-dom
import type { ThreadId } from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockApi, type MockApi } from "@/api/mock";
import { renderWithApi } from "@/panels/test-utils";
import { CommandPalette } from "@/palette/command-palette";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import { useThreadDialogs } from "./thread-dialogs-store";
import { ThreadMenu } from "./thread-menu";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));

const FLAKY = "t-flaky" as ThreadId;
let api: MockApi;

beforeEach(async () => {
  api = createMockApi({ speed: 0, autoplay: false });
  const abort = new AbortController();
  for await (const event of api.events(abort.signal)) {
    useThreadsStore.getState().applyEvent(event);
    if (event.type === "threads.snapshot") break;
  }
  abort.abort();
});

afterEach(() => {
  cleanup();
  useThreadDialogs.setState({ dialog: undefined, error: undefined });
});

const openMenu = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Thread menu" }));
  return screen.findByTestId("thread-menu");
};

/** The menu's More…: ⌘K on the thread's own commands, its scope showing. */
const openMore = async () => {
  await openMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: "More…" }));
  return screen.findByTestId("palette-scope");
};

describe("ThreadMenu thread actions", () => {
  it("pins and parks the thread", async () => {
    const pin = vi.spyOn(api, "pin");
    const park = vi.spyOn(api, "park");
    renderWithApi(<ThreadMenu threadId={FLAKY} />, api);

    await openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pin" }));
    await waitFor(() => expect(pin).toHaveBeenCalledWith(FLAKY, true));

    await openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Park" }));
    await waitFor(() => expect(park).toHaveBeenCalledWith(FLAKY, true));
  });

  it("opens the rename and close dialogs", async () => {
    renderWithApi(<ThreadMenu threadId={FLAKY} />, api);

    await openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    expect(useThreadDialogs.getState().dialog).toEqual({ kind: "rename", threadId: FLAKY });

    await openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Close thread…" }));
    expect(useThreadDialogs.getState().dialog).toEqual({ kind: "close", threadId: FLAKY });
  });

  it("detaches a worker from its orchestrator through More…, and offers it to no other thread", async () => {
    const made = await api.simulateOrchestration();
    const abort = new AbortController();
    void (async () => {
      for await (const event of api.events(abort.signal)) {
        useThreadsStore.getState().applyEvent(event);
      }
    })();
    await waitFor(() =>
      expect(useThreadsStore.getState().byId[made.workerThreadId]?.thread.spawnedBy).toBeDefined(),
    );

    // Both through the menu's More…, which opens ⌘K on the thread's own commands.
    const plain = renderWithApi(
      <>
        <ThreadMenu threadId={FLAKY} />
        <CommandPalette />
      </>,
      api,
    );
    await openMore();
    await screen.findByRole("option", { name: /^Rename thread…/ });
    expect(screen.queryByRole("option", { name: "Remove from workspace" })).toBeNull();
    act(() => useLayoutStore.getState().closePalette());
    plain.unmount();

    renderWithApi(
      <>
        <ThreadMenu threadId={made.workerThreadId} />
        <CommandPalette />
      </>,
      api,
    );
    await openMore();
    fireEvent.click(await screen.findByRole("option", { name: "Remove from workspace" }));
    await waitFor(() =>
      expect(
        useThreadsStore.getState().byId[made.workerThreadId]?.thread.spawnedBy,
      ).toBeUndefined(),
    );
    abort.abort();
  });
});
