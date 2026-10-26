// @vitest-environment happy-dom
import type { ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithApi } from "@/panels/test-utils";
import { useThreadsStore } from "@/stores/threads";

import { revealLabel, useRevealInFileManager } from "./use-open-in-editor";

function RevealButton({ path }: { path: string }) {
  const reveal = useRevealInFileManager();
  return (
    <button type="button" onClick={() => void reveal(path, { threadId: "t-1" as ThreadId })}>
      {revealLabel()}
    </button>
  );
}

const spyNotify = () =>
  vi.spyOn(useThreadsStore.getState(), "applyEvent").mockImplementation(() => {});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "gram");
  vi.restoreAllMocks();
});

describe("useRevealInFileManager", () => {
  it("asks the server outside the desktop app", async () => {
    const notify = spyNotify();
    const revealPath = vi.fn().mockResolvedValue({ manager: "Finder" });
    renderWithApi(<RevealButton path="/repo/src/a.ts" />, { revealPath });

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "info", title: "Showing in Finder", body: "a.ts" }),
      ),
    );
    expect(revealPath).toHaveBeenCalledWith("/repo/src/a.ts", { threadId: "t-1" });
  });

  it("uses the desktop shell when it can show items", async () => {
    const notify = spyNotify();
    const showItemInFolder = vi.fn().mockResolvedValue(true);
    Object.assign(window, { gram: { platform: "win32", showItemInFolder } });
    const revealPath = vi.fn();
    renderWithApi(<RevealButton path={"C:\\repo\\a.ts"} />, { revealPath });

    fireEvent.click(screen.getByRole("button", { name: "Show in Explorer" }));

    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "info", title: "Showing in Explorer", body: "a.ts" }),
      ),
    );
    expect(showItemInFolder).toHaveBeenCalledWith("C:\\repo\\a.ts");
    expect(revealPath).not.toHaveBeenCalled();
  });

  it("reports a path the shell couldn't find", async () => {
    const notify = spyNotify();
    Object.assign(window, {
      gram: { platform: "darwin", showItemInFolder: vi.fn().mockResolvedValue(false) },
    });
    renderWithApi(<RevealButton path="/gone.ts" />, {});

    fireEvent.click(screen.getByRole("button", { name: "Reveal in Finder" }));

    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "error",
          title: "Couldn't show it in Finder",
          body: "Not found: /gone.ts",
        }),
      ),
    );
  });
});
