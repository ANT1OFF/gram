import type { UsageOverview, UsagePeriod, UsageProvider } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { OptionGroup } from "@/settings/fields";

import { OutsideGramSection, UsageBreakdownSection } from "./usage-breakdown";
import { DailyTable, FamilyLegend, TokensChart } from "./usage-chart";
import { UsageLimitsSection } from "./usage-limits-section";
import { ModelTable } from "./usage-model-table";
import {
  cacheShare,
  compactTokens,
  dayLabel,
  FAMILIES,
  familiesIn,
  usageDays,
  wholeTokens,
  type Family,
} from "./usage-model";
import { UsageSourcesSection } from "./usage-sources";

const PERIODS = [
  { value: "1", label: "24 h" },
  { value: "7", label: "7 d" },
  { value: "30", label: "30 d" },
  { value: "90", label: "90 d" },
] as const;
const PROVIDERS = [
  { value: "all", label: "All" },
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
] as const;

const DAY_MONTH = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
});
const rangeText = (data: UsageOverview) =>
  `${DAY_MONTH.format(data.from)} – ${DAY_MONTH.format(data.to)}`;

/**
 * Usage, limits first: the subscription windows as the agents report them, then tokens by day and
 * model, where they went by workspace and thread, what ran outside Gram, and the sources read.
 */
export function UsagePage() {
  const api = useApi();
  const [days, setDays] = useState<UsagePeriod>(30);
  const [provider, setProvider] = useState<UsageProvider | undefined>();
  const query = useQuery({
    queryKey: ["usage-overview", days, provider ?? "all"],
    queryFn: () => api.usageOverview({ days, ...(provider === undefined ? {} : { provider }) }),
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    // A new filter keeps the last view, dimmed, rather than flashing empty.
    placeholderData: (previous) => previous,
  });
  const data = query.data;
  return (
    <section className="@container min-h-0 flex-1 overflow-y-auto" aria-labelledby="usage-title">
      <div
        className="mx-auto flex max-w-6xl flex-col gap-8 px-5 py-6 @3xl:px-8 @3xl:py-7"
        data-testid="usage-overview"
      >
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 id="usage-title" className="font-heading text-xl font-semibold">
            Usage
          </h1>
          {data !== undefined && (
            <span className="text-xs text-muted-foreground">
              {days === 1 ? "Last 24 hours" : `Last ${days} days`} · {rangeText(data)}
            </span>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <OptionGroup
              label="Period"
              options={PERIODS}
              value={String(days) as (typeof PERIODS)[number]["value"]}
              onChange={(value) => setDays(Number(value) as UsagePeriod)}
            />
            <OptionGroup
              label="Provider"
              options={PROVIDERS}
              value={provider ?? "all"}
              onChange={(value) => setProvider(value === "all" ? undefined : value)}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh usage"
              title="Refresh usage"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              <RefreshCw />
            </Button>
          </div>
        </header>
        <UsageLimitsSection provider={provider} history={data?.localLimitHistory?.observations} />
        {query.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Reading usage history…
          </p>
        ) : query.isError ? (
          <div role="alert" className="rounded-lg border border-border p-5">
            <h2 className="font-medium">Usage unavailable</h2>
            <p className="mt-2 text-sm text-muted-foreground">{errorMessage(query.error)}</p>
            <Button className="mt-4" variant="outline" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </div>
        ) : (
          <div
            className={cn(
              "flex flex-col gap-8",
              query.isPlaceholderData && "opacity-60 transition-opacity",
            )}
          >
            <UsageSnapshot data={query.data} />
          </div>
        )}
        <UsageSourcesSection data={data} />
      </div>
    </section>
  );
}

function UsageSnapshot({ data }: { data: UsageOverview }) {
  const history = data.history;
  const excluded =
    (history?.untrustedGramTurns ?? 0) +
    (history?.ambiguousGramTurns ?? 0) +
    (history?.omittedRecords ?? 0);
  const incompleteSources =
    history !== undefined &&
    (history.sources.some((source) => source.status === "partial") ||
      history.sources.every((source) => source.status === "missing"));
  const noActivity =
    data.recordedTurns +
      data.missingUsageTurns +
      data.invalidUsageTurns +
      data.unattributedTurns +
      data.openTurns +
      excluded ===
      0 && !incompleteSources;
  const days = usageDays(data);
  const families = familiesIn(days);
  const byFamily = Object.fromEntries(
    FAMILIES.map((f) => [f, days.reduce((n, d) => n + d.families[f], 0)]),
  ) as Record<Family, number>;
  const busiest = days.reduce<(typeof days)[number] | undefined>(
    (best, d) => (d.total > (best?.total ?? 0) ? d : best),
    undefined,
  );
  const cache = cacheShare(data.totals);
  const outside = data.breakdown?.outside ?? [];
  return (
    <>
      <section aria-labelledby="usage-tokens-title">
        <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <h2 id="usage-tokens-title" className="text-sm font-semibold">
            Tokens
          </h2>
          {families.length > 0 && (
            <FamilyLegend families={families} totals={byFamily} className="ml-auto" />
          )}
        </div>
        <dl className="mb-5 flex flex-wrap gap-x-9 gap-y-3" aria-label="Recorded totals">
          <Stat
            label="Total"
            value={data.recordedTurns === 0 && !noActivity ? null : data.totals.totalTokens}
            testId="usage-tokens"
            detail={
              <>
                <span data-testid="usage-turns">{wholeTokens(data.recordedTurns)}</span>{" "}
                {history === undefined ? "turns" : "records"} ·{" "}
                {wholeTokens(data.recordedConversations)} conversations
              </>
            }
          />
          <Stat
            label="Cache read"
            text={cache === undefined ? "–" : `${Math.round(cache * 100)}%`}
            detail="of input"
          />
          <Stat label="Output" value={data.totals.outputTokens} />
          {busiest !== undefined && days.length > 1 && (
            <Stat
              label="Busiest day"
              value={busiest.total}
              detail={dayLabel(busiest.day, { weekday: true })}
            />
          )}
        </dl>
        {noActivity ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center">
            <h3 className="font-medium">No recorded activity in this period</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Completed Gram turns and available local CLI requests with reported tokens appear
              here. Try a longer period for older activity.
            </p>
          </div>
        ) : data.recordedTurns === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            Activity exists, but no attributable token totals are available for this selection.
          </p>
        ) : (
          <>
            <TokensChart days={days} families={families} />
            <DailyTable days={days} families={families} />
            <details className="mt-2 text-xs" data-testid="usage-model-detail">
              <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
                Model and day detail
              </summary>
              <div className="mt-3">
                <ModelTable
                  // Its own model and day filters start over with a new period or provider.
                  key={`${data.provider}-${data.to - data.from}`}
                  rows={data.rows}
                  history={history !== undefined}
                />
              </div>
            </details>
          </>
        )}
      </section>
      {data.breakdown !== undefined && data.recordedTurns > 0 && (
        <UsageBreakdownSection breakdown={data.breakdown} />
      )}
      {outside.length > 0 && (
        <OutsideGramSection outside={outside} total={data.totals.totalTokens} />
      )}
    </>
  );
}

function Stat({
  label,
  value,
  text,
  detail,
  testId,
}: {
  label: string;
  /** A token count, shown compact with the whole number on hover; null when none is known. */
  value?: number | null;
  /** Shown as it is, in place of a count. */
  text?: string;
  detail?: ReactNode;
  testId?: string;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        data-testid={testId}
        data-value={value ?? undefined}
        className="mt-0.5 text-xl font-medium"
        title={
          value === undefined
            ? undefined
            : value === null
              ? "No attributable amount available"
              : `${wholeTokens(value)} tokens`
        }
      >
        {text ?? (value === null || value === undefined ? "—" : compactTokens(value))}
      </dd>
      {detail !== undefined && <dd className="text-xs text-muted-foreground">{detail}</dd>}
    </div>
  );
}
