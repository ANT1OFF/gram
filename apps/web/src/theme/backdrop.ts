import {
  ACCENT_SEPARATOR,
  backdropLevels,
  derivePalette,
  isAccentId,
  isSceneId,
  paletteCss,
  sceneSvg,
  withAccent,
  type Palette,
  type SurfacesId,
} from "@gram/themes";

import type { ThemeAttributes } from "./theme";

// The look's parts that are written at run time, for the palette actually rendered: an accent laid
// over it (its own `[data-palette]` block), and a background picture behind the app (the page,
// `--thread-bg`, goes clear) with the levels
// that keep the palette's text readable over it (theme/looks.css draws the layer).

const STYLE_ID = "gram-look";
const LAYER_ID = "gram-backdrop";

const rgba = (hex: string, alpha: number) => {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return alpha >= 1 ? hex : `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/** The palette `attrs` render, the accent laid over it where the id names one. */
export function renderedPalette(
  attrs: Pick<ThemeAttributes, "data-palette">,
  palettes: readonly Palette[],
): Palette | undefined {
  const [base, accent] = attrs["data-palette"].split(ACCENT_SEPARATOR);
  const palette = palettes.find((p) => p.id === base);
  if (!palette) return undefined;
  return isAccentId(accent) ? withAccent(palette, accent) : palette;
}

/** The stylesheet for the accent and the picture's levels, empty when neither is set. */
export function lookCss(
  attrs: Pick<ThemeAttributes, "data-palette" | "data-backdrop" | "data-surfaces">,
  palettes: readonly Palette[],
): string {
  const palette = renderedPalette(attrs, palettes);
  if (!palette) return "";
  const parts: string[] = [];
  if (palette.id.includes(ACCENT_SEPARATOR)) parts.push(paletteCss(palette));
  const scene = attrs["data-backdrop"];
  if (isSceneId(scene)) {
    const { colors } = derivePalette(palette);
    const surfaces = attrs["data-surfaces"] as SurfacesId;
    const { scrim, alpha } = backdropLevels(colors, palette.mode, scene, surfaces);
    // More contrast keeps its own, solid surfaces: its `[data-contrast]` block is more specific.
    parts.push(
      `:root[data-backdrop="${scene}"] {` +
        ` --thread-bg: transparent;` +
        ` --surface-3: ${rgba(colors["surface-3"], alpha)};` +
        ` --surface-alpha: ${alpha};` +
        ` --backdrop-scrim: ${rgba(colors["surface-2"], scrim)}; }`,
    );
  }
  return parts.join("\n");
}

/** Writes the look's run-time stylesheet and the picture layer for `attrs`. */
export function syncLookStyle(
  doc: Document,
  attrs: Pick<ThemeAttributes, "data-palette" | "data-backdrop" | "data-surfaces" | "data-mode">,
  palettes: readonly Palette[],
): void {
  const css = lookCss(attrs, palettes);
  let style = doc.getElementById(STYLE_ID);
  if (css) {
    if (!style) {
      style = doc.createElement("style");
      style.id = STYLE_ID;
      doc.head.append(style);
    }
    if (style.textContent !== css) style.textContent = css;
  } else style?.remove();

  const scene = attrs["data-backdrop"];
  let layer = doc.getElementById(LAYER_ID);
  if (!isSceneId(scene)) {
    layer?.remove();
    return;
  }
  const key = `${scene}:${attrs["data-mode"]}`;
  if (!layer) {
    layer = doc.createElement("div");
    layer.id = LAYER_ID;
    layer.setAttribute("aria-hidden", "true");
    doc.body.prepend(layer);
  }
  if (layer.dataset["scene"] !== key) {
    layer.dataset["scene"] = key;
    // Drawn from code, never from anything a person typed.
    layer.innerHTML = sceneSvg(scene, attrs["data-mode"] === "dark", "gram-backdrop");
  }
}
