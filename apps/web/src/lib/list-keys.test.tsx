// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { listIndexForKey, PAGE_STEP, radioGroupKeyDown } from "./list-keys";

afterEach(cleanup);

describe("listIndexForKey", () => {
  it("wraps the arrows, jumps with Home / End and pages without wrapping", () => {
    expect(listIndexForKey("ArrowDown", 4, 5)).toBe(0);
    expect(listIndexForKey("ArrowUp", 0, 5)).toBe(4);
    expect(listIndexForKey("Home", 3, 5)).toBe(0);
    expect(listIndexForKey("End", 1, 5)).toBe(4);
    expect(listIndexForKey("PageDown", 2, 20)).toBe(2 + PAGE_STEP);
    expect(listIndexForKey("PageDown", 18, 20)).toBe(19);
    expect(listIndexForKey("PageUp", 3, 20)).toBe(0);
    expect(listIndexForKey("Enter", 3, 20)).toBeUndefined();
    expect(listIndexForKey("ArrowDown", 0, 0)).toBeUndefined();
  });
});

function Group() {
  const [value, setValue] = useState("b");
  return (
    <div
      role="radiogroup"
      aria-label="Scope"
      onKeyDown={(event) => radioGroupKeyDown(event, ["a", "b", "c"], value, setValue)}
    >
      {["a", "b", "c"].map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          tabIndex={value === option ? 0 : -1}
          onClick={() => setValue(option)}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

const radio = (name: string) => screen.getByRole("radio", { name });

describe("radioGroupKeyDown", () => {
  it("moves to and chooses the next option, focusing it, with one Tab stop", () => {
    render(<Group />);
    expect(screen.getAllByRole("radio").map((r) => r.tabIndex)).toEqual([-1, 0, -1]);

    radio("b").focus();
    fireEvent.keyDown(radio("b"), { key: "ArrowRight" });
    expect(radio("c").getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(radio("c"));

    fireEvent.keyDown(radio("c"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(radio("a"));
    fireEvent.keyDown(radio("a"), { key: "End" });
    expect(radio("c").getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(radio("c"), { key: "Home" });
    expect(radio("a").getAttribute("aria-checked")).toBe("true");
    expect(screen.getAllByRole("radio").map((r) => r.tabIndex)).toEqual([0, -1, -1]);
  });
});
