import { limitForecast, type UsageLimitObservation, type UsageProvider } from "@gram/contracts";

import { agentLabel } from "@/agents/agent-label";
import { agoText } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useLimitsNow, useMinuteNow } from "@/shell/usage-meter";
import {
  currentLimit,
  LIMIT_PROVIDERS,
  LIMIT_WINDOWS,
  limitStale,
  limitWarns,
  useUsageLimits,
  type LimitProvider,
  type LimitWindow,
  type UsageLimit,
} from "@/stores/usage-limits";
import {
  forecastText,
  CREDITS_TEXT,
  limitPercent,
  PROVIDER_SHORT,
  resetText,
  WINDOW_LABEL,
  windowWord,
} from "@/usage/limit-format";

import { limitHistory, PROVIDER_COLOR } from "./usage-model";

const HISTORY_WINDOW = { fiveHour: "five_hour", weekly: "seven_day" } as const;
const HISTORY_SPAN: Readonly<Record<LimitWindow, number>> = {
  fiveHour: 24 * 3_600_000,
  weekly: 7 * 24 * 3_600_000,
};
const HISTORY_SPAN_LABEL: Readonly<Record<LimitWindow, string>> = {
  fiveHour: "last 24 hours",
  weekly: "last 7 days",
};

/**
 * The page's first section: one card per subscription window an agent has reported, with its share
 * used, when it resets and, with pace enough, where it gets to first. A provider shows once it has
 * any reading; with none at all, one line says where they come from.
 */
export function UsageLimitsSection({
  provider,
  history,
}: {
  /** The page's provider filter. */
  provider: UsageProvider | undefined;
  /** Local limit snapshots from the overview, drawn under their window's card. */
  history: readonly UsageLimitObservation[] | undefined;
}) {
  const limits = useUsageLimits((s) => s.limits);
  const changeNow = useLimitsNow(limits);
  const minuteNow = useMinuteNow();
  const now = Math.max(changeNow, minuteNow);
  const providers = LIMIT_PROVIDERS.filter(
    (p) =>
      (provider === undefined || p === provider) &&
      LIMIT_WINDOWS.some((w) => currentLimit(limits[p]?.[w], now) !== undefined),
  );
  return (
    <section aria-labelledby="usage-limits-title" data-testid="usage-limits-section">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h2 id="usage-limits-title" className="text-sm font-semibold">
          Limits
        </h2>
        <p className="text-xs text-muted-foreground">
          As your agents last reported them · includes use outside Gram
        </p>
      </div>
      {providers.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="usage-limits-none">
          {provider === undefined
            ? "Limits appear here once Claude Code or Codex reports one."
            : `Limits appear here once ${agentLabel(provider)} reports one.`}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 @lg:grid-cols-2 @5xl:grid-cols-4">
          {providers.flatMap((p) =>
            LIMIT_WINDOWS.map((w) => (
              <LimitCard
                key={`${p}-${w}`}
                provider={p}
                window={w}
                limit={currentLimit(limits[p]?.[w], now)}
                now={now}
                history={limitHistory(history, p, HISTORY_WINDOW[w], now, HISTORY_SPAN[w])}
              />
            )),
          )}
        </div>
      )}
    </section>
  );
}

function LimitCard({
  provider,
  window,
  limit,
  now,
  history,
}: {
  provider: LimitProvider;
  window: LimitWindow;
  limit: UsageLimit | undefined;
  now: number;
  history: readonly UsageLimitObservation[];
}) {
  const name = `${agentLabel(provider)} ${windowWord(window)} limit`;
  if (limit === undefined)
    return (
      <div
        role="group"
        aria-label={name}
        data-testid="usage-limit-card"
        data-provider={provider}
        data-window={window}
        className="flex min-h-28 flex-col rounded-lg border border-border bg-card px-4 py-3.5 text-muted-foreground"
      >
        <CardTitle provider={provider} window={window} />
        <p className="mt-auto text-xs">No reading yet</p>
      </div>
    );
  const percent = limitPercent(limit.utilization);
  const warns = limitWarns(limit);
  const forecast =
    limit.at === undefined || limit.samples === undefined
      ? undefined
      : limitForecast({ ...limit, at: limit.at, samples: limit.samples }, now);
  const reach = forecast === undefined ? percent : Math.round(forecast.target * 100);
  // The provider's colour, unless the window is near its limit: then the warning colour says so.
  const colour = warns ? "var(--warning)" : PROVIDER_COLOR[provider];
  return (
    <div
      role="group"
      aria-label={name}
      data-testid="usage-limit-card"
      data-provider={provider}
      data-window={window}
      data-warn={warns || undefined}
      className="flex min-h-28 flex-col rounded-lg border border-border bg-card px-4 py-3.5"
    >
      <div className="flex items-baseline gap-2">
        <CardTitle provider={provider} window={window} />
        <p
          data-testid="usage-limit-percent"
          className={cn("ml-auto text-2xl leading-none font-medium", warns && "text-warning")}
        >
          {percent}
          <span className="ml-px text-sm font-normal text-muted-foreground">%</span>
        </p>
      </div>
      <div
        role="meter"
        aria-label={`${name} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="relative mt-3 mb-2 h-1.5 overflow-hidden rounded-full bg-foreground/12"
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${percent}%`, background: colour }}
        />
        {reach > percent && (
          // Where the pace gets to before the reset: hatched, so it never reads as used.
          <span
            data-testid="usage-limit-reach"
            className="absolute inset-y-0 bg-[repeating-linear-gradient(135deg,currentColor_0_2px,transparent_2px_5px)] opacity-60"
            style={{ left: `${percent}%`, width: `${reach - percent}%`, color: colour }}
          />
        )}
      </div>
      <div className="flex justify-between gap-2 text-xs text-muted-foreground tabular-nums">
        <span data-testid="usage-limit-reset">
          {limit.resetsAt === undefined ? "" : `Resets ${resetText(limit.resetsAt, now)}`}
        </span>
        {limitStale(limit, now) && limit.at !== undefined && (
          <span data-testid="usage-limit-age">Read {agoText(limit.at, now)}</span>
        )}
      </div>
      {limit.credits === true && (
        <p data-testid="usage-limit-credits" className="mt-0.5 text-xs text-muted-foreground">
          {CREDITS_TEXT}
        </p>
      )}
      {forecast !== undefined && (
        <p
          data-testid="usage-limit-forecast"
          className={cn("mt-0.5 text-xs", warns ? "text-warning" : "text-muted-foreground")}
        >
          {forecastText(forecast)}
        </p>
      )}
      {history.length >= 2 && (
        <LimitSpark
          observations={history}
          now={now}
          span={HISTORY_SPAN[window]}
          colour={PROVIDER_COLOR[provider]}
          label={`${agentLabel(provider)} ${windowWord(window)} limit, ${HISTORY_SPAN_LABEL[window]}, from local history`}
        />
      )}
    </div>
  );
}

function CardTitle({ provider, window }: { provider: LimitProvider; window: LimitWindow }) {
  return (
    <h3 className="text-[13px]">
      <span
        aria-hidden
        className="mr-1.5 inline-block size-2 rounded-full align-middle"
        style={{ background: PROVIDER_COLOR[provider] }}
      />
      <span className="font-medium text-foreground">{PROVIDER_SHORT[provider]}</span>{" "}
      <span className="text-muted-foreground">{WINDOW_LABEL[window]}</span>
    </h3>
  );
}

const SPARK_W = 200,
  SPARK_H = 24;

/**
 * A window's share used over its span, as local snapshots recorded it: a thin line that drops at
 * each reset, with the 80% mark beneath. Drawn once, never animated.
 */
function LimitSpark({
  observations,
  now,
  span,
  colour,
  label,
}: {
  observations: readonly UsageLimitObservation[];
  now: number;
  span: number;
  colour: string;
  label: string;
}) {
  const x = (at: number) => ((at - (now - span)) / span) * SPARK_W;
  const y = (u: number) => SPARK_H - Math.min(1, Math.max(0, u)) * SPARK_H;
  const path = observations
    .map((o, i) => `${i === 0 ? "M" : "L"}${x(o.at).toFixed(1)},${y(o.utilization).toFixed(1)}`)
    .join("");
  return (
    <svg
      role="img"
      aria-label={label}
      data-testid="usage-limit-history"
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="none"
      className="mt-2.5 h-6 w-full overflow-visible"
    >
      <title>{label}</title>
      <line
        x1={0}
        x2={SPARK_W}
        y1={y(0.8)}
        y2={y(0.8)}
        className="stroke-warning/35"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={path}
        fill="none"
        stroke={colour}
        strokeWidth={1.5}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
