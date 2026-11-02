// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { HighlightBody } from "./release-notes";

afterEach(cleanup);

describe("HighlightBody", () => {
  it("renders <kbd> spans as key caps and keeps any other markup as text", () => {
    const { container } = render(
      <HighlightBody mac text="Press <kbd>⌘T</kbd> or <kbd>Ctrl+Tab</kbd>, not <b>bold</b>." />,
    );
    expect([...container.querySelectorAll("kbd")].map((kbd) => kbd.textContent)).toEqual([
      "⌘T",
      "Ctrl+Tab",
    ]);
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toBe("Press ⌘T or Ctrl+Tab, not <b>bold</b>.");
  });

  it("spells the keys out off macOS", () => {
    const { container } = render(
      <HighlightBody mac={false} text="<kbd>⌥⌘N</kbd> and <kbd>⌘</kbd>-click" />,
    );
    expect(container.textContent).toBe("Ctrl+Alt+N and Ctrl-click");
  });
});
