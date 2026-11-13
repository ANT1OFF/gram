// @vitest-environment happy-dom
import type { ThreadId } from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createMockApi } from "@/api/mock";
import { renderWithRouter } from "@/panels/test-utils";

import { PeekSheet } from "./peek-sheet";
import { peek, usePeekStore } from "./peek-store";

afterEach(() => {
  cleanup();
  usePeekStore.setState({ open: false, target: undefined, container: undefined });
});

describe("PeekSheet", () => {
  it("draws nothing until a peek is asked for", () => {
    renderWithRouter(<PeekSheet />, createMockApi());
    expect(screen.queryByTestId("peek-sheet")).toBeNull();
  });

  it("opens on a worker once its body has loaded, and closes from its button", async () => {
    renderWithRouter(<PeekSheet />, createMockApi());
    act(() => peek({ kind: "worker", threadId: "t-peek" as ThreadId, title: "Trim first paint" }));

    const sheet = await screen.findByTestId("peek-sheet");
    expect(sheet.dataset["kind"]).toBe("worker");
    expect(screen.getByTestId("peek-title").textContent).toBe("Trim first paint");
    expect(screen.getByTestId("peek-open")).toBeTruthy();

    fireEvent.click(screen.getByTestId("peek-close"));
    expect(usePeekStore.getState().open).toBe(false);
    await waitFor(() => expect(screen.queryByTestId("peek-sheet")).toBeNull());
  });

  it("opens on a PR with its Diff action", async () => {
    renderWithRouter(<PeekSheet />, createMockApi());
    act(() =>
      peek({ kind: "pr", threadId: "t-peek" as ThreadId, repo: "acme/widgets", number: 12 }),
    );

    const sheet = await screen.findByTestId("peek-sheet");
    expect(sheet.dataset["kind"]).toBe("pr");
    expect(screen.getByTestId("peek-pr-diff")).toBeTruthy();
  });
});
