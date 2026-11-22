// @vitest-environment happy-dom
import type { FsFile, GramUIMessage, ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiThreadFeedEvent } from "@/api/types";
import { renderWithApi } from "@/panels/test-utils";
import { useLayoutStore } from "@/stores/layout";

import { FilePreviewPlace, PreviewFileCard } from "./preview-file-card";

const PATH = "/home/dev/repo/.worktrees/feat-x/docs/design/plan.md";
const WRITTEN = "# The plan\n\nWritten by the worker.";

const { previewFile } = useLayoutStore.getState();

afterEach(() => {
  cleanup();
  useLayoutStore.setState({ previewFile });
});

const feedOf = (messages: readonly unknown[]) =>
  async function* threadFeed(_id: ThreadId, signal: AbortSignal) {
    yield { type: "subscribed" } as ApiThreadFeedEvent;
    yield { type: "messages", messages: messages as GramUIMessage[] } as ApiThreadFeedEvent;
    yield { type: "caughtUp" } as ApiThreadFeedEvent;
    await new Promise((resolve) => signal.addEventListener("abort", resolve));
  };

const wrote = {
  id: "m-1",
  role: "assistant",
  parts: [
    {
      type: "tool-Write",
      toolCallId: "c-1",
      state: "output-available",
      input: { file_path: PATH, content: WRITTEN },
      output: "ok",
    },
  ],
};

let n = 0;
const card = (fsFile: (path: string) => Promise<FsFile>, place: "tab" | "window") => {
  const threadId = `t-preview-card-${++n}` as ThreadId;
  const shown = vi.fn();
  useLayoutStore.setState({ previewFile: shown });
  const api = { fsFile: vi.fn(fsFile), threadFeed: feedOf([wrote]) };
  renderWithApi(
    <FilePreviewPlace value={place}>
      <PreviewFileCard threadId={threadId} file={{ path: PATH, kind: "markdown" }} />
    </FilePreviewPlace>,
    api,
  );
  fireEvent.click(screen.getByRole("button", { name: "Preview plan.md" }));
  return { threadId, shown, api };
};

describe("PreviewFileCard", () => {
  it("opens the Preview tab beside a thread in the main view", () => {
    const { threadId, shown } = card(() => Promise.reject(new Error("not read here")), "tab");
    expect(shown).toHaveBeenCalledWith(threadId, PATH, { previewPane: expect.any(Boolean) });
    expect(screen.queryByTestId("file-quick-look")).toBeNull();
  });

  // Before: the right pane always shows the worker, so the Preview tab it switched to never showed.
  it("opens a window reading the worker's file from the right pane", async () => {
    const { threadId, shown, api } = card(
      async (path) => ({ path, size: 9, binary: false, tooLarge: false, content: "# On disk" }),
      "window",
    );
    expect(shown).not.toHaveBeenCalled();
    const window = await screen.findByTestId("file-quick-look");
    await waitFor(() => expect(window.textContent).toContain("On disk"));
    expect(api.fsFile).toHaveBeenCalledWith(PATH, { threadId });
    expect(screen.getByTestId("file-quick-look-open-tab")).toBeTruthy();
  });

  it("shows what the worker last wrote when the file is no longer in its folder", async () => {
    card(
      (path) =>
        Promise.reject(
          Object.assign(new Error(`Not found: ${path}`), { _tag: "NotFound", id: path }),
        ),
      "window",
    );
    const note = await screen.findByTestId("file-preview-written");
    expect(note.textContent).toContain("No longer in the thread's folder");
    expect(screen.getByTestId("file-quick-look").textContent).toContain("Written by the worker.");
  });
});
