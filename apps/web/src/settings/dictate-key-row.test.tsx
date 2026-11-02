// @vitest-environment happy-dom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useBindingsStore, type BindingOverrides } from "@/keyboard/bindings-store";
import { renderWithApi } from "@/panels/test-utils";

import { DictateKeyRow, dictateKeyHelp } from "./dictate-key-row";

/** An API whose `keybindings.json` is `bindings`, saved as Settings → Keyboard saves it. */
const keybindingsApi = () => {
  const setKeybindings = vi.fn(async (bindings: BindingOverrides) => ({
    path: "/tmp/keybindings.json",
    bindings,
    problems: [],
  }));
  return { setKeybindings };
};

const shown = () => screen.getByTestId("dictate-key").textContent;
const press = (init: KeyboardEventInit & { key: string; code: string }) =>
  fireEvent.keyDown(window, init);

const open = (overrides: BindingOverrides = {}, mac = true) => {
  act(() => useBindingsStore.getState().apply({ path: "", bindings: overrides, problems: [] }));
  const api = keybindingsApi();
  renderWithApi(<DictateKeyRow mac={mac} />, api);
  return api;
};

afterEach(() => {
  cleanup();
  act(() => useBindingsStore.getState().apply({ path: "", bindings: {}, problems: [] }));
});

describe("DictateKeyRow", () => {
  it("records a modifier held alone into keybindings.json", async () => {
    const api = open({ "composer.dictate": "mod+shift+space" });
    expect(shown()).toBe("⌘⇧Space");
    fireEvent.click(screen.getByRole("button", { name: "Change…" }));
    press({ key: "Meta", code: "MetaRight", metaKey: true });
    fireEvent.keyUp(window, { key: "Meta", code: "MetaRight" });
    expect(screen.getByTestId("key-capture-status").textContent).toBe("Recorded Right ⌘.");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    // The other overrides stay; the key is the one the Keyboard page edits.
    await waitFor(() =>
      expect(api.setKeybindings).toHaveBeenCalledWith({ "composer.dictate": "metaright" }),
    );
    await waitFor(() => expect(shown()).toBe("Right ⌘"));
  });

  it("records a chord, and names a shortcut that already has it", async () => {
    const api = open({ "sidebar.toggle": "mod+shift+k" });
    fireEvent.click(screen.getByRole("button", { name: "Change…" }));
    press({ key: "K", code: "KeyK", metaKey: true, shiftKey: true });
    expect(screen.getByTestId("key-capture-clash").textContent).toContain("Same keys as");
    fireEvent.click(screen.getByRole("button", { name: "Keep both" }));
    await waitFor(() =>
      expect(api.setKeybindings).toHaveBeenCalledWith({
        "sidebar.toggle": "mod+shift+k",
        "composer.dictate": "mod+shift+k",
      }),
    );
    // Kept both: the row says so until one of them moves.
    await waitFor(() =>
      expect(screen.getByTestId("dictate-key-warnings").textContent).toContain("Same keys as"),
    );
  });

  it("puts the platform's default back, and leaves the rest of the file alone", async () => {
    const api = open({ "composer.dictate": "controlright", "composer.focus": "mod+k" });
    expect(shown()).toBe("Right ⌃");
    fireEvent.click(screen.getByRole("button", { name: "Reset Push-to-talk key to default" }));
    await waitFor(() =>
      expect(api.setKeybindings).toHaveBeenCalledWith({ "composer.focus": "mod+k" }),
    );
  });

  it("warns off macOS that Right Alt is AltGr on many layouts", () => {
    open({ "composer.dictate": "altright" }, false);
    expect(shown()).toBe("Right Alt");
    expect(screen.getByTestId("dictate-key-warnings").textContent).toContain("AltGr");
  });
});

describe("dictateKeyHelp", () => {
  it("says how a modifier held alone and a chord each talk", () => {
    expect(dictateKeyHelp("altright")).toContain("double-tap it to keep listening");
    expect(dictateKeyHelp("mod+shift+space")).toContain("tap it to start and stop");
    expect(dictateKeyHelp(undefined)).toContain("mic button");
  });
});
