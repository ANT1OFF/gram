import {
  creditBalanceNumber,
  creditBurn,
  limitForecast,
  limitPace,
  type CreditHistoryPoint,
  type LimitHistoryDays,
  type LimitHistoryPoint,
  type UsageLimitHistory,
} from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, TrendingUp } from "lucide-react";
import { useState } from "react";

import { agentLabel } from "@/agents/agent-label";
import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { agoText, formatDay } from "@/lib/time";
import { cn } from "@/lib/utils";
import { OptionGroup } from "@/settings/fields";
import { useLimitsNow, useMinuteNow } from "@/shell/usage-meter";
import {
  currentLimit,
  LIMIT_PROVIDERS,
  LIMIT_WARN_AT,
  LIMIT_WINDOWS,
  limitSpent,
  limitStale,
  limitWarns,
  useUsageLimits,
  type LimitProvider,
  type LimitWindow,
  type UsageLimit,
} from "@/stores/usage-limits";
import {
  CREDITS_TEXT,
  creditsText,
  forecastText,
  limitPercent,
  resetAtText,
  WINDOW_LABEL,
  windowWord,
} from "@/usage/limit-format";

import { ChartLegend, HistoryChart } from "./limit-history-chart";
import {
  addedText,
  atLimitText,
  burnText,
  creditCount,
  creditSeries,
  HISTORY_WINDOW,
  historyGap,
  paceDetail,
  paceText,
  paceWarns,
  stepWords,
  windowHistorySummary,
  windowPointNotes,
  windowSeries,
} from "./limit-history-model";
import { PROVIDER_COLOR } from "./usage-model";

const PERIODS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
] as const;

const CARD = "flex flex-col rounded-lg border border-edge bg-card px-4 py-3.5";

/**
 * Settings → Usage: each subscription's limits as the agents last reported them, how each window
 * stands against an even pace, Codex's credits and what they burn, and every window's use over the
 * past week or month from the history Gram keeps. Limits are per account, so nothing here is
 * split by workspace or thread; the token page has that.
 */
export function UsageSettingsPage() {
  const api = useApi();
  const [days, setDays] = useState<LimitHistoryDays>(7);
  const query = useQuery({
    queryKey: ["usage-limit-history", days],
    queryFn: () => api.usageLimitHistory({ days }),
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    placeholderData: (previous) => previous,
  });
  const limits = useUsageLimits((s) => s.limits);
  const now = Math.max(useLimitsNow(limits), useMinuteNow());
  const history = query.data;
  const providers = LIMIT_PROVIDERS.filter(
    (p) =>
      LIMIT_WINDOWS.some(
        (w) =>
          currentLimit(limits[p]?.[w], now) !== undefined || windowSeries(history, p, w).length > 0,
      ) || creditSeries(history, p).length > 0,
  );
  return (
    <div className="flex flex-col gap-8" data-testid="usage-settings">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="text-meta text-muted-foreground" data-testid="usage-history-since">
          {sinceText(history, now)}
        </p>
        <div className="ml-auto">
          <OptionGroup
            label="History period"
            options={PERIODS}
            value={String(days) as (typeof PERIODS)[number]["value"]}
            onChange={(value) => setDays(Number(value) as LimitHistoryDays)}
          />
        </div>
      </div>
      {query.isError && (
        <p role="alert" className="text-reading text-muted-foreground">
          History unavailable: {errorMessage(query.error)}
        </p>
      )}
      {providers.length === 0 ? (
        <p className="text-reading text-muted-foreground" data-testid="usage-settings-none">
          Limits appear here once Claude Code or Codex reports one. Gram reads them while a window
          is open and as your agents work, and keeps 35 days of history.
        </p>
      ) : (
        <div className={cn("flex flex-col gap-8", query.isPlaceholderData && "opacity-60")}>
          {/* Once for every chart below: what the line, its breaks and drops, the dashed line and
              the bars' marks mean. */}
          {history !== undefined && (
            <ChartLegend step={stepWords(history.step)} className="-mt-4" />
          )}
          {providers.map((provider) => (
            <ProviderUsage
              key={provider}
              provider={provider}
              now={now}
              history={history}
              days={days}
            />
          ))}
        </div>
      )}
      <section
        aria-labelledby="usage-tokens-link-title"
        className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-border pt-4"
      >
        <div className="min-w-0 flex-1">
          <h3 id="usage-tokens-link-title" className="font-medium">
            Tokens by workspace and thread
          </h3>
          <p data-setting-description="" className="text-meta text-muted-foreground">
            Limits are per account. Tokens split by day, model, workspace and thread.
          </p>
        </div>
        <Link
          to="/usage"
          data-testid="usage-settings-tokens"
          className="inline-flex items-center gap-1 rounded-sm text-body text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          Open token usage
          <ArrowRight aria-hidden className="size-icon-chip" />
        </Link>
      </section>
    </div>
  );
}

/** "Kept since 3 Oct · 35 days of history": when the history starts, so a blank early part reads. */
function sinceText(history: UsageLimitHistory | undefined, now: number): string {
  const base = "As your agents report them, and the history Gram keeps";
  if (history?.since === undefined || history.since <= history.from) return base;
  return `${base} · history kept since ${formatDay(history.since, now)}`;
}

function ProviderUsage({
  provider,
  now,
  history,
  days,
}: {
  provider: LimitProvider;
  now: number;
  history: UsageLimitHistory | undefined;
  days: LimitHistoryDays;
}) {
  const windows = useUsageLimits((s) => s.limits[provider]);
  const current = LIMIT_WINDOWS.flatMap((w) => {
    const limit = currentLimit(windows?.[w], now);
    return limit === undefined ? [] : [limit];
  });
  const newest = current.reduce<UsageLimit | undefined>(
    (a, b) => (a === undefined || (b.at ?? 0) > (a.at ?? 0) ? b : a),
    undefined,
  );
  const credits = creditSeries(history, provider);
  const titleId = `usage-provider-${provider}`;
  return (
    <section
      aria-labelledby={titleId}
      data-testid="usage-provider"
      data-provider={provider}
      className="flex flex-col gap-3"
    >
      <div className="flex items-baseline gap-2">
        <h3 id={titleId} className="font-heading text-title">
          <span
            aria-hidden
            className="mr-2 inline-block size-2 rounded-full align-middle"
            style={{ background: PROVIDER_COLOR[provider] }}
          />
          {agentLabel(provider)}
        </h3>
        <span
          data-setting-description=""
          data-testid="usage-provider-age"
          className="text-meta text-muted-foreground tabular-nums"
        >
          {newest?.at === undefined ? "No current reading" : `Read ${agoText(newest.at, now)}`} ·
          includes use outside Gram
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 @2xl/settings:grid-cols-2">
        {LIMIT_WINDOWS.map((window) => (
          <WindowCard
            key={window}
            provider={provider}
            window={window}
            limit={currentLimit(windows?.[window], now)}
            points={windowSeries(history, provider, window)}
            history={history}
            days={days}
            now={now}
          />
        ))}
        {(newest !== undefined && creditsText(newest) !== undefined) || credits.length > 0 ? (
          <CreditsCard
            provider={provider}
            limit={newest}
            points={credits}
            history={history}
            days={days}
            now={now}
          />
        ) : null}
      </div>
    </section>
  );
}

function WindowCard({
  provider,
  window,
  limit,
  points,
  history,
  days,
  now,
}: {
  provider: LimitProvider;
  window: LimitWindow;
  limit: UsageLimit | undefined;
  points: readonly LimitHistoryPoint[];
  history: UsageLimitHistory | undefined;
  days: LimitHistoryDays;
  now: number;
}) {
  const name = `${agentLabel(provider)} ${windowWord(window)} limit`;
  const percent = limit === undefined ? undefined : limitPercent(limit.utilization);
  const warns = limit !== undefined && limitWarns(limit);
  const spent = limit !== undefined && limitSpent(limit);
  const pace = limit === undefined ? undefined : limitPace(HISTORY_WINDOW[window], limit, now);
  const forecast =
    limit?.at === undefined || limit.samples === undefined
      ? undefined
      : limitForecast({ ...limit, at: limit.at, samples: limit.samples }, now);
  const summary = windowHistorySummary(points);
  const colour = spent ? "var(--danger)" : warns ? "var(--warning)" : PROVIDER_COLOR[provider];
  const reached = summary === undefined ? undefined : atLimitText(summary);
  return (
    <div
      role="group"
      aria-label={name}
      data-testid="usage-window"
      data-provider={provider}
      data-window={window}
      data-warn={warns || undefined}
      className={CARD}
    >
      <div className="flex items-baseline gap-2">
        <h4 className="text-body font-medium">{WINDOW_LABEL[window]}</h4>
        {limit !== undefined && limit.resetsAt !== undefined && (
          <span
            data-testid="usage-window-reset"
            className="text-meta text-muted-foreground tabular-nums"
          >
            Resets {resetAtText(limit.resetsAt, now)}
          </span>
        )}
        <p
          data-testid="usage-window-percent"
          className={cn(
            "ml-auto text-heading leading-none font-medium tabular-nums",
            limit === undefined && "text-muted-foreground",
            spent ? "text-destructive" : warns && "text-warning",
          )}
        >
          {percent ?? "–"}
          {percent !== undefined && (
            <span className="ml-px text-reading font-normal text-muted-foreground">%</span>
          )}
        </p>
      </div>
      {limit === undefined ? (
        <p className="mt-2 text-meta text-muted-foreground">No current reading</p>
      ) : (
        <>
          <div
            role="meter"
            aria-label={`${name} used`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="relative mt-3 mb-2 h-1.5 rounded-full bg-foreground/12"
          >
            <span
              className="absolute inset-y-0 left-0 rounded-full"
              style={{ width: `${percent}%`, background: colour }}
            />
            {pace !== undefined && (
              // Where an even pace through the window would be now.
              <span
                aria-hidden
                data-testid="usage-window-even"
                className="absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-foreground/60"
                style={{ left: `${Math.round(pace.elapsed * 100)}%` }}
              />
            )}
          </div>
          <div className="flex flex-wrap justify-between gap-x-3 text-meta text-muted-foreground tabular-nums">
            {pace !== undefined && (
              <span
                data-testid="usage-window-pace"
                title={`An even pace uses the window steadily until it resets: ${paceDetail(pace)}.`}
                className={cn(paceWarns(pace) && "text-warning")}
              >
                {paceText(pace)} · {paceDetail(pace)}
              </span>
            )}
            {limitStale(limit, now) && limit.at !== undefined && (
              <span>Read {agoText(limit.at, now)}</span>
            )}
          </div>
          {limit.credits === true && (
            <p className="mt-0.5 text-meta text-muted-foreground">{CREDITS_TEXT}</p>
          )}
          {forecast !== undefined && (
            <p
              data-testid="usage-window-forecast"
              className={cn(
                "mt-0.5 flex items-center gap-1 text-meta",
                warns ? "text-warning" : "text-muted-foreground",
              )}
            >
              <TrendingUp aria-hidden className="size-icon-chip shrink-0" />
              {forecastText(forecast, now)}
            </p>
          )}
        </>
      )}
      <div className="mt-4">
        {points.length === 0 || history === undefined ? (
          <p
            data-testid="usage-window-history-empty"
            className="rounded-md border border-dashed border-border px-3 py-4 text-center text-meta text-muted-foreground"
          >
            No history kept for the last {days} days yet
          </p>
        ) : (
          <HistoryChart
            testId="usage-window-history"
            points={points.map((p) => ({
              at: p.at,
              value: p.utilization,
              notes: windowPointNotes(p, history.step, now, limitPercent),
            }))}
            from={history.from}
            to={history.to}
            step={history.step}
            gap={historyGap(history.step)}
            top={1}
            guide={LIMIT_WARN_AT}
            colour={PROVIDER_COLOR[provider]}
            formatValue={(v) => `${limitPercent(v)}%`}
            label={`${name}, share used over the last ${days} days${
              summary === undefined ? "" : `, peak ${limitPercent(summary.peak)}%`
            }`}
          />
        )}
      </div>
      {summary !== undefined && (
        <p
          data-testid="usage-window-summary"
          className="mt-2 text-meta text-muted-foreground tabular-nums"
        >
          Peak {limitPercent(summary.peak)}%{reached === undefined ? "" : ` · ${reached}`}
        </p>
      )}
    </div>
  );
}

function CreditsCard({
  provider,
  limit,
  points,
  history,
  days,
  now,
}: {
  provider: LimitProvider;
  limit: UsageLimit | undefined;
  points: readonly CreditHistoryPoint[];
  history: UsageLimitHistory | undefined;
  days: LimitHistoryDays;
  now: number;
}) {
  const balance = creditBalanceNumber(limit?.creditsBalance) ?? points.at(-1)?.balance;
  const burn = creditBurn(points);
  const added = burn === undefined ? undefined : addedText(burn);
  const top = Math.max(1, ...points.map((p) => p.balance)) * 1.1;
  return (
    <div
      role="group"
      aria-label={`${agentLabel(provider)} credits`}
      data-testid="usage-credits"
      data-provider={provider}
      className={cn(CARD, "@2xl/settings:col-span-2")}
    >
      <div className="flex items-baseline gap-2">
        <h4 className="text-body font-medium">Credits</h4>
        <span className="text-meta text-muted-foreground">What turns go on with past a limit</span>
        <p
          data-testid="usage-credits-balance"
          className="ml-auto text-heading leading-none font-medium tabular-nums"
        >
          {limit?.creditsUnlimited === true
            ? "Unlimited"
            : balance === undefined
              ? "–"
              : creditCount(balance)}
          {limit?.creditsUnlimited !== true && balance !== undefined && (
            <span className="ml-1 text-reading font-normal text-muted-foreground">left</span>
          )}
        </p>
      </div>
      <p
        data-testid="usage-credits-burn"
        className="mt-1.5 text-meta text-muted-foreground tabular-nums"
      >
        {burn === undefined
          ? "Burn shows once Gram has read the balance twice"
          : `${burnText(burn)}${added === undefined ? "" : ` · ${added}`}`}
      </p>
      {history !== undefined && points.length > 1 && (
        <div className="mt-4">
          <HistoryChart
            testId="usage-credits-history"
            area={false}
            points={points.map((p) => ({
              at: p.at,
              value: p.balance,
              notes: [`Read ${agoText(Math.min(p.at + history.step, now), now)}`],
            }))}
            from={history.from}
            to={history.to}
            step={history.step}
            gap={historyGap(history.step)}
            top={top}
            colour={PROVIDER_COLOR[provider]}
            formatValue={(v) => creditCount(v)}
            label={`${agentLabel(provider)} credit balance over the last ${days} days`}
          />
        </div>
      )}
    </div>
  );
}
