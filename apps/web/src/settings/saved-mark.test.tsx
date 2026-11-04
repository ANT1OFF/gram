// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingRow } from "./fields";
import { claimTouchedRow, markSaved, SAVED_SHOW_MS } from "./saved-mark";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** A row whose button saves the way `useSaveSettings` does: claimed as it starts, marked once stored. */
function SavingRow({ label, save }: { label: string; save: () => Promise<void> }) {
  return (
    <SettingRow label={label} description="A line.">
      <button
        type="button"
        onClick={() => {
          const row = claimTouchedRow();
          void save().then(() => markSaved(row));
        }}
      >
        Change {label}
      </button>
    </SettingRow>
  );
}

const savedBeside = (label: string) =>
  screen.getByText(label).closest("[data-setting]")!.querySelector('[data-testid="setting-saved"]');

describe("Saved beside a setting", () => {
  it("shows beside the row that was changed, once stored, then goes", async () => {
    let finish!: () => void;
    render(
      <>
        <SavingRow label="One" save={() => new Promise((resolve) => (finish = resolve))} />
        <SavingRow label="Two" save={() => Promise.resolve()} />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Change One" }));
    // Not before the save is stored.
    expect(savedBeside("One")).toBeNull();
    await act(async () => finish());
    expect(savedBeside("One")?.textContent).toBe("Saved");
    expect(savedBeside("Two")).toBeNull();
    await act(async () => vi.advanceTimersByTime(SAVED_SHOW_MS + 500));
    expect(savedBeside("One")).toBeNull();
  });

  it("says nothing for a save no row asked for", async () => {
    render(<SavingRow label="One" save={() => Promise.resolve()} />);
    await act(async () => markSaved(claimTouchedRow()));
    expect(screen.queryByTestId("setting-saved")).toBeNull();
  });
});
