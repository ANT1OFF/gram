// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { Bot } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";

import { Avatar, initialsOf } from "./avatar";

afterEach(cleanup);

describe("Avatar", () => {
  it("takes the first and last words' first letters, or one for a single word", () => {
    expect(initialsOf("Ingrid Solberg")).toBe("IS");
    expect(initialsOf("  marta  van der lindqvist ")).toBe("ML");
    expect(initialsOf("Ingrid")).toBe("I");
    expect(initialsOf("Ølve Ærø")).toBe("ØÆ");
    expect(initialsOf("")).toBe("");
  });

  it("stays out of the accessibility tree beside a name, and says name and status when labelled", () => {
    const { rerender } = render(
      <Avatar name="Release agent" status="working" statusLabel="Working" testId="mark" />,
    );
    expect(screen.getByTestId("mark").getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByRole("img")).toBeNull();
    rerender(
      <Avatar
        name="Release agent"
        shape="square"
        glyph={Bot}
        status="working"
        statusLabel="Working"
        labelled
        testId="mark"
      />,
    );
    expect(screen.getByRole("img", { name: "Release agent, Working" })).toBeTruthy();
    expect(screen.getByTestId("mark").textContent).toBe("");
  });

  it("draws no dot without a status", () => {
    render(<Avatar name="Priya Raman" testId="mark" />);
    expect(screen.queryByTestId("mark-status")).toBeNull();
    expect(screen.getByTestId("mark").textContent).toBe("PR");
  });
});
