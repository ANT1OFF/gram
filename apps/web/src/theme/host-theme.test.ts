// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { bootTheme } from "@/embed/theme-boot";
import type { HostTheme } from "@/embed/contract";
import { paletteChoices } from "@/settings/palette-choices";

import {
  HOST_PALETTE_IDS,
  hostPaletteFor,
  hostPalettes,
  hostThemeCss,
  installHostTheme,
} from "./host-theme";
import { createThemeStore } from "./store";
import { startThemeSync } from "./sync";

const seeds = (bg: string, text: string) => ({
  bg,
  surface: bg,
  text,
  muted: "#85837d",
  accent: "#c2a878",
  accent2: "#9fb6c8",
  red: "#e08a7e",
  green: "#8fbf9a",
  yellow: "#e3c56a",
  cyan: "#9fb6c8",
});

const THEME: HostTheme = {
  name: "House",
  palettes: { dark: seeds("#0b0c0d", "#ecebe6"), light: seeds("#f5f4f0", "#161718") },
  colors: { dark: { accent: "#ecebe6", "on-accent": "#0b0c0d" } },
  fonts: { ui: '"Inter Tight", sans-serif', mono: '"Martian Mono", monospace' },
  radii: { sm: 4, md: 6, lg: 8 },
  shadows: "none",
  chart: { dark: ["#6f6d66", "#c2a878"], light: ["#b5b2a8", "#8c6d3a"] },
};

const memory = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
};
const system = (prefersDark = true) => ({
  get: () => ({ prefersDark, prefersReducedMotion: false, prefersMoreContrast: false }),
  subscribe: () => () => {},
});

describe("a theme the mounting page gives Gram", () => {
  it("adds nothing when there is no theme", () => {
    expect(hostThemeCss(undefined)).toBe("");
    expect(hostPalettes(undefined)).toEqual([]);
    expect(hostPaletteFor("neutral-dark", undefined)).toBe("neutral-dark");
    installHostTheme(document, undefined);
    expect(document.getElementById("gram-host-theme")).toBeNull();
  });

  it("pairs its two palettes and stands in for Gram's default pair only", () => {
    const [dark, light] = hostPalettes(THEME);
    expect(dark).toMatchObject({ id: HOST_PALETTE_IDS.dark, mode: "dark", pairId: "host-light" });
    expect(light).toMatchObject({ id: HOST_PALETTE_IDS.light, mode: "light", pairId: "host-dark" });
    expect(hostPaletteFor("neutral-dark", THEME)).toBe("host-dark");
    expect(hostPaletteFor("neutral", THEME)).toBe("host-light");
    expect(hostPaletteFor("tokyo-night", THEME)).toBe("tokyo-night");
  });

  it("writes its palettes, colours, fonts, radii, shadows and chart colours", () => {
    const css = hostThemeCss(THEME);
    expect(css).toContain('[data-palette="host-dark"] {');
    expect(css).toContain('[data-palette="host-light"][data-contrast="more"]');
    expect(css).toMatch(/\[data-palette="host-dark"\] \{[^}]*--accent: #ecebe6;/);
    expect(css).toMatch(/\[data-palette="host-dark"\] \{[^}]*--chart-2: #c2a878;/);
    expect(css).toMatch(/\[data-palette="host-light"\] \{[^}]*--chart-1: #b5b2a8;/);
    expect(css).toMatch(/html\[data-look\] \{[^}]*--font-ui: "Inter Tight", sans-serif;/);
    expect(css).toContain("--radius-md: 6px;");
    expect(css).toContain("--shadow-raised: none;");
  });

  it("keeps chart colours by mode on Gram's own palettes when it gives no palette", () => {
    const css = hostThemeCss({ chart: { dark: ["#111111"] } });
    expect(css).toContain(':root[data-mode="dark"] {\n  --chart-1: #111111;');
    expect(css).not.toContain("data-palette");
  });

  it("paints its palette from first paint, until the person picks another", () => {
    installHostTheme(document, THEME);
    expect(document.getElementById("gram-host-theme")?.textContent).toContain("host-dark");
    const boot = document.createElement("html");
    bootTheme(boot, { getItem: () => null }, () => false, THEME);
    expect(boot.dataset["palette"]).toBe("host-dark");

    const root = document.createElement("html");
    const store = createThemeStore(memory());
    const stop = startThemeSync(store, system(false), root);
    expect(root.getAttribute("data-palette")).toBe("host-dark");
    store.getState().setTheme({ mode: "light" });
    expect(root.getAttribute("data-palette")).toBe("host-light");
    store.getState().setTheme({ palette: "tokyo-night", mode: "dark" });
    expect(root.getAttribute("data-palette")).toBe("tokyo-night");
    stop();
    installHostTheme(document, undefined);
    expect(document.getElementById("gram-host-theme")).toBeNull();
  });

  it("shows the default card under the host's name in Settings", () => {
    const [first] = paletteChoices("neutral-dark", [], THEME);
    expect(first).toMatchObject({ id: "neutral-dark", name: "House" });
    expect(first?.swatch).toContain("#0b0c0d");
    expect(paletteChoices("neutral-dark", [])[0]?.name).toBe("Neutral");
  });
});
