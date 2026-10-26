// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BindingRow } from "@/keyboard/bindings";

import { KeyCaptureDialog } from "./key-capture-dialog";

const row = (id: string, label: string, keys: string): BindingRow => ({
  id,
  label,
  group: "App",
  defaultKeys: keys,
  keys,
  overridden: false,
  conflicts: [],
});

const ROWS = [
  row("sidebar.toggle", "Collapse sidebar", "mod+b"),
  row("panel.toggle", "Right panel", "mod+alt+b"),
];

const press = (init: KeyboardEventInit & { key: string; code: string }) =>
  fireEvent.keyDown(window, init);

const status = () => screen.getByTestId("key-capture-status").textContent;

const open = (mac = true) => {
  const onSave = vi.fn();
  const onClose = vi.fn();
  render(
    <KeyCaptureDialog row={ROWS[0]!} rows={ROWS} mac={mac} onSave={onSave} onClose={onClose} />,
  );
  return { onSave, onClose };
};

const unusable = () => screen.getByTestId("key-capture-unusable").textContent;

afterEach(cleanup);

describe("KeyCaptureDialog", () => {
  it("announces recording, records the press and saves it", () => {
    const { onSave } = open();
    expect(status()).toContain("Recording: press the new keys.");
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);

    press({ key: "K", code: "KeyK", metaKey: true, shiftKey: true });
    expect(status()).toBe("Recorded ⌘⇧K.");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({ "sidebar.toggle": "mod+shift+k" });
  });

  it("names a clashing action and offers to take its keys", () => {
    const { onSave } = open();
    press({ key: "∫", code: "KeyB", metaKey: true, altKey: true });
    expect(screen.getByTestId("key-capture-clash").textContent).toContain(
      "Same keys as Right panel.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(onSave).toHaveBeenCalledWith({ "panel.toggle": null, "sidebar.toggle": "mod+alt+b" });
  });

  it("turns the shortcut off on Backspace, and warns about keys macOS keeps", () => {
    const { onSave } = open();
    press({ key: "Backspace", code: "Backspace" });
    expect(status()).toBe("Collapse sidebar will be off.");

    fireEvent.click(screen.getByRole("button", { name: "Record again" }));
    press({ key: "q", code: "KeyQ", metaKey: true });
    expect(screen.getByTestId("key-capture-system").textContent).toContain(
      "macOS uses ⌘Q for itself (quits the app)",
    );

    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({ "sidebar.toggle": null });
  });

  it("keeps recorded presses away from app shortcuts and ignores a lone modifier", () => {
    open();
    const appShortcut = vi.fn();
    window.addEventListener("keydown", appShortcut);
    try {
      press({ key: "Shift", code: "ShiftLeft", shiftKey: true });
      expect(status()).toContain("Recording");
      press({ key: "b", code: "KeyB", metaKey: true });
      expect(appShortcut).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", appShortcut);
    }
  });

  it("says why AltGr text and the Windows key can't be recorded off macOS", () => {
    open(false);
    // Norwegian AltGr+8 types `[`.
    press({ key: "[", code: "Digit8", ctrlKey: true, altKey: true });
    expect(unusable()).toBe("AltGr keys type characters and can't be shortcuts.");
    expect(status()).toContain("Recording");

    press({ key: "k", code: "KeyK", metaKey: true });
    expect(unusable()).toBe("The Windows key can't be part of a shortcut.");

    press({ key: "b", code: "KeyB", ctrlKey: true, altKey: true });
    expect(status()).toBe("Recorded Ctrl+Alt+B.");
    expect(screen.queryByTestId("key-capture-unusable")).toBeNull();
  });

  it("closes without saving on Escape", async () => {
    const { onSave, onClose } = open();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape", code: "Escape" });
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSave).not.toHaveBeenCalled();
  });
});
