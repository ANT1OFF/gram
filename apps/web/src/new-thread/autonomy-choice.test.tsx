// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

import { AUTONOMY_LINE, AutonomyChoice } from "./autonomy-choice";

afterEach(cleanup);

const mount = (value: "supervised" | "publish" | "full") => {
  const onChange = vi.fn();
  render(
    <TooltipProvider>
      <AutonomyChoice value={value} onChange={onChange} />
    </TooltipProvider>,
  );
  return onChange;
};

describe("AutonomyChoice", () => {
  it("shows every level with its one plain line, the picked one checked", () => {
    const onChange = mount("full");
    const radios = within(screen.getByRole("radiogroup", { name: "Autonomy" })).getAllByRole(
      "radio",
    );
    expect(radios.map((radio) => radio.getAttribute("aria-label"))).toEqual([
      "Supervised",
      "Publish",
      "Full",
    ]);
    expect(radios.map((radio) => radio.textContent)).toEqual([
      `Supervised${AUTONOMY_LINE.supervised}`,
      `Publish${AUTONOMY_LINE.publish}`,
      `Full${AUTONOMY_LINE.full}`,
    ]);
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual([
      "false",
      "false",
      "true",
    ]);
    fireEvent.click(radios[0]!);
    expect(onChange).toHaveBeenCalledWith("supervised");
  });

  it("says what Full leaves in one calm line, with the rest behind a link", () => {
    mount("full");
    const note = screen.getByTestId("autonomy-full-note");
    expect(note.textContent).toContain("only gate");
    expect(note.className).not.toMatch(/warning|status-needs|destructive/);
    expect(within(note).getByRole("button", { name: "What does this allow?" })).toBeTruthy();
  });

  it("has no Full note at the other levels", () => {
    mount("publish");
    expect(screen.queryByTestId("autonomy-full-note")).toBeNull();
  });
});
