// @vitest-environment happy-dom
import { paletteFromSeeds, PRESET_PALETTES } from "@gram/themes";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createThemeStore } from "@/theme/store";

import { PaletteEditor } from "./palette-editor";

const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
};

const TOKYO = PRESET_PALETTES.find((p) => p.id === "tokyo-night")!;
const MINE = paletteFromSeeds(TOKYO.seeds, { id: "custom:mine", name: "Mine" });

const setup = (options: { palette?: string; custom?: (typeof MINE)[] } = {}) => {
  const store = createThemeStore(memoryStorage());
  store.getState().setCustomPalettes(options.custom ?? []);
  store.getState().setTheme({ palette: options.palette ?? "tokyo-night" });
  render(<PaletteEditor store={store} />);
  return store;
};

const field = (label: string) => screen.getByRole("textbox", { name: label }) as HTMLInputElement;
const type = (label: string, value: string) =>
  fireEvent.change(field(label), { target: { value } });

afterEach(cleanup);

describe("PaletteEditor", () => {
  it("starts from the active palette and saves the edit as a new custom palette", () => {
    const store = setup();
    expect(field("Background").value).toBe(TOKYO.seeds.bg);
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();

    type("Accent", "#ff8800");
    type("New palette name", "Night shift");
    fireEvent.click(screen.getByRole("button", { name: "Save as…" }));

    const { customPalettes, palette } = store.getState();
    expect(palette).toBe("custom:night-shift");
    expect(customPalettes).toEqual([
      expect.objectContaining({
        id: "custom:night-shift",
        name: "Night shift",
        mode: "dark",
        seeds: expect.objectContaining({ accent: "#ff8800", bg: TOKYO.seeds.bg }),
      }),
    ]);
  });

  it("explains an unusable name without saving", () => {
    const store = setup();
    fireEvent.click(screen.getByRole("button", { name: "Save as…" }));
    expect(screen.getByRole("alert").textContent).toBe("Give the palette a name");

    type("New palette name", "Dracula");
    fireEvent.click(screen.getByRole("button", { name: "Save as…" }));
    expect(screen.getByRole("alert").textContent).toBe("“Dracula” already exists");
    expect(store.getState().customPalettes).toEqual([]);
  });

  it("warns about low contrast but still saves", () => {
    const store = setup();
    type("Text", TOKYO.seeds.bg);
    const warnings = screen.getByRole("list", { name: "Contrast warnings" });
    expect(warnings.textContent).toContain("Text on background is 1.0:1, below 4.5:1");

    type("New palette name", "Invisible");
    fireEvent.click(screen.getByRole("button", { name: "Save as…" }));
    expect(store.getState().customPalettes.map((p) => p.id)).toEqual(["custom:invisible"]);
  });

  it("previews the draft in a scoped palette", () => {
    setup();
    type("Background", "#123456");
    expect(screen.getByTestId("palette-preview").getAttribute("data-palette")).toBe(
      "gram-palette-preview",
    );
    const css = [...document.querySelectorAll("style")].map((s) => s.textContent).join("");
    expect(css).toContain('[data-palette="gram-palette-preview"]');
    expect(css).toContain("#123456");
  });

  it("saves changes to a custom palette and deletes it after confirming", () => {
    const store = setup({ palette: "custom:mine", custom: [MINE] });
    const save = screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    type("Errors", "#ff0000");
    fireEvent.click(save);
    expect(store.getState().customPalettes[0]?.seeds.red).toBe("#ff0000");

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    expect(store.getState().customPalettes).toEqual([]);
    expect(store.getState().palette).toBe("neutral-dark");
  });
});
