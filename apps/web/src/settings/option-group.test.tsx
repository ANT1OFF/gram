// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
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

describe("OptionGroup keyboard", () => {
  function Harness({ described }: { described: boolean }) {
    const [value, setValue] = useState<"a" | "b" | "c">("b");
    return (
      <OptionGroup
        label="Pick"
        value={value}
        onChange={setValue}
        options={(["a", "b", "c"] as const).map((each) => ({
          value: each,
          label: each.toUpperCase(),
          ...(described ? { description: `About ${each}` } : {}),
        }))}
      />
    );
  }

  it.each([
    ["segmented", false],
    ["cards", true],
  ])("is one Tab stop and the arrow keys move the pick, wrapping (%s)", (_name, described) => {
    render(<Harness described={described} />);
    const [a, b, c] = screen.getAllByRole("radio");
    expect([a, b, c].map((radio) => radio!.tabIndex)).toEqual([-1, 0, -1]);
    b!.focus();
    fireEvent.keyDown(b!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(c);
    expect(c!.getAttribute("aria-checked")).toBe("true");
    expect([a, b, c].map((radio) => radio!.tabIndex)).toEqual([-1, -1, 0]);
    fireEvent.keyDown(c!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(a);
    expect(a!.getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(a!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c!, { key: "Home" });
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(a!, { key: "End" });
    expect(document.activeElement).toBe(c);
    expect(c!.getAttribute("aria-checked")).toBe("true");
  });

  it("puts the Tab stop on the first choice while none is picked", () => {
    render(
      <OptionGroup
        label="Pick"
        value={undefined}
        onChange={() => {}}
        options={[
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ]}
      />,
    );
    expect(screen.getAllByRole("radio").map((radio) => radio.tabIndex)).toEqual([0, -1]);
  });

  it("lays its cards out by its own column, not the window", () => {
    render(<Harness described />);
    const group = screen.getByRole("radiogroup", { name: "Pick" });
    expect(group.parentElement!.className).toContain("@container/options");
    expect(group.className).toContain("@min-[30rem]/options:grid-flow-col");
    expect(group.className).not.toContain("sm:");
  });
});
