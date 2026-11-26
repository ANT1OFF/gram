// @vitest-environment happy-dom
import { InvalidState, NotFound, type ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DiffPanel } from "./diff-panel";
import { PrPanel } from "./pr-panel";
import { renderInRouter } from "./test-utils";

afterEach(cleanup);

const threadId = "t-gone" as ThreadId;

describe("missing thread folder", () => {
  it("shows a friendly state in the diff panel and closes the thread", async () => {
    const closeThread = vi.fn(async () => ({}));
    // In the thread's own route, so closing it visibly leaves for Home.
    const { router } = await renderInRouter(<DiffPanel threadId={threadId} />, {
      path: `/t/${threadId}`,
      api: {
        gitDiff: async () => {
          throw new NotFound({ entity: "project", id: "/Users/j/repo." });
        },
        closeThread,
      },
    });

    expect(await screen.findByText("This thread's folder doesn't exist.")).toBeTruthy();
    expect(screen.queryByText(/FileSystem|NotFound/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close thread" }));
    await waitFor(() => expect(closeThread).toHaveBeenCalledWith(threadId));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("names a path that isn't a folder in the PR panel", async () => {
    await renderInRouter(<PrPanel threadId={threadId} />, {
      api: {
        prDetail: async () => {
          throw new InvalidState({ message: "Not a folder: /Users/j/file.txt" });
        },
      },
    });
    expect(await screen.findByText("This thread's folder isn't a folder.")).toBeTruthy();
  });

  it("keeps other failures as the generic error state", async () => {
    await renderInRouter(<DiffPanel threadId={threadId} />, {
      api: {
        gitDiff: async () => {
          throw new Error("git exploded");
        },
      },
    });
    expect(await screen.findByText("The diff failed to load.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close thread" })).toBeNull();
  });
});
