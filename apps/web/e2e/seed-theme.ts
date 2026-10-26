import type { Page } from "@playwright/test";

export interface SeededTheme {
  /** Glass, the only look, unless given. */
  look?: "glass";
  palette: string;
  mode: "light" | "dark";
  motion: "system" | "reduced" | "off";
}

/**
 * Seeds a theme where the app reads it: the theme store's first-paint cache and the mock server's
 * settings, which win once they load. Seeding only the cache flips back to the defaults a moment
 * after the first paint.
 */
export const seedTheme = (page: Page, theme: SeededTheme) =>
  page.addInitScript(({ look = "glass", palette, mode, motion }) => {
    if (localStorage.getItem("gram.theme") === null) {
      localStorage.setItem(
        "gram.theme",
        JSON.stringify({
          state: {
            look,
            palette,
            mode,
            density: "compact",
            contrast: "system",
            motion,
            customPalettes: [],
          },
          version: 1,
        }),
      );
    }
    if (sessionStorage.getItem("gram.mock.settings") === null) {
      sessionStorage.setItem(
        "gram.mock.settings",
        JSON.stringify({
          appearance: {
            look,
            paletteId: palette,
            mode,
            density: "compact",
            contrast: "standard",
            motion,
          },
        }),
      );
    }
  }, theme);
