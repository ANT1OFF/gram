// @vitest-environment happy-dom
import type { DiffScope, ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MOCK_DEPS_TURN, mockDiff } from "@/api/mock-git";
import { renderWithApi } from "@/panels/test-utils";
import { useLayoutStore } from "@/stores/layout";

import { TurnFilesChip } from "./turn-files-chip";

const T = "t-deps" as ThreadId;

afterEach(() => {
  cleanup();
  useLayoutStore.setState({ panelTargets: {} });
});

describe("TurnFilesChip", () => {
  it("counts a turn's changed files and opens the Diff panel at that turn", async () => {
    const gitDiff = vi.fn(async (threadId: ThreadId, scope: DiffScope) =>
      mockDiff(threadId, scope),
    );
    renderWithApi(<TurnFilesChip threadId={T} turnId={MOCK_DEPS_TURN} />, { gitDiff });

    const chip = await screen.findByTestId("turn-files-chip");
    expect(chip.textContent).toBe("2 files changed");
    expect(gitDiff).toHaveBeenCalledWith(T, { kind: "turn", turnId: MOCK_DEPS_TURN });

    fireEvent.click(chip);
    expect(useLayoutStore.getState().panelTab).toBe("diff");
    expect(useLayoutStore.getState().panelTargets.diff).toMatchObject({
      threadId: T,
      target: `turn:${MOCK_DEPS_TURN}`,
    });
  });

  it("stays hidden for a turn that changed nothing or has no checkpoint", async () => {
    const empty = vi.fn(async () => ({ repo: true, files: [] }));
    const { unmount } = renderWithApi(<TurnFilesChip threadId={T} turnId={MOCK_DEPS_TURN} />, {
      gitDiff: empty,
    });
    await waitFor(() => expect(empty).toHaveBeenCalled());
    expect(screen.queryByTestId("turn-files-chip")).toBeNull();
    unmount();

    const missing = vi.fn(async () => {
      throw { _tag: "NotFound", entity: "checkpoint", id: MOCK_DEPS_TURN };
    });
    renderWithApi(<TurnFilesChip threadId={T} turnId={MOCK_DEPS_TURN} />, { gitDiff: missing });
    await waitFor(() => expect(missing).toHaveBeenCalled());
    expect(screen.queryByTestId("turn-files-chip")).toBeNull();
  });
});
