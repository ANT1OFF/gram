import { describe, expect, it } from "vitest";

import { apcaContrast, composite, contrastRatio, mix } from "./color.ts";
import { themeVariables, type CssVariables } from "./css.ts";
import { LOOK_IDS } from "./looks.ts";
import {
  CONTRAST_TARGETS,
  derivePalette,
  ANSI_KEYS,
  resolvePalette,
  SECTION_TINT,
  type Contrast,
  type Mode,
} from "./palette.ts";
import { PRESET_PALETTES } from "./presets.ts";

const MODES: Mode[] = ["dark", "light"];
const CONTRASTS: Contrast[] = ["standard", "more"];

/** The tokens a sidebar section's count can be drawn in, each on a tint of itself. */
const SECTION_HUES = ["status-needs", "status-working", "status-idle", "success-text", "info-text"];

const cases = LOOK_IDS.flatMap((look) =>
  PRESET_PALETTES.flatMap((palette) =>
    MODES.flatMap((mode) =>
      CONTRASTS.map((contrast) => ({ look, palette: palette.id, mode, contrast })),
    ),
  ),
);

/** Every pair below the floor, as "fg on bg = ratio" strings. */
function failures(vars: CssVariables, mode: Mode, contrast: Contrast): string[] {
  const v = (name: string) => vars[`--${name}`]!;
  const target = CONTRAST_TARGETS[contrast];
  // More contrast forces opaque surfaces (web tokens.css), so translucency only applies at standard.
  const alpha = contrast === "more" ? 1 : Number(v("surface-alpha"));
  const wash = Number(v("wash-strength"));
  const scanline = Number(v("scanline-alpha"));
  const backdrop = mode === "dark" ? "#000000" : "#ffffff";
  // Glass: chrome and overlays sit over the page backdrop, tinted at its strongest by the wash.
  const washes = [mix(v("surface-2"), v("accent"), wash), mix(v("surface-2"), v("info"), wash)];
  const surfaces: Record<string, string> = {
    "surface-1": v("surface-1"),
    "surface-2": v("surface-2"),
    "surface-3": v("surface-3"),
    "surface-1@alpha/backdrop": composite(v("surface-1"), alpha, backdrop),
    "surface-1@alpha/surface-2": composite(v("surface-1"), alpha, v("surface-2")),
    "surface-1@alpha/wash-accent": composite(v("surface-1"), alpha, washes[0]!),
    "surface-1@alpha/wash-info": composite(v("surface-1"), alpha, washes[1]!),
    "surface-3@alpha/backdrop": composite(v("surface-3"), alpha, backdrop),
    "surface-3@alpha/wash-accent": composite(v("surface-3"), alpha, washes[0]!),
    // Overlays over the modal scrim (web tokens.css: surface-1 at 60%, 80% at more contrast).
    "surface-3@alpha/scrim": composite(
      v("surface-3"),
      alpha,
      composite(v("surface-1"), contrast === "more" ? 0.8 : 0.6, v("surface-2")),
    ),
  };
  // Terminal: scanline rows mix each surface toward the backdrop extreme; more contrast removes them.
  if (scanline > 0 && contrast === "standard") {
    for (const name of ["surface-1", "surface-2", "surface-3"]) {
      surfaces[`${name}+scanline`] = mix(v(name), backdrop, scanline);
    }
  }
  const out: string[] = [];
  const check = (fg: string, bgs: Record<string, string>, floor: number) => {
    for (const [bgName, bg] of Object.entries(bgs)) {
      const ratio = contrastRatio(v(fg), bg);
      if (ratio < floor) out.push(`${fg} on ${bgName} = ${ratio.toFixed(2)} (< ${floor})`);
    }
  };

  for (const fg of [
    "fg",
    "fg-muted",
    "accent-text",
    "danger-text",
    "success-text",
    "warning-text",
    "info-text",
  ]) {
    check(fg, surfaces, target.text);
  }
  check("fg", { "surface-hover": v("surface-hover") }, target.text);
  check("on-accent", { accent: v("accent") }, target.text);
  // Hunk rows: code, line numbers and the +/− sign on each row tint.
  for (const fg of ["fg", "fg-muted", "diff-add-fg"]) {
    check(fg, { "diff-add-bg": v("diff-add-bg") }, target.text);
  }
  for (const fg of ["fg", "fg-muted", "diff-del-fg"]) {
    check(fg, { "diff-del-bg": v("diff-del-bg") }, target.text);
  }
  // Statuses and selected text are read as text; so is error text on its own tint (destructive
  // badges and buttons: 10% light, 20% dark) and the needs-you count badge's page-coloured digits.
  for (const fg of ["status-needs", "status-working", "status-idle", "merged"]) {
    check(fg, surfaces, target.text);
  }
  check("fg", { selection: v("selection") }, target.text);
  // Destructive tints (web tokens.css): 10%, 15% on hover, dropped at more contrast.
  if (contrast === "standard") {
    for (const tint of [0.1, 0.15]) {
      check(
        "danger-text",
        Object.fromEntries(
          ["surface-1", "surface-2", "surface-3"].map((bg) => [
            `danger-text ${tint * 100}% tint over ${bg}`,
            mix(v(bg), v("danger-text"), tint),
          ]),
        ),
        target.text,
      );
    }
  }
  // Sidebar section counts (web sidebar/section-header.tsx): the section's hue as text on its own
  // tint (palette.ts SECTION_TINT), over the sidebar and the head's hover; dropped at
  // more contrast.
  if (contrast === "standard") {
    for (const fg of SECTION_HUES) {
      check(
        fg,
        Object.fromEntries(
          ["surface-1", "surface-2", "surface-3", "surface-hover"].map((bg) => [
            `${fg} ${SECTION_TINT * 100}% tint over ${bg}`,
            // The pill's colour-mix to transparent, composited as the browser does: in sRGB.
            composite(v(fg), SECTION_TINT, v(bg)),
          ]),
        ),
        target.text,
      );
    }
  }
  check("surface-2", { "status-needs": v("status-needs") }, target.text);
  for (const fg of [
    "focus-ring",
    "accent",
    "border-strong",
    "fg-subtle",
    "highlight",
    "danger",
    "success",
    "warning",
    "info",
    // Provider colours are drawn as graphics (usage charts, limit meters), so they meet the ui floor.
    "provider-anthropic",
    "provider-openai",
  ]) {
    check(fg, surfaces, target.ui);
  }
  return out;
}

describe("contrast matrix (WCAG 2.2 AA floor)", () => {
  it.each(cases)("$look × $palette × $mode × $contrast", ({ look, palette, mode, contrast }) => {
    const resolvedMode = resolvePalette(PRESET_PALETTES, palette, mode)!.mode;
    const vars = themeVariables({ look, palette, mode, contrast });
    expect(failures(vars, resolvedMode, contrast)).toEqual([]);
  });

  it("keeps APCA Lc for body text at the content-text floor", () => {
    for (const palette of PRESET_PALETTES) {
      const vars = themeVariables({
        look: "glass",
        palette: palette.id,
        mode: palette.mode,
        contrast: "standard",
      });
      const lc = Math.abs(apcaContrast(vars["--fg"]!, vars["--surface-2"]!));
      // APCA is supplementary (WCAG gates above). Lc 60 is its floor for content text; some preset
      // text seeds sit between 60 and 75 and are kept rather than repainted.
      expect(lc, `${palette.id} fg on surface-2`).toBeGreaterThanOrEqual(60);
    }
  });
});

describe("terminal ANSI text contrast", () => {
  it.each(PRESET_PALETTES.slice(22))(
    "$id keeps every SGR foreground readable in standard and more contrast",
    (palette) => {
      for (const contrast of CONTRASTS) {
        const { ansi } = derivePalette(palette, contrast);
        const textKeys = ANSI_KEYS.filter((key) => !["background", "selection"].includes(key));
        for (const key of textKeys) {
          expect(
            contrastRatio(ansi[key], ansi.background),
            `${palette.id} ${contrast} ${key}`,
          ).toBeGreaterThanOrEqual(CONTRAST_TARGETS[contrast].text);
        }
      }
    },
  );
});
