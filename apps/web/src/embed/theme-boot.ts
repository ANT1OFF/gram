import { fieldsOf } from "@gram/contracts";
import { PRESET_PALETTES, resolvePalette, type Palette } from "@gram/themes";

import { hostPalettes, type HostTheme } from "@/theme/host-theme";
import { paletteToRender } from "@/theme/look-defaults";

import type { LookDefaults } from "./contract";

/**
 * What `index.html` does before the app's first paint, for a page that isn't Gram's own: the
 * attributes on `<html>` the styles hang on, from the stored theme, so nothing fades into it.
 * `ThemeRoot` finishes the job (contrast, custom palettes) and clears `data-theme-booting`.
 */
export const bootTheme = (
  root: HTMLElement,
  storage: Pick<Storage, "getItem"> | undefined,
  prefersLight: () => boolean = () =>
    typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches,
  theme?: HostTheme,
  defaults?: LookDefaults,
): void => {
  let state: ReadonlyMap<string, unknown> = new Map();
  try {
    const stored: unknown = JSON.parse(storage?.getItem("gram.theme") ?? "{}");
    state = fieldsOf(fieldsOf(stored).get("state"));
  } catch (_unreadableStorageBootsTheDefaults) {}
  const chosen = state.get("mode");
  let mode: "light" | "dark" = chosen === "light" ? "light" : "dark";
  if (chosen === "system") mode = prefersLight() ? "light" : "dark";
  const palette = state.get("palette");
  const motion = state.get("motion");
  const stored = typeof palette === "string" && palette !== "" ? palette : "neutral-dark";
  root.dataset["look"] ??= "glass";
  root.dataset["mode"] = mode;
  root.dataset["palette"] = pairedPalette(paletteToRender(stored, theme, defaults), mode, theme);
  root.dataset["motion"] =
    typeof motion === "string" && /^(reduced|off)$/.test(motion) ? motion : "system";
  root.setAttribute("data-theme-booting", "");
};

const pairedPalette = (stored: string, mode: "light" | "dark", theme?: HostTheme): string =>
  resolvePalette([...(PRESET_PALETTES as readonly Palette[]), ...hostPalettes(theme)], stored, mode)
    ?.id ?? stored;
