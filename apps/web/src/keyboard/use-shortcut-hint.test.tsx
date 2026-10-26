// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useBindingsStore } from "./bindings-store";
import { formatKeys } from "./registry";
import { ShortcutKbd, withHint } from "./use-shortcut-hint";

afterEach(() => {
  cleanup();
  useBindingsStore.setState({ overrides: {} });
});

describe("ShortcutKbd", () => {
  it("shows the catalog keys, follows a rebinding and disappears when turned off", () => {
    render(
      <button type="button">
        Collapse <ShortcutKbd id="sidebar.toggle" />
      </button>,
    );
    const button = screen.getByRole("button");
    expect(button.querySelector("kbd")?.textContent).toBe(formatKeys("mod+b"));

    act(() => useBindingsStore.setState({ overrides: { "sidebar.toggle": "mod+shift+b" } }));
    expect(button.querySelector("kbd")?.textContent).toBe(formatKeys("mod+shift+b"));

    act(() => useBindingsStore.setState({ overrides: { "sidebar.toggle": null } }));
    expect(button.querySelector("kbd")).toBeNull();
  });
});

describe("withHint", () => {
  it("adds the keys in parentheses, or nothing when there are none", () => {
    expect(withHint("Collapse sidebar", "⌘B")).toBe("Collapse sidebar (⌘B)");
    expect(withHint("Collapse sidebar", "")).toBe("Collapse sidebar");
  });
});
