import { PRESET_PALETTES, resolvePalette, type Palette } from "@gram/themes";

import { hostPaletteFor, hostPalettes, type HostTheme } from "@/theme/host-theme";

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
): void => {
  let state: { mode?: unknown; palette?: unknown; motion?: unknown } = {};
  try {
    const stored = JSON.parse(storage?.getItem("gram.theme") ?? "{}") as { state?: typeof state };
    state = stored.state ?? {};
  } catch {
    // Unreadable storage boots the defaults.
  }
  let mode: "light" | "dark" = state.mode === "light" ? "light" : "dark";
  if (state.mode === "system") mode = prefersLight() ? "light" : "dark";
  const stored =
    typeof state.palette === "string" && state.palette !== "" ? state.palette : "neutral-dark";
  root.dataset["look"] ??= "glass";
  root.dataset["mode"] = mode;
  root.dataset["palette"] = pairedPalette(hostPaletteFor(stored, theme), mode, theme);
  root.dataset["motion"] =
    typeof state.motion === "string" && /^(reduced|off)$/.test(state.motion)
      ? state.motion
      : "system";
  root.setAttribute("data-theme-booting", "");
};

/** A preset palette stored in the other mode paints as its partner, the way `ThemeRoot` will. */
const pairedPalette = (stored: string, mode: "light" | "dark", theme?: HostTheme): string =>
  resolvePalette([...(PRESET_PALETTES as readonly Palette[]), ...hostPalettes(theme)], stored, mode)
    ?.id ?? stored;
