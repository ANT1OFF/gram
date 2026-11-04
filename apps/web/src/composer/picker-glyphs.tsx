import type { ReasoningVariant, SpeedMode } from "@gram/contracts";
import { Zap } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * How far round the gauge each effort sits, 0 to 1. Unset (the model's own default) has no level of
 * its own and shows the plain gauge, needle up.
 */
export const EFFORT_LEVEL: Readonly<Record<ReasoningVariant, number>> = {
  none: 0,
  low: 0.2,
  medium: 0.45,
  high: 0.7,
  xhigh: 0.85,
  max: 1,
};

// The dial: lucide's Gauge geometry, a 240° arc of radius 10 round (12, 14), open at the bottom.
const CX = 12;
const CY = 14;
const R = 10;
const NEEDLE = 6;
const SWEEP = 240;

/** The point `radius` out from the centre at `degrees` clockwise from straight up. */
const point = (degrees: number, radius: number) => {
  const radians = (degrees * Math.PI) / 180;
  return [CX + radius * Math.sin(radians), CY - radius * Math.cos(radians)] as const;
};

const fmt = (n: number) => Number(n.toFixed(2));

/** The arc from the dial's start round to `degrees`, as a path. */
const arcTo = (degrees: number) => {
  const [x0, y0] = point(-SWEEP / 2, R);
  const [x1, y1] = point(degrees, R);
  const large = degrees + SWEEP / 2 > 180 ? 1 : 0;
  return `M${fmt(x0)} ${fmt(y0)}A${R} ${R} 0 ${large} 1 ${fmt(x1)} ${fmt(y1)}`;
};

/**
 * The effort picker's glyph: a gauge whose needle and filled arc stand at the chosen effort, so the
 * icon alone tells Low from Max. Without an effort it is the plain gauge, needle straight up.
 */
export function EffortGauge({
  variant,
  className,
}: {
  variant: ReasoningVariant | undefined;
  className?: string;
}) {
  const level = variant === undefined ? undefined : EFFORT_LEVEL[variant];
  const angle = level === undefined ? 0 : -SWEEP / 2 + SWEEP * level;
  const [nx, ny] = point(angle, NEEDLE);
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      data-testid="effort-gauge"
      data-level={variant ?? "default"}
      // `lucide` takes the theme's icon stroke, as every other toolbar glyph does.
      className={cn("lucide size-3.5", className)}
    >
      {/* The track: the whole dial, faint once a level fills part of it. */}
      <path d={arcTo(SWEEP / 2)} opacity={level === undefined ? 1 : 0.35} />
      {level !== undefined && level > 0 && <path d={arcTo(angle)} />}
      <path d={`M${CX} ${CY}L${fmt(nx)} ${fmt(ny)}`} />
    </svg>
  );
}

/** The speed picker's glyph: the bolt, filled while Fast is chosen. */
export function SpeedGlyph({
  speed,
  className,
}: {
  speed: SpeedMode | undefined;
  className?: string;
}) {
  return (
    <Zap
      aria-hidden
      data-testid="speed-glyph"
      data-speed={speed ?? "default"}
      className={cn("size-3.5", speed === "fast" && "fill-current", className)}
    />
  );
}
