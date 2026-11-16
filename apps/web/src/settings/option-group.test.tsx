// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OptionGroup } from "./fields";

afterEach(cleanup);

describe("OptionGroup", () => {
  it("is a segmented control of short words without descriptions", () => {
    render(
      <OptionGroup
        label="Period"
        options={[
          { value: "day", label: "Day" },
          { value: "month", label: "Month", testId: "period-month" },
        ]}
        value="day"
        onChange={() => {}}
      />,
    );
    const group = screen.getByRole("radiogroup", { name: "Period" });
    expect(group.className).toContain("w-fit");
    expect(screen.getByTestId("period-month").getAttribute("aria-checked")).toBe("false");
    expect(within(group).queryByTestId("choice-check")).toBeNull();
  });

  it("draws choice cards, each with its line and the pick's check, when choices are described", () => {
    const onChange = vi.fn();
    render(
      <OptionGroup
        label="Access"
        options={[
          { value: "read", label: "Read", description: "Sees the files." },
          { value: "write", label: "Write", description: "Changes them.", testId: "access-write" },
        ]}
        value="read"
        onChange={onChange}
      />,
    );
    const group = screen.getByRole("radiogroup", { name: "Access" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("aria-label"))).toEqual(["Read", "Write"]);
    expect(radios.map((radio) => radio.getAttribute("aria-description"))).toEqual([
      "Sees the files.",
      "Changes them.",
    ]);
    expect(radios.map((radio) => radio.textContent)).toEqual([
      "ReadSees the files.",
      "WriteChanges them.",
    ]);
    expect(within(radios[0]!).getByTestId("choice-check")).toBeTruthy();
    expect(within(radios[1]!).queryByTestId("choice-check")).toBeNull();
    fireEvent.click(radios[0]!);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("access-write"));
    expect(onChange).toHaveBeenCalledWith("write");
  });
});
