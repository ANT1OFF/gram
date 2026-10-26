// @vitest-environment happy-dom
import { DEFAULT_CHARTER } from "@gram/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RouteAtLimitField } from "./route-at-limit-field";
import { WorkerBriefFooterField } from "./worker-brief-footer-field";
import { withRouteAtLimit, withWorkerBriefFooter } from "./workspace-settings-model";

afterEach(cleanup);

describe("the worker brief footer field", () => {
  it("starts empty for a workspace without one, and saves only when left with a change", () => {
    const onChange = vi.fn();
    render(
      <WorkerBriefFooterField charter={DEFAULT_CHARTER} disabled={false} onChange={onChange} />,
    );
    const box = screen.getByRole("textbox", { name: "Worker brief footer" });
    expect((box as HTMLTextAreaElement).value).toBe("");
    fireEvent.blur(box);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: "Run the checks before merging.\n" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(box);
    expect(onChange).toHaveBeenCalledWith(
      { ...DEFAULT_CHARTER, workerBriefFooter: "Run the checks before merging." },
      "Worker brief footer saved",
    );
  });

  it("clears the footer when emptied, and Escape puts back the saved text", () => {
    const onChange = vi.fn();
    const charter = { ...DEFAULT_CHARTER, workerBriefFooter: "Never touch Y." };
    render(<WorkerBriefFooterField charter={charter} disabled={false} onChange={onChange} />);
    const box = screen.getByRole("textbox", { name: "Worker brief footer" }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Draft" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(box.value).toBe("Never touch Y.");
    fireEvent.change(box, { target: { value: "   " } });
    fireEvent.blur(box);
    expect(onChange).toHaveBeenCalledWith(DEFAULT_CHARTER, "Worker brief footer removed");
  });
});

describe("offering another model at a limit", () => {
  it("is off by default and turns on and off without leaving a stored false", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <RouteAtLimitField charter={DEFAULT_CHARTER} disabled={false} onChange={onChange} />,
    );
    const toggle = screen.getByRole("switch", { name: "Offer another model" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenLastCalledWith(
      { ...DEFAULT_CHARTER, routeAtLimit: true },
      "Another model is offered at a limit",
    );
    rerender(
      <RouteAtLimitField
        charter={{ ...DEFAULT_CHARTER, routeAtLimit: true }}
        disabled={false}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "Offer another model" }));
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT_CHARTER, "Workers wait at a limit");
  });

  it("keeps the charter's other fields as they are", () => {
    const charter = { ...DEFAULT_CHARTER, pauseAtLimitPct: 90 };
    expect(withRouteAtLimit(charter, false)).toEqual(charter);
    expect(withWorkerBriefFooter(charter, "")).toEqual(charter);
    expect(withWorkerBriefFooter(charter, " Rule. ")).toEqual({
      ...charter,
      workerBriefFooter: "Rule.",
    });
  });
});
