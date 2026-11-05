// @vitest-environment happy-dom
import type { DiffScope, ThreadId, TurnId, TurnUndoData } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MOCK_DEPS_TURN, mockDiff } from "@/api/mock-git";
import { renderWithApi } from "@/panels/test-utils";
import { useLayoutStore } from "@/stores/layout";

import { TurnFilesChip } from "./turn-files-chip";
import { isUndoReceipt, TurnUndoMarker, turnUndoLabel, turnUndos } from "./turn-undo-marker";

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

  const diff = vi.fn(async (threadId: ThreadId, scope: DiffScope) => mockDiff(threadId, scope));

  it("shows the turn's line counts, and View changes opens the Diff panel at that turn", async () => {
    renderWithApi(<TurnFilesChip threadId={T} turnId={MOCK_DEPS_TURN} />, { gitDiff: diff });
    const card = await screen.findByTestId("turn-files-card");
    const files = mockDiff(T, { kind: "turn", turnId: MOCK_DEPS_TURN });
    const changed = files.repo ? (files.files ?? []) : [];
    const added = changed.reduce((n, f) => n + f.additions, 0);
    expect(card.textContent).toContain(`+${added.toLocaleString()}`);
    fireEvent.click(screen.getByTestId("turn-view-changes"));
    expect(useLayoutStore.getState().panelTargets.diff).toMatchObject({
      threadId: T,
      target: `turn:${MOCK_DEPS_TURN}`,
    });
  });

  it("asks before undoing, and Cancel leaves the files alone", async () => {
    const undoTurn = vi.fn();
    renderWithApi(<TurnFilesChip threadId={T} turnId={MOCK_DEPS_TURN} />, {
      gitDiff: diff,
      undoTurn,
    });
    fireEvent.click(await screen.findByTestId("turn-undo"));
    expect(screen.getByTestId("turn-files-card").textContent).toContain(
      "Put back 2 files as before this turn?",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(undoTurn).not.toHaveBeenCalled();
    expect(screen.getByTestId("turn-undo")).toBeTruthy();
  });

  it("undoes once confirmed and then reads undone, with no Undo left", async () => {
    const receipt: TurnUndoData = { turnId: MOCK_DEPS_TURN, files: 2, at: Date.now() };
    const undoTurn = vi.fn(async () => receipt);
    renderWithApi(<TurnFilesChip threadId={T} turnId={MOCK_DEPS_TURN} />, {
      gitDiff: diff,
      undoTurn,
    });
    fireEvent.click(await screen.findByTestId("turn-undo"));
    fireEvent.click(screen.getByTestId("turn-undo-confirm"));
    await screen.findByTestId("turn-undone");
    expect(undoTurn).toHaveBeenCalledWith(T, MOCK_DEPS_TURN);
    expect(screen.getByTestId("turn-undone").textContent).toMatch(/^Undone at \d{2}:\d{2}$/);
    expect(screen.queryByTestId("turn-undo")).toBeNull();
    expect(screen.getByTestId("turn-view-changes")).toBeTruthy();
  });

  it.each([
    "Undo not available: the agent is still working. Undo once it has stopped, or view the changes instead.",
    "Undo not available: 1 file changed again since this turn (package.json), by a later turn or by you. View the changes to undo them by hand.",
    "Undo not available: a commit made since this turn started changes its files (package.json). Undo doesn't revert commits.",
  ])("shows the server's refusal and keeps View changes: %s", async (message) => {
    const undoTurn = vi.fn(async () => {
      throw Object.assign(new Error(message), { _tag: "InvalidState", message });
    });
    renderWithApi(<TurnFilesChip threadId={T} turnId={MOCK_DEPS_TURN} />, {
      gitDiff: diff,
      undoTurn,
    });
    fireEvent.click(await screen.findByTestId("turn-undo"));
    fireEvent.click(screen.getByTestId("turn-undo-confirm"));
    expect((await screen.findByTestId("turn-undo-refused")).textContent).toBe(message);
    expect(screen.getByTestId("turn-view-changes")).toBeTruthy();
    expect(screen.queryByTestId("turn-undone")).toBeNull();
  });

  it("reads undone from the transcript's receipt", async () => {
    const undo: TurnUndoData = { turnId: MOCK_DEPS_TURN, files: 2, at: Date.now() };
    renderWithApi(<TurnFilesChip threadId={T} turnId={MOCK_DEPS_TURN} undo={undo} />, {
      gitDiff: diff,
    });
    await screen.findByTestId("turn-undone");
    expect(screen.queryByTestId("turn-undo")).toBeNull();
  });
});

describe("turn undo receipts", () => {
  const at = Date.UTC(2026, 10, 4, 14, 5);
  const intl = { timeZone: "UTC" };

  it("says how many files and when, on a 24-hour clock", () => {
    const undo = { turnId: "turn-1" as TurnId, files: 3, at };
    expect(turnUndoLabel(undo, at, intl)).toBe("Undid edits to 3 files at 14:05");
    expect(turnUndoLabel({ ...undo, files: 1 }, at, intl)).toBe("Undid edits to 1 file at 14:05");
    expect(turnUndoLabel(undo, at + 86_400_000, intl)).toBe(
      "Undid edits to 3 files at 4 Nov 14:05",
    );
  });

  it("finds each turn's receipt and tells a receipt-only message apart", () => {
    const undo = { turnId: "turn-1" as TurnId, files: 3, at };
    const receipt = {
      id: "undo-1",
      role: "assistant",
      parts: [{ type: "data-turn-undo", id: "p1", data: undo }],
    } as const;
    const reply = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "Done." }],
    } as const;
    const messages = [reply, receipt] as unknown as Parameters<typeof turnUndos>[0];
    expect(turnUndos(messages).get("turn-1" as TurnId)).toEqual(undo);
    expect(isUndoReceipt(messages[1]!)).toBe(true);
    expect(isUndoReceipt(messages[0]!)).toBe(false);
  });

  it("says when an undo failed, and lists the files to check as text", () => {
    const undo = { turnId: "turn-1" as TurnId, files: 2, at, failed: ["a.txt", "src/b.ts"] };
    expect(turnUndoLabel(undo, at, intl)).toBe(
      "Undo failed at 14:05: check 2 files with View changes",
    );
    renderWithApi(<TurnUndoMarker undo={undo} />, {});
    expect(screen.getByTestId("turn-undo-failed").textContent).toBe("a.txtsrc/b.ts");
  });
});
