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
          who="orchestrator"
          onWho={onWho}
          goal={<textarea aria-label="What needs doing" />}
          where={<span>Synthetic workspace</span>}
          line="Synthetic line"
        />
      </TooltipProvider>,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("New task");
    const who = screen.getByRole("radiogroup", { name: "Who does it" });
    const radios = within(who).getAllByRole("radio");
    // An orchestrator, which decides how to run it, or one agent: no worker straight away.
    expect(radios.map((radio) => radio.getAttribute("aria-label"))).toEqual(["Team", "Chat"]);
    // Each choice says what comes of it in one sentence, under its plain name.
    expect(radios.map((radio) => radio.textContent)).toEqual([
      "TeamAn orchestrator plans it, runs workers as needed and sees their pull requests merged.",
      "ChatYou and one agent in a folder. No workspace or orchestrator.",
    ]);
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["true", "false"]);
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

    fireEvent.click(radios[1]!);
    expect(onWho).toHaveBeenCalledWith("me");
    fireEvent.click(radios[0]!);
    expect(onWho).toHaveBeenCalledTimes(1);
  });

  it("leaves out who does it and where it runs for a repeat start, the brief still first", () => {
    render(
      <TooltipProvider>
        <NewFormHeader
          who="orchestrator"
          onWho={vi.fn()}
          goal={<textarea aria-label="What needs doing" />}
          where={<span>Synthetic workspace</span>}
          line="Synthetic line"
          folded
        />
      </TooltipProvider>,
    );
    // The line beside Start names both while folded, with its Change.
    expect(screen.getByRole("heading", { name: "New task" })).toBeTruthy();
    expect(screen.getByLabelText("What needs doing")).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: "Who does it" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Where it runs" })).toBeNull();
    expect(screen.queryByText("Synthetic workspace")).toBeNull();
  });
});
