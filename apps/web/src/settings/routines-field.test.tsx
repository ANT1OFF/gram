// @vitest-environment happy-dom
import { DEFAULT_CHARTER, type WorkspaceRoutine } from "@gram/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutinesField } from "./routines-field";

afterEach(cleanup);

const triage: WorkspaceRoutine = {
  name: "CI triage",
  brief: "Say which of main's failing checks are flaky.",
  schedule: { every: "weekday", at: "09:00" },
};

const mount = (routines?: ReadonlyArray<WorkspaceRoutine>) => {
  const onChange = vi.fn();
  render(
    <RoutinesField
      charter={{ ...DEFAULT_CHARTER, ...(routines === undefined ? {} : { routines }) }}
      disabled={false}
      onChange={onChange}
    />,
  );
  return onChange;
};

describe("routines setting", () => {
  it("says how to add one when there is none", () => {
    mount();
    expect(screen.getByTestId("routines-empty").textContent).toContain("Ask the orchestrator");
  });

  it("shows each routine's schedule and brief, turns it off and removes it", () => {
    const onChange = mount([triage]);
    expect(screen.getByText("Starts a worker weekdays at 09:00.")).toBeTruthy();
    expect(screen.getByText(triage.brief)).toBeTruthy();
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenLastCalledWith(
      { ...DEFAULT_CHARTER, routines: [{ ...triage, off: true }] },
      "Routine “CI triage” off",
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT_CHARTER, "Routine “CI triage” removed");
  });
});
