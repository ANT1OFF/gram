// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

import { NewFormHeader } from "./who-does-it";

afterEach(cleanup);

describe("NewFormHeader", () => {
  it("is one title, Who does it, where it goes and one line", () => {
    const onWho = vi.fn();
    render(
      <TooltipProvider>
        <NewFormHeader
          who="worker"
          onWho={onWho}
          where={<span>Synthetic workspace</span>}
          line="Synthetic line"
        />
      </TooltipProvider>,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("New");
    const who = screen.getByRole("radiogroup", { name: "Who does it" });
    const radios = within(who).getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("aria-label"))).toEqual([
      "Agent team (orchestrator)",
      "One worker to PR",
      "Single agent chat",
    ]);
    // Each choice says who owns the work in one line, under its name.
    expect(radios.map((radio) => radio.textContent)).toEqual([
      "Agent team (orchestrator)An orchestrator plans it and runs workers for you.",
      "One worker → PROne agent works on it in its own worktree and opens a pull request.",
      "Single agent chatA single chat with one agent in a folder. No workspace or orchestrator.",
    ]);
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    // Where it goes is a named group of its own before the prompt, not an "in" chip.
    const where = screen.getByRole("group", { name: "Where it runs" });
    expect(within(where).getByText("Synthetic workspace")).toBeTruthy();
    expect(screen.getByTestId("task-way-note").textContent).toBe("Synthetic line");

    fireEvent.click(radios[2]!);
    expect(onWho).toHaveBeenCalledWith("me");
    fireEvent.click(radios[1]!);
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
    expect(summary.textContent).toContain("One worker to PR");
    expect(screen.getByTestId("new-summary-where").textContent).toBe(
      " · Alpha · alpha-repo · New worktree, new branch",
    );
    fireEvent.click(within(summary).getByRole("button", { name: /^Change/ }));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });
});
