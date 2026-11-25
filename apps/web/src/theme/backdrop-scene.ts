import {
  backdropLevels,
  derivePalette,
  isSceneId,
  sceneSvg,
  SURFACES_IDS,
  type Palette,
} from "@gram/themes";

import { oneOf } from "@/lib/one-of";

const STYLE_ID = "gram-backdrop-style";
const LAYER_ID = "gram-backdrop";

const rgba = (hex: string, alpha: number) => {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return alpha >= 1 ? hex : `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/** The levels for `palette` over `scene`, as the variables theme/looks.css reads. */
export function backdropCss(palette: Palette, scene: string, surfaces: string): string {
  const shown = oneOf(SURFACES_IDS, surfaces);
  if (!isSceneId(scene) || shown === undefined) return "";
  const { colors } = derivePalette(palette);
  const { scrim, alpha } = backdropLevels(colors, palette.mode, scene, shown);
  return (
    `:root[data-backdrop="${scene}"] {` +
    ` --thread-bg: transparent;` +
    ` --surface-3: ${rgba(colors["surface-3"], alpha)};` +
    ` --surface-alpha: ${alpha};` +
    ` --backdrop-scrim: ${rgba(colors["surface-2"], scrim)}; }`
  );
}

/** Draws the picture and its levels for `scene`, or takes them away when there is none. */
export function syncScene(
  doc: Document,
  palette: Palette | undefined,
  scene: string,
  surfaces: string,
  mode: string,
): void {
  let style = doc.getElementById(STYLE_ID);
  let layer = doc.getElementById(LAYER_ID);
  if (!palette || !isSceneId(scene)) {
    style?.remove();
    layer?.remove();
    return;
  }
  const css = backdropCss(palette, scene, surfaces);
  if (!style) {
    style = doc.createElement("style");
    style.id = STYLE_ID;
    doc.head.append(style);
  }
  if (style.textContent !== css) style.textContent = css;
  const key = `${scene}:${mode}`;
  if (!layer) {
    layer = doc.createElement("div");
    layer.id = LAYER_ID;
    layer.setAttribute("aria-hidden", "true");
    doc.body.prepend(layer);
  }
  if (layer.dataset["scene"] !== key) {
    layer.dataset["scene"] = key;
    layer.innerHTML = sceneSvg(scene, mode === "dark", "gram-backdrop");
  }
}
