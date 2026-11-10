// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Columns3 } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EmptyState } from "./empty-state";

afterEach(cleanup);

describe("EmptyState", () => {
  it("says what goes there in one line and offers one outline action", () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        testId="board-empty"
        icon={Columns3}
        title="No features yet"
        line="Each task becomes a feature here."
        action={{ label: "Message the orchestrator", onClick }}
      />,
    );
    const empty = screen.getByTestId("board-empty");
    expect(empty.getAttribute("role")).toBe("status");
    expect(within(empty).getByTestId("empty-title").textContent).toBe("No features yet");
    expect(within(empty).getByTestId("empty-line").textContent).toBe(
      "Each task becomes a feature here.",
    );
    const buttons = within(empty).getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.className).toContain("border");
    expect(buttons[0]!.className).not.toContain("bg-primary");
    fireEvent.click(buttons[0]!);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("leaves the line and the action out when it has none", () => {
    render(<EmptyState testId="files-empty" icon={Columns3} title="No files yet" />);
    const empty = screen.getByTestId("files-empty");
    expect(within(empty).queryByTestId("empty-line")).toBeNull();
    expect(within(empty).queryByRole("button")).toBeNull();
  });
});
