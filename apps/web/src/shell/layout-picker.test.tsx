// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { EMPTY_GRID, GRID_PRESETS, PRESET_LABELS, useLayoutStore } from "@/stores/layout";

import { LayoutPicker } from "./layout-picker";

afterEach(() => {
  cleanup();
  useLayoutStore.setState({ grid: EMPTY_GRID });
});

/** Opens the picker from its one title bar button and waits for its presets. */
async function openPicker() {
  fireEvent.click(screen.getByRole("button", { name: /^Layout: / }));
  await screen.findByRole("radiogroup", { name: "Layout" });
  return screen.getAllByRole("radio");
}

describe("LayoutPicker", () => {
  it("is one button naming the current preset, its six presets behind it", async () => {
    useLayoutStore.setState({ grid: EMPTY_GRID });
    render(<LayoutPicker />);
    const preset = useLayoutStore.getState().grid.preset;
    expect(screen.getByRole("button", { name: `Layout: ${PRESET_LABELS[preset]}` })).toBeTruthy();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(await openPicker()).toHaveLength(GRID_PRESETS.length);
  });

  it("is one Tab stop that the arrows move through, choosing each preset", async () => {
    useLayoutStore.setState({ grid: EMPTY_GRID });
    render(<LayoutPicker />);
    const radios = await openPicker();
    expect(radios.filter((radio) => radio.tabIndex === 0)).toHaveLength(1);

    const current = radios.find((radio) => radio.getAttribute("aria-checked") === "true")!;
    await waitFor(() => expect(document.activeElement).toBe(current));
    fireEvent.keyDown(current, { key: "ArrowRight" });
    const index = GRID_PRESETS.indexOf(useLayoutStore.getState().grid.preset);
    expect(document.activeElement).toBe(
      screen.getByRole("radio", { name: PRESET_LABELS[GRID_PRESETS[index]!] }),
    );
    expect(index).toBe((radios.indexOf(current) + 1) % GRID_PRESETS.length);

    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(useLayoutStore.getState().grid.preset).toBe(GRID_PRESETS.at(-1));
  });

  it("takes a clicked preset and closes", async () => {
    useLayoutStore.setState({ grid: EMPTY_GRID });
    render(<LayoutPicker />);
    await openPicker();
    const last = GRID_PRESETS.at(-1)!;
    fireEvent.click(screen.getByRole("radio", { name: PRESET_LABELS[last] }));
    expect(useLayoutStore.getState().grid.preset).toBe(last);
    await waitFor(() => expect(screen.queryByRole("radiogroup")).toBeNull());
    expect(screen.getByRole("button", { name: `Layout: ${PRESET_LABELS[last]}` })).toBeTruthy();
  });
});
