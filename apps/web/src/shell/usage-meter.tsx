import { limitForecast } from "@gram/contracts";
import { Fragment, useEffect, useState } from "react";

import { agentLabel } from "@/agents/agent-label";
import { agoText } from "@/lib/time";
import { cn } from "@/lib/utils";
import { PulseOnce } from "@/motion";
import {
  currentLimit,
  LIMIT_PROVIDERS,
  LIMIT_WINDOWS,
  limitStale,
  limitWarns,
  nextLimitChange,
  tightestLimit,
  useUsageLimits,
  type LimitProvider,
  type UsageLimit,
  type UsageLimits,
} from "@/stores/usage-limits";
import {
  CREDITS_TEXT,
  forecastText,
  limitPercent,
  meterLabel,
  meterText,
  resetText,
  WINDOW_LABEL,
} from "@/usage/limit-format";

import { TitlebarPopover } from "./titlebar-popover";

/**
 * `Date.now()` as of the last render that needed it, moved on when the soonest reading expires, so
 * one that ran out leaves the meter, or turns stale, so the meter dims.
 */
export function useLimitsNow(limits: UsageLimits): number {
  const [now, setNow] = useState(Date.now);
  const at = nextLimitChange(limits, now);
  useEffect(() => {
    if (at === undefined) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, at - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [at]);
  return now;
}

/** `Date.now()`, moved on every minute while mounted: the popover's ages and forecasts. */
export function useMinuteNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * The title bar's subscription meter: the limit closest to running out, as a thin bar and a share,
 * opening onto every provider's 5-hour and weekly windows. Nothing until an agent reports a limit.
 */
export function UsageMeter({
  className,
  textClassName,
}: {
  className?: string;
  /** For the reading beside the bar, which a narrow title bar can leave to the label and popover. */
  textClassName?: string;
}) {
  const limits = useUsageLimits((s) => s.limits);
  const now = useLimitsNow(limits);
  const tightest = tightestLimit(limits, now);
  if (tightest === undefined) return null;
  const warns = limitWarns(tightest.limit);
  const stale = limitStale(tightest.limit, now);

  return (
    <PulseOnce trigger={warns} when={warns} tone="needs" className={cn("rounded-full", className)}>
      <TitlebarPopover
        label="Subscription usage"
        testId="usage-limits"
        className="w-72 p-2.5"
        trigger={
          <button
            type="button"
            data-testid="usage-meter"
            data-warn={warns || undefined}
            data-stale={stale || undefined}
            aria-label={meterLabel(tightest)}
            title="Subscription usage"
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-(--radius-sm) px-1.5 text-xs text-muted-foreground tabular-nums outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-muted",
              warns && "text-warning hover:text-warning",
              stale && "opacity-70",
            )}
          >
            <LimitBar limit={tightest.limit} className="w-9" />
            <span className={textClassName}>{meterText(tightest)}</span>
          </button>
        }
      >
        <LimitsPopover />
      </TitlebarPopover>
    </PulseOnce>
  );
}

/** The popover's body, ticking each minute while open so ages and forecasts stay true. */
function LimitsPopover() {
  const now = useMinuteNow();
  return (
    <div className="grid gap-1.5 text-[13px]">
      {LIMIT_PROVIDERS.map((provider) => (
        <ProviderLimits key={provider} provider={provider} now={now} />
      ))}
      <p className="mt-1 text-xs text-muted-foreground">Includes your own use outside Gram.</p>
    </div>
  );
}

/**
 * A provider's 5-hour and weekly rows, its readings' age once no agent has repeated them for a
 * while, and under a row the forecast when there is pace enough to make one; nothing for a
 * provider with no current reading.
 */
function ProviderLimits({ provider, now }: { provider: LimitProvider; now: number }) {
  const windows = useUsageLimits((s) => s.limits[provider]);
  const current = LIMIT_WINDOWS.flatMap((window) => {
    const limit = currentLimit(windows?.[window], now);
    return limit === undefined ? [] : [limit];
  });
  if (current.length === 0) return null;
  const newest = Math.max(...current.map((limit) => limit.at ?? now));
  const stale = current.every((limit) => limitStale(limit, now));
  return (
    <section aria-label={agentLabel(provider)} data-provider={provider} className="contents">
      <div className="mt-1 flex items-baseline justify-between gap-2 first:mt-0">
        <h3 className="font-medium">{agentLabel(provider)}</h3>
        {stale && (
          <span data-testid="usage-limit-age" className="text-xs text-muted-foreground">
            {agoText(newest, now)}
          </span>
        )}
      </div>
      {LIMIT_WINDOWS.map((window) => {
        const limit = currentLimit(windows?.[window], now);
        const forecast =
          limit?.at === undefined || limit.samples === undefined
            ? undefined
            : limitForecast({ ...limit, at: limit.at, samples: limit.samples }, now);
        return (
          <Fragment key={window}>
            <div
              data-testid="usage-limit-row"
              data-window={window}
              className={cn(
                "grid grid-cols-[3.75rem_1fr_2.25rem_4.75rem] items-center gap-2 text-muted-foreground tabular-nums",
                limit !== undefined && limitWarns(limit) && "text-warning",
              )}
            >
              <span>{WINDOW_LABEL[window]}</span>
              {limit === undefined ? (
                <>
                  <span className="h-1 rounded-full bg-foreground/15" />
                  <span className="text-right">–</span>
                  <span />
                </>
              ) : (
                <>
                  <LimitBar limit={limit} />
                  <span className="text-right">{limitPercent(limit.utilization)}%</span>
                  <span className="text-right text-xs">
                    {limit.resetsAt === undefined ? "" : resetText(limit.resetsAt, now)}
                  </span>
                </>
              )}
            </div>
            {limit?.credits === true && (
              <p data-testid="usage-limit-credits" className="-mt-1 text-xs text-muted-foreground">
                {CREDITS_TEXT}
              </p>
            )}
            {forecast !== undefined && (
              <p data-testid="usage-limit-forecast" className="-mt-1 text-xs text-muted-foreground">
                {forecastText(forecast)}
              </p>
            )}
          </Fragment>
        );
      })}
    </section>
  );
}

/** A thin track whose fill glides to each new reading; warning-coloured from 80%. */
export function LimitBar({ limit, className }: { limit: UsageLimit; className?: string }) {
  const percent = limitPercent(limit.utilization);
  return (
    <span
      aria-hidden
      className={cn("block h-1 shrink-0 overflow-hidden rounded-full bg-foreground/15", className)}
    >
      <span
        data-testid="usage-meter-fill"
        className={cn(
          "block h-full rounded-full transition-[width] duration-(--dur-move-base) ease-(--ease-spring)",
          limitWarns(limit) ? "bg-warning" : "bg-muted-foreground",
        )}
        style={{ width: `${percent}%` }}
      />
    </span>
  );
}
