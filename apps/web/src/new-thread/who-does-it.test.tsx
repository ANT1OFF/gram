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
    expect(screen.getByText("Synthetic workspace")).toBeTruthy();
    expect(screen.getByTestId("task-way-note").textContent).toBe("Synthetic line");

    fireEvent.click(radios[2]!);
    expect(onWho).toHaveBeenCalledWith("me");
    fireEvent.click(radios[1]!);
    expect(onWho).toHaveBeenCalledTimes(1);
  });
});
