import {
  backdropLevels,
  derivePalette,
  isSceneId,
  sceneSvg,
  type Palette,
  type SurfacesId,
} from "@gram/themes";

// The background picture's part of the look, loaded only once a picture is chosen so the scenes
// and their contrast check stay out of the first paint: the layer under the app (theme/looks.css
// draws it) and the levels that keep the palette's text readable over it.

const STYLE_ID = "gram-backdrop-style";
const LAYER_ID = "gram-backdrop";

const rgba = (hex: string, alpha: number) => {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return alpha >= 1 ? hex : `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/** The levels for `palette` over `scene`, as the variables theme/looks.css reads. */
export function backdropCss(palette: Palette, scene: string, surfaces: string): string {
  if (!isSceneId(scene)) return "";
  const { colors } = derivePalette(palette);
  const { scrim, alpha } = backdropLevels(colors, palette.mode, scene, surfaces as SurfacesId);
  // The page goes clear; More contrast keeps its own, solid surfaces, its block being more specific.
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
    // Drawn from code, never from anything a person typed.
    layer.innerHTML = sceneSvg(scene, mode === "dark", "gram-backdrop");
  }
}
