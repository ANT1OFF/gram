// @vitest-environment happy-dom
import type { DraftStash, StashId, ThreadId } from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Api } from "@/api/types";
import { renderWithApi } from "@/panels/test-utils";

import { StashMenu, stashPreview } from "./stash-menu";
import { useStashMenuStore } from "./stash-store";

afterEach(() => {
  cleanup();
  useStashMenuStore.setState({ openFor: undefined });
});

const threadId = "t-stash" as ThreadId;
const stash = (id: string, text: string, attachments = 0): DraftStash => ({
  id: id as StashId,
  threadId,
  text,
  attachments: Array.from({ length: attachments }, (_, i) => ({
    path: `/data/attachments/t-stash/${i}.png`,
    name: `${i}.png`,
  })),
  createdAt: Date.now() - 60_000,
});

describe("stashPreview", () => {
  it("shows the first line, or what was attached when there's no text", () => {
    expect(stashPreview(stash("s1", "  first line\nsecond"))).toBe("first line");
    expect(stashPreview(stash("s2", "", 1))).toBe("1 attachment");
    expect(stashPreview(stash("s3", " ", 3))).toBe("3 attachments");
  });
});

describe("StashMenu", () => {
  it("stays hidden while the thread has no stashes", async () => {
    const listStashes = vi.fn(async () => []);
    renderWithApi(<StashMenu threadId={threadId} onRestore={vi.fn()} onError={vi.fn()} />, {
      listStashes,
    } as Partial<Api>);
    await waitFor(() => expect(listStashes).toHaveBeenCalledWith(threadId));
    expect(screen.queryByTestId("stash-trigger")).toBeNull();
  });

  it("lists stashes, restores one and discards another", async () => {
    let stored = [stash("s-new", "newer draft"), stash("s-old", "older draft", 2)];
    const api: Partial<Api> = {
      listStashes: vi.fn(async () => stored),
      removeStash: vi.fn(async (_thread: ThreadId, id: StashId) => {
        stored = stored.filter((s) => s.id !== id);
      }),
    };
    const onRestore = vi.fn();
    const live = ["/data/attachments/t-stash/live-draft.png"];
    renderWithApi(
      <StashMenu threadId={threadId} onRestore={onRestore} onError={vi.fn()} keep={live} />,
      api,
    );

    const trigger = await screen.findByTestId("stash-trigger");
    expect(trigger.getAttribute("aria-label")).toBe("Stashed drafts (2)");
    expect(trigger.textContent).toBe("2");
    fireEvent.click(trigger);
    const menu = await screen.findByTestId("stash-menu");
    expect(menu.textContent).toContain("newer draft");
    expect(menu.textContent).toContain("older draft");

    fireEvent.click(screen.getByRole("button", { name: "Discard draft: older draft" }));
    // The composer's live draft keeps its uploads when a stash is discarded.
    await waitFor(() => expect(api.removeStash).toHaveBeenCalledWith(threadId, "s-old", live));
    await waitFor(() => expect(screen.getByTestId("stash-trigger").textContent).toBe("1"));

    fireEvent.click(screen.getByRole("button", { name: "Restore draft: newer draft" }));
    expect(onRestore).toHaveBeenCalledWith(expect.objectContaining({ id: "s-new" }));
    expect(useStashMenuStore.getState().openFor).toBeUndefined();
  });

  it("opens from the store, as the ⌘K action does", async () => {
    renderWithApi(<StashMenu threadId={threadId} onRestore={vi.fn()} onError={vi.fn()} />, {
      listStashes: vi.fn(async () => [stash("s1", "from the palette")]),
    } as Partial<Api>);
    await screen.findByTestId("stash-trigger");
    act(() => useStashMenuStore.getState().open(threadId));
    expect((await screen.findByTestId("stash-menu")).textContent).toContain("from the palette");
  });
});
