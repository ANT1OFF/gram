/** Glass is the only look; the type stays so a look remains one value the theme is keyed by. */
export type LookId = "glass";
export type Density = "compact" | "comfortable";

export type Easing =
  | { type: "bezier"; points: readonly [number, number, number, number] }
  | {
      type: "steps";
      count: number;
      position: "start" | "end" | "jump-none" | "jump-both";
    };

/** Durations in milliseconds throughout. */
export type MotionPreset =
  | { type: "spring"; stiffness: number; damping: number; mass: number }
  | { type: "tween"; duration: number; easing: Easing };

export interface MotionPersonality {
  durations: { fast: number; base: number; slow: number };
  easing: { out: Easing; inOut: Easing };
  /** `snappy` for presses and toggles, `gentle` for layout moves, `bouncy` for arrivals. */
  springs: { snappy: MotionPreset; gentle: MotionPreset; bouncy: MotionPreset };
  /** How streamed text appears. */
  reveal: "fade" | "typewriter" | "crossfade";
  caretBlink: boolean;
  staggerMs: number;
}

export interface Look {
  id: LookId;
  name: string;
  description: string;
  /** CSS font-family stacks. `display` and `label` are never used for body text. */
  fonts: { ui: string; display: string; mono: string; label: string };
  /** Pixels. `composer` is the message box's slab, rounder than a card so it reads as one object. */
  radii: { xs: number; sm: number; md: number; lg: number; xl: number; composer: number };
  density: { default: Density; rowHeight: Record<Density, number> };
  surfaces: {
    /** Cards separate by hairline border, soft shadow, or horizontal rules. */
    treatment: "border" | "shadow" | "rule";
    hairline: number;
    hairlineHiDpi: number;
    /** Opacity of chrome surfaces (sidebar, panels); ≥ MIN_SURFACE_ALPHA. */
    alpha: number;
    blur: number;
    shadowRaised: string;
    shadowOverlay: string;
    /** Accent mixed into the page backdrop behind translucent chrome, 0–1 (Glass). */
    wash: number;
    /**
     * Scanline strength, 0–1 (Terminal): alternate rows mix toward black in dark mode and white in
     * light mode, away from the text, so they can only raise contrast.
     */
    scanline: number;
  };
  iconStroke: number;
  motion: MotionPersonality;
}

const bezier = (a: number, b: number, c: number, d: number): Easing => ({
  type: "bezier",
  points: [a, b, c, d],
});

const glass: Look = {
  id: "glass",
  name: "Glass",
  description: "Inter, soft radii, translucent chrome with layered shadows, springy.",
  fonts: {
    ui: '"Inter Variable", ui-sans-serif, system-ui, sans-serif',
    display: '"Inter Variable", ui-sans-serif, system-ui, sans-serif',
    mono: '"JetBrains Mono Variable", ui-monospace, "SF Mono", Menlo, monospace',
    label: '"Inter Variable", ui-sans-serif, system-ui, sans-serif',
  },
  radii: { xs: 8, sm: 12, md: 14, lg: 16, xl: 16, composer: 22 },
  density: {
    default: "comfortable",
    rowHeight: { compact: 30, comfortable: 36 },
  },
  surfaces: {
    treatment: "shadow",
    hairline: 1,
    hairlineHiDpi: 1,
    alpha: 0.88,
    blur: 24,
    shadowRaised: "0 1px 2px rgb(0 0 0 / 0.12), 0 4px 12px -2px rgb(0 0 0 / 0.16)",
    shadowOverlay: "0 2px 6px rgb(0 0 0 / 0.14), 0 16px 40px -8px rgb(0 0 0 / 0.3)",
    wash: 0.14,
    scanline: 0,
  },
  iconStroke: 1.75,
  motion: {
    durations: { fast: 220, base: 260, slow: 320 },
    easing: {
      out: bezier(0.34, 1.36, 0.64, 1),
      inOut: bezier(0.45, 0, 0.2, 1),
    },
    springs: {
      snappy: { type: "spring", stiffness: 420, damping: 28, mass: 1 },
      gentle: { type: "spring", stiffness: 260, damping: 24, mass: 1 },
      bouncy: { type: "spring", stiffness: 300, damping: 18, mass: 1 },
    },
    reveal: "fade",
    caretBlink: false,
    staggerMs: 30,
  },
};

export const LOOKS: Record<LookId, Look> = { glass };
export const LOOK_IDS = ["glass"] as const satisfies readonly LookId[];
export const DEFAULT_LOOK_ID: LookId = "glass";

/** A look whose chrome is translucent and wants native window vibrancy behind it. */
export const isTranslucentLook = (id: LookId): boolean => LOOKS[id].surfaces.blur > 0;
