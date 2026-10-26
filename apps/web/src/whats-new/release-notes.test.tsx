// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { HighlightBody } from "./release-notes";

afterEach(cleanup);

describe("HighlightBody", () => {
  it("renders <kbd> spans as key caps and keeps any other markup as text", () => {
    const { container } = render(
      <HighlightBody text="Press <kbd>⌘T</kbd> or <kbd>Ctrl+Tab</kbd>, not <b>bold</b>." />,
    );
    expect([...container.querySelectorAll("kbd")].map((kbd) => kbd.textContent)).toEqual([
      "⌘T",
      "Ctrl+Tab",
    ]);
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toBe("Press ⌘T or Ctrl+Tab, not <b>bold</b>.");
  });
});
