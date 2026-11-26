// @vitest-environment happy-dom
import type { ThreadId, WaitId, WaitItem } from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Api } from "@/api/types";
import { renderInRouter } from "@/panels/test-utils";
import { useThreadsStore } from "@/stores/threads";

import { WaitingTray } from "./waiting-tray";

// Every item on Waiting on you ends one of three ways: done, dismissed by the user without doing
// it, or withdrawn by its thread or that thread's orchestrator. The tray records each as itself.

afterEach(() => {
  cleanup();
  act(() => useThreadsStore.setState({ byId: {} }));
});

const T = "t-worker" as ThreadId;
const ORCH = "t-orch" as ThreadId;
const now = Date.now();

const item = (id: string, more: Partial<WaitItem> = {}): WaitItem => ({
  id: id as WaitId,
  kind: "action",
  title: `Item ${id}`,
  source: "agent",
  createdAt: now - 60 * 60_000,
  ...more,
});

const showing = (waits: readonly WaitItem[]) =>
  act(() =>
    useThreadsStore.setState({
      byId: {
        [T]: { thread: { id: T, title: "Cart API" }, waits },
        [ORCH]: { thread: { id: ORCH, title: "Orchestrator · shop" } },
      } as never,
    }),
  );

const tray = () => screen.getByTestId("waiting-tray");

describe("WaitingTray endings", () => {
  it("Dismiss takes an item off as dismissed, with why, rather than done", async () => {
    const open = item("w-1");
    showing([open]);
    const api = {
      resolveWait: vi.fn(async () => open),
      dismissWait: vi.fn(async () => open),
      listWaits: vi.fn(async () => []),
    } satisfies Partial<Api>;
    await renderInRouter(<WaitingTray threadId={T} />, { api });
    fireEvent.click(within(tray()).getByRole("button", { expanded: false }));
    const row = within(tray()).getByTestId("waiting-item");

    fireEvent.click(within(row).getByTestId("waiting-dismiss"));
    fireEvent.change(within(row).getByTestId("waiting-dismiss-note"), {
      target: { value: "The deploy job runs it now" },
    });
    fireEvent.submit(within(row).getByTestId("waiting-dismiss-form"));

    expect(api.dismissWait).toHaveBeenCalledWith(T, "w-1", "The deploy job runs it now");
    expect(api.resolveWait).not.toHaveBeenCalled();
    showing([]);
    expect(within(tray()).getByTestId("waiting-undo-row").dataset["ending"]).toBe("dismissed");
  });

  it("Escape steps back from Dismiss, and a blank reason dismisses without one", async () => {
    const open = item("w-1");
    showing([open]);
    const api = {
      resolveWait: vi.fn(async () => open),
      dismissWait: vi.fn(async () => open),
      listWaits: vi.fn(async () => []),
    } satisfies Partial<Api>;
    await renderInRouter(<WaitingTray threadId={T} />, { api });
    fireEvent.click(within(tray()).getByRole("button", { expanded: false }));
    const row = within(tray()).getByTestId("waiting-item");

    fireEvent.click(within(row).getByTestId("waiting-dismiss"));
    fireEvent.keyDown(within(row).getByTestId("waiting-dismiss-note"), { key: "Escape" });
    expect(within(row).queryByTestId("waiting-dismiss-form")).toBeNull();

    fireEvent.click(within(row).getByTestId("waiting-dismiss"));
    fireEvent.change(within(row).getByTestId("waiting-dismiss-note"), {
      target: { value: "   " },
    });
    fireEvent.click(within(row).getByTestId("waiting-dismiss-confirm"));
    expect(api.dismissWait).toHaveBeenCalledWith(T, "w-1", undefined);
  });

  it("the resolved list shows each item as it ended, and who withdrew it", async () => {
    const at = now - 5 * 60_000;
    const resolved = [
      item("w-2", { resolvedAt: at, resolvedBy: "user" }),
      item("w-3", { resolvedAt: at, resolvedBy: "user", ending: "dismissed", note: "moot" }),
      item("w-4", {
        resolvedAt: at,
        resolvedBy: "agent",
        ending: "withdrawn",
        resolverThread: ORCH,
        note: "the deploy job runs it",
      }),
    ];
    showing([item("w-1")]);
    await renderInRouter(<WaitingTray threadId={T} />, {
      api: { listWaits: vi.fn(async () => resolved) },
    });
    fireEvent.click(within(tray()).getByRole("button", { expanded: false }));
    const line = await waitFor(() => within(tray()).getByTestId("waiting-resolved"));
    fireEvent.click(within(line).getByRole("button"));

    const rows = within(line).getAllByTestId("waiting-resolved-item");
    expect(rows.map((row) => row.dataset["ending"])).toEqual(["done", "dismissed", "withdrawn"]);
    expect(rows[1]!.textContent).toContain("moot");
    expect(rows[2]!.textContent).toContain("Orchestrator · shop");
    expect(rows[2]!.textContent).toContain("the deploy job runs it");
  });
});
