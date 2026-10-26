// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { useBindingsStore } from "./bindings-store";
import { dispatchShortcut, registerShortcut } from "./registry";

const key = (init: KeyboardEventInit & { code?: string }) =>
  new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  useBindingsStore.getState().apply({ path: "", bindings: {}, problems: [] });
});

describe("keybinding overrides", () => {
  it("dispatch on the override's keys, not the default, and not at all once disabled", () => {
    const run = vi.fn();
    cleanups.push(
      registerShortcut({
        id: "sidebar.toggle",
        keys: "mod+b",
        label: "Sidebar",
        group: "App",
        run,
      }),
    );
    useBindingsStore
      .getState()
      .apply({ path: "", bindings: { "sidebar.toggle": "mod+shift+b" }, problems: [] });

    expect(dispatchShortcut(key({ key: "b", code: "KeyB", metaKey: true }), true)).toBe(false);
    expect(
      dispatchShortcut(key({ key: "B", code: "KeyB", metaKey: true, shiftKey: true }), true),
    ).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);

    useBindingsStore
      .getState()
      .apply({ path: "", bindings: { "sidebar.toggle": null }, problems: [] });
    expect(
      dispatchShortcut(key({ key: "B", code: "KeyB", metaKey: true, shiftKey: true }), true),
    ).toBe(false);
  });
});
