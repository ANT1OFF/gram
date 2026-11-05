// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NumberField, SettingRow } from "./fields";
import { GENERAL_SECTIONS } from "./general-anchors";
import { SaveHint, UNDO_SHOW_MS } from "./save-hint";

/** A typed setting kept in state, as a page keeps it in settings. */
function Harness({ onCommit }: { onCommit: (value: number) => void }) {
  const [value, setValue] = useState(4);
  return (
    <NumberField
      label="Workers at once"
      value={value}
      min={1}
      onCommit={(next) => {
        onCommit(next);
        setValue(next);
      }}
    />
  );
}

const input = () => screen.getByRole("spinbutton", { name: "Workers at once" }) as HTMLInputElement;

describe("a typed setting's draft", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("offers Save and Cancel only while the draft differs, beside the Enter/Esc hint", () => {
    render(<Harness onCommit={() => {}} />);
    expect(screen.queryByTestId("setting-draft-actions")).toBeNull();
    fireEvent.change(input(), { target: { value: "6" } });
    expect(screen.getByTestId("setting-unsaved").textContent).toBe("Enter to save · Esc to cancel");
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("puts the Enter/Esc hint under the field, never on the name's line", () => {
    render(<Harness onCommit={() => {}} />);
    fireEvent.change(input(), { target: { value: "6" } });
    const hint = screen.getByTestId("setting-unsaved");
    const label = screen.getByText("Workers at once", { selector: "label" });
    expect(label.parentElement?.contains(hint)).toBe(false);
    // After the field in reading order, and what the field is described by.
    expect(input().compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(input().getAttribute("aria-describedby")).toBe(hint.id);
  });

  it("puts a row's hint under its control, apart from the name", () => {
    render(
      <SettingRow label="Default folder" htmlFor="folder" hint={<SaveHint id="folder-hint" />}>
        <input id="folder" />
      </SettingRow>,
    );
    const hint = screen.getByTestId("setting-unsaved");
    const label = screen.getByText("Default folder", { selector: "label" });
    expect(label.parentElement?.contains(hint)).toBe(false);
    const field = document.getElementById("folder")!;
    expect(field.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("saves from Save, then offers Undo, which puts the old value back", () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    fireEvent.change(input(), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onCommit).toHaveBeenLastCalledWith(6);
    expect(screen.queryByTestId("setting-draft-actions")).toBeNull();

    fireEvent.click(screen.getByTestId("setting-undo"));
    expect(onCommit).toHaveBeenLastCalledWith(4);
    expect(input().value).toBe("4");
    expect(screen.queryByTestId("setting-undo")).toBeNull();
  });

  it("drops the draft from Cancel or Esc without saving", () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    fireEvent.change(input(), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(input().value).toBe("4");
    fireEvent.change(input(), { target: { value: "7" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(input().value).toBe("4");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("saves on blur too, and its Undo goes once typed in again or after a while", () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    fireEvent.change(input(), { target: { value: "6" } });
    fireEvent.blur(input());
    expect(onCommit).toHaveBeenLastCalledWith(6);
    expect(screen.getByTestId("setting-undo")).toBeTruthy();
    fireEvent.change(input(), { target: { value: "8" } });
    expect(screen.queryByTestId("setting-undo")).toBeNull();

    fireEvent.blur(input());
    expect(screen.getByTestId("setting-undo")).toBeTruthy();
    act(() => vi.advanceTimersByTime(UNDO_SHOW_MS + 10));
    expect(screen.queryByTestId("setting-undo")).toBeNull();
  });
});

describe("Settings → General's groups", () => {
  it("are Launch, Navigation, Folders & branches, Sending and Running work, then Editor and Links", () => {
    expect(GENERAL_SECTIONS.map((section) => section.label)).toEqual([
      "Launch",
      "Navigation",
      "Folders & branches",
      "Sending",
      "Running work",
      "Editor",
      "Links",
    ]);
  });
});
