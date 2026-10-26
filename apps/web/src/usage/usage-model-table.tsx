import type { UsageOverviewRow, UsageTotals } from "@gram/contracts";
import { useState } from "react";

import { agentLabel } from "@/agents/agent-label";

import { PROVIDER_COLOR } from "./usage-model";

const WHOLE = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });
const number = (n: number) => WHOLE.format(n);
const selectClass =
  "h-8 max-w-full rounded-lg border border-border bg-background px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * Every recorded model by UTC day with its token buckets, folded under the chart: the exact model
 * ids the colours group into families, filterable by model and day.
 */
export function ModelTable({
  rows,
  history,
}: {
  rows: readonly UsageOverviewRow[];
  history: boolean;
}) {
  const [model, setModel] = useState("all");
  const [day, setDay] = useState("all");
  const models = [...new Set(rows.map((row) => row.model))];
  const dates = [...new Set(rows.map((row) => row.day))];
  const filtered = rows.filter(
    (row) =>
      (model === "all" || JSON.stringify(row.model) === model) &&
      (day === "all" || row.day === day),
  );
  const tokens = filtered.reduce((n, row) => n + row.totals.totalTokens, 0);
  return (
    <section aria-labelledby="usage-model-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 id="usage-model-title" className="text-[13px] font-medium">
            Model / day
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Filter this table · {number(tokens)} known tokens in {filtered.length} rows
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="sr-only" htmlFor="usage-model">
            Table model
          </label>
          <select
            id="usage-model"
            className={selectClass}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="all">All models</option>
            {models.map((m) => (
              <option key={JSON.stringify(m)} value={JSON.stringify(m)}>
                {m ?? "Unknown model"}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="usage-day">
            Table day
          </label>
          <select
            id="usage-day"
            className={selectClass}
            value={day}
            onChange={(e) => setDay(e.target.value)}
          >
            <option value="all">All days</option>
            {dates.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="mt-4 max-h-96 overflow-auto rounded-xl border border-border">
        <table className="w-full text-left text-xs tabular-nums" data-testid="usage-model-table">
          <caption className="sr-only">
            Known tokens by actual recorded model, provider and UTC start date
          </caption>
          <thead className="sticky top-0 bg-background">
            <tr>
              {[
                "Date (UTC)",
                "Provider / model",
                history ? "Records" : "Turns",
                "Uncached input",
                "Cache read",
                "Cache write",
                "Input unsplit",
                "Output",
                "Total",
              ].map((h, i) => (
                <th
                  key={h}
                  scope="col"
                  className={`whitespace-nowrap border-b border-border px-3 py-3 font-medium ${i > 1 ? "text-right" : ""}`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr
                key={JSON.stringify([row.day, row.provider, row.model])}
                className="border-b border-border last:border-0"
              >
                <th scope="row" className="whitespace-nowrap px-3 py-3 font-normal">
                  {row.day}
                </th>
                <td className="px-3 py-3">
                  <span className="block whitespace-nowrap">{row.model ?? "Unknown model"}</span>
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span
                      aria-hidden
                      className="size-2 rounded-full"
                      style={{ background: PROVIDER_COLOR[row.provider] }}
                    />
                    {agentLabel(row.provider)}
                  </span>
                </td>
                <td className="px-3 py-3 text-right">{number(row.turns)}</td>
                {(
                  [
                    "uncachedInputTokens",
                    "cacheReadTokens",
                    "cacheWriteTokens",
                    "unclassifiedInputTokens",
                    "outputTokens",
                    "totalTokens",
                  ] as (keyof UsageTotals)[]
                ).map((k) => (
                  <td key={k} className="px-3 py-3 text-right">
                    {(k === "cacheReadTokens" && row.missingCacheRead) ||
                    (k === "cacheWriteTokens" && row.missingCacheWrite)
                      ? "≥ "
                      : ""}
                    {number(row.totals[k])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">No rows match these table filters.</p>
        )}
      </div>
    </section>
  );
}
