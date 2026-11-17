import { paletteCss, PRESET_PALETTES, type Palette } from "@gram/themes";

import { syncLookStyle } from "./backdrop";
import { hostPalettes, hostTheme } from "./host-theme";
import { effectivePrefs } from "./look-defaults";
import type { ThemeStore } from "./store";
import type { SystemSource } from "./system";
import { applyAttributes, themeAttributes } from "./theme";

/** Mirrors the store and OS preferences onto `root`'s `data-*` attributes until disposed. */
export function startThemeSync(
  store: ThemeStore,
  system: SystemSource,
  root: Pick<Element, "setAttribute">,
  doc: Document | undefined = typeof document === "undefined" ? undefined : document,
): () => void {
  const apply = () => {
    const state = store.getState();
    const host = hostTheme();
    const palettes = [...PRESET_PALETTES, ...state.customPalettes, ...hostPalettes(host)];
    const attrs = themeAttributes(effectivePrefs(state, host), system.get(), palettes);
    applyAttributes(root, attrs);
    if (doc) syncLookStyle(doc, attrs, palettes);
  };
  apply();
  const unsubscribeStore = store.subscribe(apply);
  const unsubscribeSystem = system.subscribe(apply);
  return () => {
    unsubscribeStore();
    unsubscribeSystem();
  };
}

const CUSTOM_PALETTE_STYLE_ID = "gram-custom-palettes";

/** Writes the custom palettes' `[data-palette]` blocks into a single managed `<style>`. */
export function syncCustomPaletteStyle(doc: Document, palettes: readonly Palette[]) {
  let style = doc.getElementById(CUSTOM_PALETTE_STYLE_ID);
  if (!palettes.length) {
    style?.remove();
    return;
  }
  if (!style) {
    style = doc.createElement("style");
    style.id = CUSTOM_PALETTE_STYLE_ID;
    doc.head.append(style);
  }
  style.textContent = palettes.map((palette) => paletteCss(palette)).join("\n");
}
