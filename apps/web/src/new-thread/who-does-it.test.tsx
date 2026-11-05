// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

import { NewFormHeader } from "./who-does-it";

afterEach(cleanup);

describe("NewFormHeader", () => {
  it("is one title, then the goal, where it goes, Who does it and one line", () => {
    const onWho = vi.fn();
    render(
      <TooltipProvider>
        <NewFormHeader
          who="worker"
          onWho={onWho}
          goal={<textarea aria-label="What needs doing" />}
          where={<span>Synthetic workspace</span>}
          line="Synthetic line"
        />
      </TooltipProvider>,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("New");
    const who = screen.getByRole("radiogroup", { name: "Who does it" });
    const radios = within(who).getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("aria-label"))).toEqual([
      "Task",
      "Team",
      "Chat",
    ]);
    // Each choice says what comes of it in one sentence, under its plain name.
    expect(radios.map((radio) => radio.textContent)).toEqual([
      "TaskOne worker does it in its own worktree and opens a pull request.",
      "TeamAn orchestrator splits it up, runs workers and sees their pull requests merged.",
      "ChatYou and one agent in a folder. No workspace or orchestrator.",
    ]);
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    // The goal leads, then where it runs, then who does it.
    const goal = screen.getByRole("textbox", { name: "What needs doing" });
    const whereGroup = screen.getByRole("group", { name: "Where it runs" });
    expect(
      goal.compareDocumentPosition(whereGroup) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(whereGroup.compareDocumentPosition(who) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Where it goes is a named group of its own before the prompt, not an "in" chip.
    const where = screen.getByRole("group", { name: "Where it runs" });
    expect(within(where).getByText("Synthetic workspace")).toBeTruthy();
    expect(screen.getByTestId("task-way-note").textContent).toBe("Synthetic line");

    fireEvent.click(radios[2]!);
    expect(onWho).toHaveBeenCalledWith("me");
    fireEvent.click(radios[0]!);
    expect(onWho).toHaveBeenCalledTimes(1);
  });

  it("folds a repeat start to one line naming the same choices, which Change unfolds", () => {
    const onExpand = vi.fn();
    render(
      <TooltipProvider>
        <NewFormHeader
          who="worker"
          onWho={vi.fn()}
          where={<span>Synthetic workspace</span>}
          line="Synthetic line"
          summary={{ places: ["Alpha", "alpha-repo", "New worktree, new branch"], onExpand }}
        />
      </TooltipProvider>,
    );
    // No choice cards and no Where it runs row while folded: one line says them.
    expect(screen.queryByRole("radiogroup", { name: "Who does it" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Where it runs" })).toBeNull();
    const summary = screen.getByRole("group", { name: "Who does it and where it runs" });
    expect(summary.textContent).toContain("Task");
    expect(screen.getByTestId("new-summary-where").textContent).toBe(
      " · Alpha · alpha-repo · New worktree, new branch",
    );
    fireEvent.click(within(summary).getByRole("button", { name: /^Change/ }));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });
});
