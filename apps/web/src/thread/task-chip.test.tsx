// @vitest-environment happy-dom
import type { TaskChipData, TaskId, ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithRouter as renderWithApi } from "@/panels/test-utils";

import { TaskChip } from "./task-chip";

beforeEach(() => {
  vi.spyOn(console, "warn");
  vi.spyOn(console, "error");
});
afterEach(() => {
  cleanup();
  try {
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

const chip = (overrides: Partial<TaskChipData> = {}): TaskChipData => ({
  id: "task-1" as TaskId,
  title: "Follow up",
  prompt: "do the follow-up",
  status: "offered",
  ...overrides,
});

const where = (data: TaskChipData) => {
  renderWithApi(<TaskChip threadId={"t-1" as ThreadId} chip={data} />, {});
  return screen.getByTestId("task-chip-where").textContent;
};

describe("TaskChip", () => {
  it("starts the offered task and navigates to the returned thread", async () => {
    const acceptTask = vi.fn(async () => ({ id: "started-thread" as ThreadId }) as never);
    const { router } = renderWithApi(<TaskChip threadId={"t-1" as ThreadId} chip={chip()} />, {
      acceptTask,
    });
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/t/started-thread"));
    expect(acceptTask).toHaveBeenCalledExactlyOnceWith("t-1", "task-1");
  });
  it("says the task starts in a worktree of its own, named or not", () => {
    expect(where(chip())).toBe("new branch · new worktree");
    cleanup();
    expect(where(chip({ branch: "fix/spec", checkout: "new-worktree" }))).toBe(
      "fix/spec · new worktree",
    );
  });

  it("says so when the task would share this thread's checkout", () => {
    expect(where(chip({ checkout: "current", branch: "ignored" }))).toBe(
      "shares this thread's checkout",
    );
  });

  it("shows why the task was offered, when it says", () => {
    renderWithApi(<TaskChip threadId={"t-1" as ThreadId} chip={chip()} />, {});
    expect(screen.queryByTestId("task-chip-reason")).toBeNull();
    cleanup();
    renderWithApi(
      <TaskChip
        threadId={"t-1" as ThreadId}
        chip={chip({ reason: "The user keeps it separate" })}
      />,
      {},
    );
    expect(screen.getByTestId("task-chip-reason").textContent).toBe(
      "Why: The user keeps it separate",
    );
  });
});
