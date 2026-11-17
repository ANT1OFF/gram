import { composite, contrastRatio } from "./color.ts";
import type { Mode } from "./palette.ts";

/**
 * Background pictures a person can put behind the app: six calm generated scenes, each with a
 * dawn version for light mode and a night version for dark. They are drawn as SVG from code, so
 * nothing is fetched. The night moons are faint on purpose, so text that lands over one still
 * reads (see {@link SCENE_SCRIM}).
 */
export const SCENES = [
  { id: "fjord", name: "Fjord" },
  { id: "dunes", name: "Dunes" },
  { id: "pines", name: "Pines" },
  { id: "coast", name: "Coast" },
  { id: "peaks", name: "Peaks" },
  { id: "waves", name: "Soft waves" },
] as const satisfies readonly { readonly id: string; readonly name: string }[];

export type SceneId = (typeof SCENES)[number]["id"];

export const SCENE_IDS: readonly SceneId[] = SCENES.map((scene) => scene.id);

export const isSceneId = (value: unknown): value is SceneId =>
  typeof value === "string" && (SCENE_IDS as readonly string[]).includes(value);

/**
 * How opaque cards, the sidebar and the title bar are over a picture: solid, frosted, or
 * see-through. Frosted and see-through blur what is behind them.
 */
export const SURFACE_OPACITY = { solid: 1, frosted: 0.8, clear: 0.62 } as const;

export type SurfacesId = keyof typeof SURFACE_OPACITY;

export const SURFACES_IDS = Object.keys(SURFACE_OPACITY) as SurfacesId[];

/**
 * The least share of the page colour washed over a picture, per mode. {@link backdropLevels}
 * raises it, and the surfaces' opacity, as far as a palette's text needs to hold the text contrast
 * target over the scene.
 */
export const SCENE_SCRIM = { light: 0.6, dark: 0.3 } as const;

/** The text colours checked over a picture: on the page itself, and on cards. */
const PAGE_TEXT = ["fg", "fg-muted"] as const;
const CARD_TEXT = ["fg", "fg-muted", "fg-subtle", "accent-text", "danger-text"] as const;

/**
 * Every colour a scene can show, as the pixels text could land on: each opaque fill, and each
 * translucent shape (a moon, a glint) composited over every one of those, the worst case. Stars
 * (dots under 2px) are left out: no glyph sits on one alone.
 */
export function scenePixels(svg: string): string[] {
  const opaque = new Set<string>();
  const translucent: [string, number][] = [];
  for (const [element] of svg.matchAll(/<(?:path|rect|circle|stop)\b[^>]*>/g)) {
    const color = /(?:fill|stroke|stop-color)="(#[0-9a-f]{6})"/i.exec(element)?.[1];
    if (!color) continue;
    if (Number(/\br="([\d.]+)"/.exec(element)?.[1] ?? Infinity) < 2) continue;
    const opacity = Number(/\bopacity="([\d.]+)"/.exec(element)?.[1] ?? 1);
    if (opacity < 1) translucent.push([color, opacity]);
    else opaque.add(color);
  }
  const all = new Set(opaque);
  for (const [color, opacity] of translucent)
    for (const under of opaque) all.add(composite(color, opacity, under));
  return [...all];
}

const holds = (texts: readonly string[], backgrounds: readonly string[], target: number) =>
  backgrounds.every((background) =>
    texts.every((text) => contrastRatio(text, background) >= target),
  );

/** The least of `from`, `from + step`, … up to 1 for which `ok` holds. */
function least(from: number, ok: (value: number) => boolean) {
  for (let value = from; value < 1; value = Math.round((value + 0.02) * 100) / 100)
    if (ok(value)) return value;
  return 1;
}

/**
 * How strongly to wash a scene with the page colour, and how opaque surfaces over it are, for one
 * palette: at least {@link SCENE_SCRIM} and the surfaces' own opacity, raised as far as the
 * palette's page text and card text need to hold `target` over every pixel of the scene.
 */
export function backdropLevels(
  colors: Readonly<
    Record<"surface-1" | "surface-2" | "surface-3" | (typeof CARD_TEXT)[number], string>
  >,
  mode: Mode,
  scene: SceneId,
  surfaces: SurfacesId,
  target = 4.5,
): { readonly scrim: number; readonly alpha: number } {
  const pixels = scenePixels(sceneSvg(scene, mode === "dark"));
  const washed = (scrim: number) =>
    pixels.map((pixel) => composite(colors["surface-2"], scrim, pixel));
  const text = (keys: readonly (typeof CARD_TEXT)[number][]) => keys.map((key) => colors[key]);
  const scrim = least(SCENE_SCRIM[mode], (value) => holds(text(PAGE_TEXT), washed(value), target));
  const under = washed(scrim);
  const alpha = least(SURFACE_OPACITY[surfaces], (value) =>
    // Cards (surface-3) and the sidebar and title bar (surface-1) both take the opacity.
    holds(
      text(CARD_TEXT),
      under.flatMap((pixel) => [
        composite(colors["surface-3"], value, pixel),
        composite(colors["surface-1"], value, pixel),
      ]),
      target,
    ),
  );
  return { scrim, alpha };
}

function trees(y: number, h: number, color: string, step: number, seed: number) {
  let d = `M0 ${y + h}`,
    r = seed;
  for (let x = 0; x <= 1460; x += step) {
    r = (r * 9301 + 49297) % 233280;
    const th = h * (0.55 + (r / 233280) * 0.45);
    d += ` L${x} ${y + h * 0.35} L${x + step / 2} ${y + h - th} L${x + step} ${y + h * 0.35}`;
  }
  return `<path d="${d} L1460 1240 L0 1240Z" fill="${color}"/>`;
}
/**
 * A scene as SVG markup, its dawn or its night version. Everything in the markup is this module's
 * own: an unknown scene draws nothing, and `id` (which keeps the gradient's id apart when several
 * scenes share a page) keeps only letters, digits, `-` and `_`, so no caller's text reaches the
 * markup unescaped.
 */
export function sceneSvg(kind: SceneId, dark: boolean, gradientId = "s"): string {
  if (!isSceneId(kind)) return "";
  const id = gradientId.replace(/[^A-Za-z0-9_-]/g, "") || "s";
  const sky = (a: string, b: string) =>
    `<defs><linearGradient id="${id}sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset=".62" stop-color="${b}"/></linearGradient></defs><rect width="1440" height="1240" fill="url(#${id}sky)"/>`;
  const stars = dark
    ? [
        [120, 90],
        [260, 160],
        [410, 70],
        [640, 130],
        [770, 60],
        [930, 150],
        [1210, 100],
        [1330, 180],
        [540, 210],
        [1010, 40],
      ]
        .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.2" fill="#c9d3e6" opacity=".7"/>`)
        .join("")
    : "";
  const orb = (x: number, yl: number, yd: number, c: string) =>
    `<circle cx="${x}" cy="${dark ? yd : yl}" r="${dark ? 30 : 74}" fill="${c}" opacity="${dark ? 0.3 : 0.9}"/>`;
  let body = "";
  if (kind === "fjord") {
    const c = dark
      ? {
          s1: "#0b1120",
          s2: "#1a2540",
          far: "#1f2b45",
          mid: "#18233a",
          near: "#111a2c",
          water: "#0e1828",
          glint: "#2a3a5c",
          sun: "#e3e8f2",
        }
      : {
          s1: "#dfe7ec",
          s2: "#f4efe6",
          far: "#c4cfd3",
          mid: "#a5b4ba",
          near: "#7f939a",
          water: "#cdd8db",
          glint: "#e9eeef",
          sun: "#fbf4e6",
        };
    body =
      sky(c.s1, c.s2) +
      stars +
      orb(1060, 330, 250, c.sun) +
      `
    <path d="M0 560 L120 500 L260 540 L420 430 L560 520 L700 470 L860 540 L1000 450 L1160 520 L1300 470 L1440 520 V860 H0Z" fill="${c.far}"/>
    <path d="M0 520 L140 470 L300 560 L460 640 L620 760 L720 840 L0 840Z" fill="${c.mid}"/>
    <path d="M1440 480 L1300 430 L1150 540 L1000 650 L880 760 L800 840 L1440 840Z" fill="${c.mid}"/>
    <path d="M0 700 L120 660 L260 740 L400 840 L0 840Z" fill="${c.near}"/>
    <path d="M1440 680 L1320 640 L1180 740 L1060 840 L1440 840Z" fill="${c.near}"/>
    <rect y="840" width="1440" height="400" fill="${c.water}"/>
    <path d="M560 880 H880 M600 920 H840 M640 960 H800 M500 1010 H700 M760 1050 H980 M420 1110 H620" stroke="${c.glint}" stroke-width="3" stroke-linecap="round" opacity=".8"/>`;
  } else if (kind === "dunes") {
    const c = dark
      ? {
          s1: "#120f16",
          s2: "#2a2026",
          sun: "#eadfd2",
          d: ["#3a2c2b", "#302425", "#261d1f", "#1c1618"],
        }
      : {
          s1: "#efe5d8",
          s2: "#f8f2e9",
          sun: "#fff6e6",
          d: ["#e6d3ba", "#d9c09f", "#c9aa85", "#b8946e"],
        };
    body =
      sky(c.s1, c.s2) +
      stars +
      orb(420, 360, 240, c.sun) +
      `
    <path d="M0 640 Q260 560 520 620 T1040 600 T1440 590 V1240 H0Z" fill="${c.d[0]}"/>
    <path d="M0 760 Q300 660 640 740 T1440 700 V1240 H0Z" fill="${c.d[1]}"/>
    <path d="M0 900 Q380 800 760 880 T1440 840 V1240 H0Z" fill="${c.d[2]}"/>
    <path d="M0 1060 Q420 960 900 1040 T1440 1000 V1240 H0Z" fill="${c.d[3]}"/>`;
  } else if (kind === "pines") {
    const c = dark
      ? {
          s1: "#0b1311",
          s2: "#18241f",
          sun: "#e2e8e2",
          t: ["#1b2823", "#16211d", "#111a17", "#0c1311"],
        }
      : {
          s1: "#e2eae4",
          s2: "#f3f2ea",
          sun: "#fbf6ea",
          t: ["#c9d5cc", "#adbdb1", "#8fa596", "#728b7b"],
        };
    body =
      sky(c.s1, c.s2) +
      stars +
      orb(980, 300, 230, c.sun) +
      trees(540, 140, c.t[0]!, 34, 7) +
      trees(660, 170, c.t[1]!, 44, 19) +
      trees(800, 200, c.t[2]!, 56, 31) +
      trees(960, 240, c.t[3]!, 72, 43);
  } else if (kind === "coast") {
    const c = dark
      ? {
          s1: "#0a1220",
          s2: "#17243b",
          sun: "#e3e8f2",
          sea: "#0f1c2f",
          glint: "#2a3b5a",
          cliff: "#141d2c",
          cliff2: "#0e1522",
        }
      : {
          s1: "#e3ecf2",
          s2: "#f6f1e8",
          sun: "#fbf3e3",
          sea: "#bfd0da",
          glint: "#e4ecf0",
          cliff: "#98a9b2",
          cliff2: "#7a8e98",
        };
    body =
      sky(c.s1, c.s2) +
      stars +
      orb(dark ? 1300 : 860, 520, 150, c.sun) +
      `
    <rect y="640" width="1440" height="600" fill="${c.sea}"/>
    <path d="M300 700 H700 M820 700 H1180 M420 760 H900 M980 780 H1300 M200 840 H560 M640 880 H1040 M300 960 H700 M860 1020 H1240" stroke="${c.glint}" stroke-width="3" stroke-linecap="round" opacity=".8"/>
    <path d="M0 420 L90 400 L170 450 L230 560 L290 660 L330 760 L360 900 L380 1240 H0Z" fill="${c.cliff}"/>
    <path d="M0 640 L80 620 L150 700 L200 820 L230 1000 L240 1240 H0Z" fill="${c.cliff2}"/>`;
  } else if (kind === "peaks") {
    const c = dark
      ? {
          s1: "#0b111c",
          s2: "#172236",
          sun: "#e3e8f2",
          far: "#222d42",
          cap: "#3f4c66",
          near: "#151e2e",
          low: "#0f1623",
        }
      : {
          s1: "#e4ebf2",
          s2: "#f5f2ec",
          sun: "#fdf7ec",
          far: "#c9d3dd",
          cap: "#f8fafc",
          near: "#a6b4c2",
          low: "#8798a8",
        };
    body =
      sky(c.s1, c.s2) +
      stars +
      orb(1180, 280, 200, c.sun) +
      `
    <path d="M0 760 L220 420 L360 560 L560 300 L760 580 L940 380 L1140 620 L1300 460 L1440 600 V1240 H0Z" fill="${c.far}"/>
    <path d="M220 420 L180 482 L220 470 L262 486Z M560 300 L500 392 L555 372 L612 380Z M940 380 L892 450 L940 434 L990 455Z M1300 460 L1262 518 L1300 505 L1338 520Z" fill="${c.cap}"/>
    <path d="M0 880 L260 640 L460 820 L700 600 L960 860 L1200 680 L1440 860 V1240 H0Z" fill="${c.near}"/>
    <path d="M0 1040 Q360 940 720 1010 T1440 980 V1240 H0Z" fill="${c.low}"/>`;
  } else if (kind === "waves") {
    const c = dark
      ? { s1: "#0e0f17", s2: "#1a1b28", w: ["#1f2131", "#1a1c2a", "#161724", "#11121c"] }
      : { s1: "#ecebf1", s2: "#f6f3ee", w: ["#e0dde8", "#d3cfdf", "#c5c0d4", "#b7b1c8"] };
    body =
      sky(c.s1, c.s2) +
      `
    <path d="M0 420 C240 360 420 520 720 460 S1200 360 1440 420 V1240 H0Z" fill="${c.w[0]}"/>
    <path d="M0 600 C300 520 520 700 820 620 S1260 540 1440 600 V1240 H0Z" fill="${c.w[1]}"/>
    <path d="M0 800 C280 720 560 880 880 800 S1280 740 1440 790 V1240 H0Z" fill="${c.w[2]}"/>
    <path d="M0 1000 C320 920 620 1080 960 1000 S1300 950 1440 990 V1240 H0Z" fill="${c.w[3]}"/>`;
  }
  return `<svg viewBox="0 0 1440 1240" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${body}</svg>`;
}
