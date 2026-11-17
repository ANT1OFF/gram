import {
  ACCENT_SEPARATOR,
  isAccentId,
  isSceneId,
  paletteCss,
  withAccent,
  type Palette,
} from "@gram/themes";

import type { syncScene } from "./backdrop-scene";
import type { ThemeAttributes } from "./theme";

// The look's parts that are written at run time, for the palette actually rendered: an accent laid
// over it (its own `[data-palette]` block), and a background picture behind the app, whose scenes
// and levels load only once one is chosen (backdrop-scene.ts).

const STYLE_ID = "gram-look";

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

/** The accented palette's block, empty with no accent. */
export function accentCss(
  attrs: Pick<ThemeAttributes, "data-palette">,
  palettes: readonly Palette[],
): string {
  const palette = renderedPalette(attrs, palettes);
  return palette?.id.includes(ACCENT_SEPARATOR) ? paletteCss(palette) : "";
}

/** Writes the accent's stylesheet, and the picture and its levels for `attrs`. */
export function syncLookStyle(
  doc: Document,
  attrs: Pick<ThemeAttributes, "data-palette" | "data-backdrop" | "data-surfaces" | "data-mode">,
  palettes: readonly Palette[],
): void {
  const css = accentCss(attrs, palettes);
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
  const palette = renderedPalette(attrs, palettes);
  const draw = (sync: typeof syncScene) => {
    // A choice made while the module loaded wins: draw only what the page still asks for.
    const asked = doc.documentElement.getAttribute("data-backdrop") ?? scene;
    sync(
      doc,
      asked === scene ? palette : undefined,
      scene,
      attrs["data-surfaces"],
      attrs["data-mode"],
    );
  };
  if (isSceneId(scene)) void import("./backdrop-scene").then((loaded) => draw(loaded.syncScene));
  else {
    doc.getElementById("gram-backdrop")?.remove();
    doc.getElementById("gram-backdrop-style")?.remove();
  }
}
