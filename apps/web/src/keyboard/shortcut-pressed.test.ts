// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { shortcutPressed } from "./bindings";
import { useBindingsStore } from "./bindings-store";

const press = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

afterEach(() => useBindingsStore.setState({ overrides: {} }));

describe("shortcutPressed", () => {
  it("answers the catalog's default chord and not the bare key", () => {
    // `mod` is ⌘ on a Mac and Ctrl elsewhere; one of the two is this machine's.
    const mod = [press({ key: "Enter", metaKey: true }), press({ key: "Enter", ctrlKey: true })];
    expect(mod.filter((event) => shortcutPressed("composer.send", event))).toHaveLength(1);
    expect(shortcutPressed("composer.send", press({ key: "Enter" }))).toBe(false);
  });

  it("follows a rebinding, including one without ⌘/Ctrl", () => {
    useBindingsStore.setState({ overrides: { "composer.send": "alt+enter" } });
    expect(shortcutPressed("composer.send", press({ key: "Enter", altKey: true }))).toBe(true);
    expect(shortcutPressed("composer.send", press({ key: "Enter" }))).toBe(false);
    // Another action's binding is none of its business.
    expect(shortcutPressed("draft.create", press({ key: "Enter", altKey: true }))).toBe(false);
  });

  it("answers nothing for a shortcut that is turned off, or while an IME composes", () => {
    useBindingsStore.setState({ overrides: { "composer.send": null } });
    expect(shortcutPressed("composer.send", press({ key: "Enter", altKey: true }))).toBe(false);
    useBindingsStore.setState({ overrides: { "composer.send": "alt+enter" } });
    expect(
      shortcutPressed("composer.send", press({ key: "Enter", altKey: true, isComposing: true })),
    ).toBe(false);
  });
});
