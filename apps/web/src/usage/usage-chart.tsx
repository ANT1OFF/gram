import { useState } from "react";

import { cn } from "@/lib/utils";

import {
  compactTokens,
  dayLabel,
  FAMILY_COLOR,
  FAMILY_LABEL,
  niceCeiling,
  wholeTokens,
  type Family,
  type UsageDay,
} from "./usage-model";

const PLOT_HEIGHT = 176;
const STRIP_HEIGHT = 36;

/** The families' swatches and totals: identity never rests on colour alone. */
export function FamilyLegend({
  families,
  totals,
  className,
}: {
  families: readonly Family[];
  totals?: Readonly<Record<Family, number>>;
  className?: string;
}) {
  return (
    <ul
      aria-label="Models"
      className={cn("flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground", className)}
    >
      {families.map((family) => (
        <li key={family} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-2 rounded-[2px]"
            style={{ background: FAMILY_COLOR[family] }}
          />
          {FAMILY_LABEL[family]}
          {totals !== undefined && (
            <span className="tabular-nums">· {compactTokens(totals[family])}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Tokens by day, each column split by model family from the baseline up, and beneath it on the
 * same days the share of input read from cache. Hovering a day names its parts; the table under
 * "Daily values" holds every number.
 */
export function TokensChart({
  days,
  families,
}: {
  days: readonly UsageDay[];
  families: readonly Family[];
}) {
  const [hover, setHover] = useState<number>();
  const top = niceCeiling(Math.max(0, ...days.map((d) => d.total)));
  const gap = days.length > 45 ? 1 : days.length > 20 ? 3 : 6;
  const ticks = xTicks(days.length);
  const shown = hover === undefined ? undefined : days[hover];
  return (
    <div className="relative" data-testid="usage-chart">
      <div className="grid grid-cols-[2.75rem_minmax(0,1fr)] gap-x-2">
        <div
          aria-hidden
          className="flex -translate-y-1.5 flex-col justify-between text-right text-[11px] text-muted-foreground tabular-nums"
          style={{ height: PLOT_HEIGHT }}
        >
          <span>{compactTokens(top)}</span>
          <span>{compactTokens(top / 2)}</span>
          <span>0</span>
        </div>
        <div
          aria-hidden
          className="relative flex items-end border-b border-border-strong bg-[linear-gradient(var(--color-border),var(--color-border))_0_0/100%_1px_no-repeat,linear-gradient(var(--color-border),var(--color-border))_0_50%/100%_1px_no-repeat]"
          style={{ height: PLOT_HEIGHT, gap }}
          onMouseLeave={() => setHover(undefined)}
        >
          {days.map((day, i) => (
            <div
              key={day.day}
              data-testid="usage-chart-day"
              data-day={day.day}
              data-total={day.total}
              className="flex h-full min-w-0 flex-1 items-end justify-center"
              onMouseEnter={() => setHover(i)}
            >
              <div
                className={cn(
                  "flex w-full max-w-6 flex-col-reverse gap-[2px] overflow-hidden rounded-t-[3px]",
                  hover !== undefined && hover !== i && "opacity-60",
                )}
                style={{ height: `${(day.total / top) * 100}%` }}
              >
                {families.map((family) =>
                  day.families[family] > 0 ? (
                    <span
                      key={family}
                      className="block min-h-px"
                      style={{ flexGrow: day.families[family], background: FAMILY_COLOR[family] }}
                    />
                  ) : null,
                )}
              </div>
            </div>
          ))}
        </div>
        <div />
        <div
          aria-hidden
          className="relative mt-1.5 h-4 text-[11px] text-muted-foreground tabular-nums"
        >
          {ticks.map((i) => (
            <span
              key={i}
              className={cn(
                "absolute top-0 whitespace-nowrap",
                i === 0 ? "left-0" : i === days.length - 1 ? "right-0" : "-translate-x-1/2",
              )}
              style={
                i === 0 || i === days.length - 1
                  ? undefined
                  : { left: `${((i + 0.5) / days.length) * 100}%` }
              }
            >
              {dayLabel(days[i]!.day)}
            </span>
          ))}
        </div>
        <p className="col-span-2 mt-3 mb-1.5 text-xs text-muted-foreground">
          Cache read, share of input
        </p>
        <div
          aria-hidden
          className="flex -translate-y-1.5 flex-col justify-between text-right text-[11px] text-muted-foreground tabular-nums"
          style={{ height: STRIP_HEIGHT }}
        >
          <span>100%</span>
          <span>0</span>
        </div>
        <div
          aria-hidden
          data-testid="usage-cache-strip"
          className="flex items-end border-b border-border-strong bg-[linear-gradient(var(--color-border),var(--color-border))_0_0/100%_1px_no-repeat]"
          style={{ height: STRIP_HEIGHT, gap }}
          onMouseLeave={() => setHover(undefined)}
        >
          {days.map((day, i) => (
            <div
              key={day.day}
              className="flex h-full min-w-0 flex-1 items-end justify-center"
              onMouseEnter={() => setHover(i)}
            >
              <span
                className={cn(
                  "block w-full max-w-6 rounded-t-[2px] bg-muted-foreground/55",
                  hover !== undefined && hover !== i && "opacity-60",
                )}
                style={{ height: `${day.input === 0 ? 0 : (day.cacheRead / day.input) * 100}%` }}
              />
            </div>
          ))}
        </div>
      </div>
      {shown !== undefined && hover !== undefined && (
        <DayTip day={shown} families={families} at={(hover + 0.5) / days.length} />
      )}
    </div>
  );
}

/** About five dates under the axis: the first, the last, and evenly between. */
function xTicks(count: number): number[] {
  if (count <= 1) return count === 1 ? [0] : [];
  const step = Math.max(1, Math.round((count - 1) / 4));
  const ticks: number[] = [];
  for (let i = 0; i < count - step / 2; i += step) ticks.push(i);
  ticks.push(count - 1);
  return ticks;
}

function DayTip({
  day,
  families,
  at,
}: {
  day: UsageDay;
  families: readonly Family[];
  /** Across the plot, from 0 to 1. */
  at: number;
}) {
  return (
    <div
      role="status"
      data-testid="usage-chart-tip"
      className="pointer-events-none absolute top-0 z-10 w-48 rounded-md border border-border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-md"
      style={{
        left: `calc(2.75rem + 0.5rem + (100% - 3.25rem) * ${at})`,
        transform: at > 0.6 ? "translateX(calc(-100% - 12px))" : "translateX(12px)",
      }}
    >
      <p className="font-medium">{dayLabel(day.day, { weekday: true })}</p>
      <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 tabular-nums">
        {families.map((family) =>
          day.families[family] > 0 ? (
            <div key={family} className="contents">
              <dt className="flex items-center gap-1.5 text-muted-foreground">
                <span
                  aria-hidden
                  className="size-2 rounded-[2px]"
                  style={{ background: FAMILY_COLOR[family] }}
                />
                {FAMILY_LABEL[family]}
              </dt>
              <dd className="text-right">{compactTokens(day.families[family])}</dd>
            </div>
          ) : null,
        )}
        <dt className="text-muted-foreground">Total</dt>
        <dd className="text-right" title={wholeTokens(day.total)}>
          {compactTokens(day.total)}
        </dd>
        <dt className="text-muted-foreground">Cache read</dt>
        <dd className="text-right">
          {day.input === 0 ? "–" : `${Math.round((day.cacheRead / day.input) * 100)}%`}
        </dd>
      </dl>
    </div>
  );
}

/** Every day's numbers: the chart's table view. */
export function DailyTable({
  days,
  families,
}: {
  days: readonly UsageDay[];
  families: readonly Family[];
}) {
  return (
    <details className="mt-3 text-xs">
      <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
        Daily values (UTC)
      </summary>
      <div className="mt-3 max-h-72 overflow-auto">
        <table className="w-full text-left tabular-nums" data-testid="usage-daily-table">
          <caption className="sr-only">
            Daily token activity, including days with no counted tokens
          </caption>
          <thead className="sticky top-0 bg-background">
            <tr className="text-muted-foreground">
              <th scope="col" className="py-1.5 pr-3 font-medium">
                Date (UTC)
              </th>
              {families.map((family) => (
                <th key={family} scope="col" className="px-3 py-1.5 text-right font-medium">
                  {FAMILY_LABEL[family]}
                </th>
              ))}
              <th scope="col" className="px-3 py-1.5 text-right font-medium">
                Cache read
              </th>
              <th scope="col" className="py-1.5 pl-3 text-right font-medium">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.day} className="border-t border-border">
                <th scope="row" className="py-1 pr-3 font-normal">
                  {day.day}
                </th>
                {families.map((family) => (
                  <td key={family} className="px-3 text-right">
                    {wholeTokens(day.families[family])}
                  </td>
                ))}
                <td className="px-3 text-right">
                  {day.input === 0 ? "–" : `${Math.round((day.cacheRead / day.input) * 100)}%`}
                </td>
                <td className="pl-3 text-right">{wholeTokens(day.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
