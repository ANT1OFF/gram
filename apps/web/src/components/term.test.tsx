// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { seeTerm, useFirstUse } from "@/lib/first-use";

import { Term } from "./term";

afterEach(() => {
  cleanup();
  useFirstUse.setState({ seen: {} });
});

describe("Term", () => {
  it("is marked until its explanation has been seen, then reads as plain text", () => {
    render(<Term term="quiet">Quiet</Term>);
    const word = screen.getByText("Quiet");
    expect(word.hasAttribute("data-first-use")).toBe(true);
    expect(word.className).toContain("decoration-dotted");
    act(() => seeTerm("quiet"));
    expect(word.hasAttribute("data-first-use")).toBe(false);
    expect(word.className).not.toContain("decoration-dotted");
    expect(word.textContent).toBe("Quiet");
  });

  it("remembers each term on its own", () => {
    seeTerm("solo");
    expect(useFirstUse.getState().seen).toEqual({ solo: true });
    render(<Term term="takeOver">Take over</Term>);
    expect(screen.getByText("Take over").hasAttribute("data-first-use")).toBe(true);
  });
});
