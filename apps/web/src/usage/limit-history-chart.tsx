import { useState, type PointerEvent, type ReactNode } from "react";

import { formatDay, formatStamp } from "@/lib/time";
import { cn } from "@/lib/utils";

import { dayTicks, fittingTicks, historyRuns, nearestPoint } from "./limit-history-model";

const W = 600;
const H = 96;

export interface ChartPoint {
  readonly at: number;
  readonly value: number;
  /** Lines under the value in its hover: the reading's age, its window's reset, its peak. */
  readonly notes?: readonly string[];
}

/**
 * One series over a period, drawn once and never animated: a 2px line in the series' colour over
 * a faint fill, broken wherever nobody read it, under recessive 0, half and top gridlines and an
 * optional guide (the 90% warning mark). `ChartLegend` names each of these once for the page.
 * Hovering shows a crosshair and the reading nearest it: when, the value, and the point's notes.
 */
export function HistoryChart({
  points,
  from,
  to,
  step,
  top,
  colour,
  label,
  formatValue,
  guide,
  gap,
  testId,
  area = true,
}: {
  points: readonly ChartPoint[];
  from: number;
  to: number;
  /** The points' bucket width, for how near the hover snaps. */
  step: number;
  /** The value at the top of the plot. */
  top: number;
  colour: string;
  /** What the chart is of, for a screen reader. */
  label: string;
  formatValue: (value: number) => string;
  /** A value marked with a dashed warning line. */
  guide?: number;
  /** The longest silence the line bridges. */
  gap: number;
  testId?: string;
  /** A faint fill under the line; off for a level, such as a balance, rather than a share. */
  area?: boolean;
}) {
  const [hover, setHover] = useState<ChartPoint>();
  const span = Math.max(1, to - from);
  const x = (at: number) => ((at - from) / span) * W;
  const y = (value: number) => H - (Math.min(top, Math.max(0, value)) / top) * H;
  const runs = historyRuns(points, gap);
  const line = runs
    .map((run) =>
      run.length === 1
        ? // A lone reading: a short stroke, so it shows as a dot whatever the chart's width.
          `M${x(run[0]!.at).toFixed(1)},${y(run[0]!.value).toFixed(1)}h0.01`
        : run
            .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.at).toFixed(1)},${y(p.value).toFixed(1)}`)
            .join(""),
    )
    .join("");
  const fill = runs
    .filter((run) => run.length > 1)
    .map(
      (run) =>
        `M${x(run[0]!.at).toFixed(1)},${H}` +
        run.map((p) => `L${x(p.at).toFixed(1)},${y(p.value).toFixed(1)}`).join("") +
        `L${x(run.at(-1)!.at).toFixed(1)},${H}Z`,
    )
    .join("");
  const days = (to - from) / 86_400_000;
  const ticks = fittingTicks(dayTicks(from, to, days > 10 ? 7 : 1), (at) => x(at) / W);
  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const at = from + ((event.clientX - rect.left) / Math.max(1, rect.width)) * span;
    setHover(nearestPoint(points, at, Math.max(step * 2, span / 120)));
  };
  return (
    <div className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-2" data-testid={testId}>
      <div
        aria-hidden
        className="flex -translate-y-1.5 flex-col justify-between text-right text-caption text-muted-foreground tabular-nums"
        style={{ height: H }}
      >
        <span>{formatValue(top)}</span>
        <span>{formatValue(top / 2)}</span>
        <span>0</span>
      </div>
      <div
        className="relative"
        style={{ height: H }}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(undefined)}
      >
        <svg
          role="img"
          aria-label={label}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="absolute inset-0 size-full overflow-visible"
        >
          <title>{label}</title>
          {[0, 0.5].map((share) => (
            <line
              key={share}
              x1={0}
              x2={W}
              y1={y(top * (1 - share)) + (share === 0 ? 0.5 : 0)}
              y2={y(top * (1 - share)) + (share === 0 ? 0.5 : 0)}
              className="stroke-border"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <line
            x1={0}
            x2={W}
            y1={H}
            y2={H}
            className="stroke-border-strong"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
          {guide !== undefined && (
            <line
              data-testid="usage-history-guide"
              x1={0}
              x2={W}
              y1={y(guide)}
              y2={y(guide)}
              className="stroke-warning/50"
              strokeWidth={1}
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {area && <path d={fill} fill={colour} fillOpacity={0.1} />}
          <path
            data-testid="usage-history-line"
            d={line}
            fill="none"
            stroke={colour}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {hover !== undefined && (
          <>
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 w-px bg-foreground/30"
              style={{ left: `${(x(hover.at) / W) * 100}%` }}
            />
            <span
              aria-hidden
              className="pointer-events-none absolute size-2 -translate-1/2 rounded-full ring-2 ring-card"
              style={{
                left: `${(x(hover.at) / W) * 100}%`,
                top: `${(y(hover.value) / H) * 100}%`,
                background: colour,
              }}
            />
            <span
              role="status"
              data-testid="usage-history-hover"
              className={cn(
                "pointer-events-none absolute -top-1 z-10 flex -translate-y-full flex-col rounded-sm border border-border bg-popover px-2 py-1 text-meta whitespace-nowrap text-popover-foreground shadow-raised tabular-nums",
                x(hover.at) > W / 2 ? "-translate-x-full" : "",
              )}
              style={{ left: `${(x(hover.at) / W) * 100}%` }}
            >
              <span>
                <span className="text-muted-foreground">{formatStamp(hover.at, to)}</span>{" "}
                <span className="font-medium">{formatValue(hover.value)}</span>
              </span>
              {hover.notes?.map((note) => (
                <span key={note} data-testid="usage-history-note" className="text-muted-foreground">
                  {note}
                </span>
              ))}
            </span>
          </>
        )}
      </div>
      <div />
      <div
        aria-hidden
        className="relative mt-1.5 h-4 text-caption text-muted-foreground tabular-nums"
      >
        {ticks.map((at) => {
          const left = (x(at) / W) * 100;
          return (
            <span
              key={at}
              className={cn(
                "absolute top-0 whitespace-nowrap",
                left > 96 ? "-translate-x-full" : left > 3 && "-translate-x-1/2",
              )}
              style={{ left: `${left}%` }}
            >
              {formatDay(at, to)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** A legend swatch's box: as tall as a line of meta text, the width of a short stroke. */
const SWATCH = "h-3 w-5 shrink-0 overflow-visible";

/**
 * What the history charts draw, named once above them: the line is the share used, sampled once
 * a `step`; a break in it is a stretch nobody read; a fall to the floor is a window resetting; the
 * dashed line is the 90% warning; and the mark on each card's bar is where an even pace would be
 * now. Swatches in the muted colour, the warning's in its own, so they read as keys, not data.
 * One compact line of short keys; each one's hover and screen-reader text says it in full.
 */
export function ChartLegend({ step, className }: { step: string; className?: string }) {
  const items: readonly { key: string; swatch: ReactNode; text: string; detail: string }[] = [
    {
      key: "line",
      swatch: (
        <svg aria-hidden viewBox="0 0 20 12" className={SWATCH}>
          <path
            d="M1,9 L7,6 L13,4 L19,2"
            className="fill-none stroke-muted-foreground"
            strokeWidth={2}
            strokeLinecap="round"
          />
        </svg>
      ),
      text: `Share used, per ${step}`,
      detail: `Share used, the last reading each ${step}`,
    },
    {
      key: "gap",
      swatch: (
        <svg aria-hidden viewBox="0 0 20 12" className={SWATCH}>
          <path
            d="M1,8 L6,6 M14,4 L19,2"
            className="fill-none stroke-muted-foreground"
            strokeWidth={2}
            strokeLinecap="round"
          />
        </svg>
      ),
      text: "Break: no reading",
      detail: "Break: no reading (Gram closed, or the agent quiet)",
    },
    {
      key: "reset",
      swatch: (
        <svg aria-hidden viewBox="0 0 20 12" className={SWATCH}>
          <path
            d="M1,6 L10,2 L10,11 L19,9"
            className="fill-none stroke-muted-foreground"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
      text: "Drop: reset",
      detail: "Drop to the floor: the window reset",
    },
    {
      key: "guide",
      swatch: (
        <svg aria-hidden viewBox="0 0 20 12" className={SWATCH}>
          <line
            x1={0}
            x2={20}
            y1={6}
            y2={6}
            className="stroke-warning"
            strokeWidth={1.5}
            strokeDasharray="3 3"
          />
        </svg>
      ),
      text: "90%: warns",
      detail: "90%: where the meter warns",
    },
    {
      key: "pace",
      swatch: (
        <svg aria-hidden viewBox="0 0 20 12" className={SWATCH}>
          <rect x={0} y={5} width={20} height={2} rx={1} className="fill-foreground/15" />
          <rect x={9} y={2} width={2} height={8} rx={1} className="fill-foreground/60" />
        </svg>
      ),
      text: "Mark: even pace",
      detail: "Mark on a bar: an even pace through the window",
    },
  ];
  return (
    <ul
      aria-label="How to read the charts"
      data-testid="usage-history-legend"
      className={cn("flex flex-wrap gap-x-3 gap-y-1 text-meta text-muted-foreground", className)}
    >
      {items.map((item) => (
        <li
          key={item.key}
          data-legend={item.key}
          title={item.detail}
          className="flex items-center gap-1 whitespace-nowrap"
        >
          {item.swatch}
          <span aria-hidden>{item.text}</span>
          <span className="sr-only">{item.detail}</span>
        </li>
      ))}
    </ul>
  );
}
