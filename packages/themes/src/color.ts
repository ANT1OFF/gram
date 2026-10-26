/** An OKLCH colour: lightness 0..1, chroma ≥ 0, hue in degrees. */
export interface Oklch {
  l: number;
  c: number;
  h: number;
}

type Triple = readonly [number, number, number];

const map3 = (v: Triple, f: (x: number, i: number) => number): Triple => [
  f(v[0], 0),
  f(v[1], 1),
  f(v[2], 2),
];

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Normalises `#rgb` / `#rrggbb` to lowercase `#rrggbb`; throws on anything else. */
export function normalizeHex(hex: string): string {
  const value = hex.trim();
  if (!HEX_RE.test(value)) throw new Error(`Not a hex colour: ${hex}`);
  const body = value.slice(1).toLowerCase();
  return body.length === 3 ? `#${[...body].map((ch) => ch + ch).join("")}` : `#${body}`;
}

function hexToRgb(hex: string): Triple {
  const body = normalizeHex(hex).slice(1);
  return map3([0, 2, 4], (i) => Number.parseInt(body.slice(i, i + 2), 16) / 255);
}

const byte = (v: number) =>
  Math.round(Math.min(1, Math.max(0, v)) * 255)
    .toString(16)
    .padStart(2, "0");

function rgbToHex(rgb: Triple): string {
  return `#${byte(rgb[0])}${byte(rgb[1])}${byte(rgb[2])}`;
}

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const fromLinear = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

function linearRgbToOklab([r, g, b]: Triple): Triple {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToLinearRgb([L, a, b]: Triple): Triple {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const hexToOklab = (hex: string) => linearRgbToOklab(map3(hexToRgb(hex), toLinear));
const linearRgbToHex = (rgb: Triple) =>
  rgbToHex(map3(rgb, (v) => fromLinear(Math.min(1, Math.max(0, v)))));

export function hexToOklch(hex: string): Oklch {
  const [l, a, b] = hexToOklab(hex);
  const c = Math.hypot(a, b);
  const h = c < 1e-6 ? 0 : (Math.atan2(b, a) * 180) / Math.PI;
  return { l, c, h: h < 0 ? h + 360 : h };
}

function oklchToLinearRgb({ l, c, h }: Oklch): Triple {
  const rad = (h * Math.PI) / 180;
  return oklabToLinearRgb([l, c * Math.cos(rad), c * Math.sin(rad)]);
}

const inGamut = (rgb: Triple) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** Converts to sRGB hex, reducing chroma (keeping lightness and hue) until the colour fits. */
export function oklchToHex(color: Oklch): string {
  const l = Math.min(1, Math.max(0, color.l));
  let rgb = oklchToLinearRgb({ ...color, l });
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = color.c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinearRgb({ l, c: mid, h: color.h }))) lo = mid;
      else hi = mid;
    }
    rgb = oklchToLinearRgb({ l, c: lo, h: color.h });
  }
  return linearRgbToHex(rgb);
}

/** Shifts OKLCH lightness by `delta`, keeping hue. */
export const shiftLightness = (hex: string, delta: number) => {
  const color = hexToOklch(hex);
  return oklchToHex({ ...color, l: color.l + delta });
};

/** Mixes two colours in OKLab; `amount` is the share of `b` (0..1). */
export function mix(a: string, b: string, amount: number): string {
  const la = hexToOklab(a);
  const lb = hexToOklab(b);
  return linearRgbToHex(oklabToLinearRgb(map3(la, (v, i) => v + (lb[i]! - v) * amount)));
}

/** Alpha-composites `fg` at `alpha` over an opaque `backdrop` in gamma-encoded sRGB, as browsers do. */
export function composite(fg: string, alpha: number, backdrop: string): string {
  const bottom = hexToRgb(backdrop);
  return rgbToHex(map3(hexToRgb(fg), (v, i) => v * alpha + bottom[i]! * (1 - alpha)));
}

/** WCAG 2.x relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = map3(hexToRgb(hex), toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** APCA's black-clamped screen luminance (Y) of `hex`. */
function apcaY(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  const raw = 0.2126729 * r ** 2.4 + 0.7151522 * g ** 2.4 + 0.072175 * b ** 2.4;
  // APCA's black-clamp exponent, not √2.
  // oxlint-disable-next-line oxc/approx-constant
  return raw < 0.022 ? raw + (0.022 - raw) ** 1.414 : raw;
}

/** APCA-W3 0.0.98G lightness contrast (Lc) of `text` on `background`; negative for light-on-dark. */
export function apcaContrast(text: string, background: string): number {
  const yt = apcaY(text);
  const yb = apcaY(background);
  if (Math.abs(yb - yt) < 0.0005) return 0;
  if (yb > yt) {
    const sapc = (yb ** 0.56 - yt ** 0.57) * 1.14;
    return sapc < 0.1 ? 0 : (sapc - 0.027) * 100;
  }
  const sapc = (yb ** 0.65 - yt ** 0.62) * 1.14;
  return sapc > -0.1 ? 0 : (sapc + 0.027) * 100;
}

export const minContrast = (color: string, backgrounds: readonly string[]) =>
  Math.min(...backgrounds.map((bg) => contrastRatio(color, bg)));

/**
 * Returns `color` with its OKLCH lightness pushed toward white (`lighter`) or black until it reaches
 * `target` against every background, keeping hue and as much chroma as the gamut allows. A colour
 * that already passes comes back unchanged; if nothing on the way passes, the extreme is returned.
 */
export function ensureContrast(
  color: string,
  backgrounds: readonly string[],
  target: number,
  direction: "lighter" | "darker",
): string {
  const hex = normalizeHex(color);
  if (minContrast(hex, backgrounds) >= target) return hex;
  const start = hexToOklch(hex);
  let lo = start.l;
  let hi = direction === "lighter" ? 1 : 0;
  let best = direction === "lighter" ? "#ffffff" : "#000000";
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    const candidate = oklchToHex({ ...start, l: mid });
    if (minContrast(candidate, backgrounds) >= target) {
      best = candidate;
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return best;
}
