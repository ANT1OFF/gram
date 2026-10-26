import type {
  UsageBreakdown,
  UsageModelShare,
  UsageThreadRole,
  UsageTotals,
} from "@gram/contracts";
import { Link } from "@tanstack/react-router";
import { SquareTerminal } from "lucide-react";
import { useState } from "react";

import { AgentIcon, agentLabel } from "@/agents/agent-display";
import { Button } from "@/components/ui/button";

import {
  compactTokens,
  FAMILIES,
  familiesOf,
  FAMILY_COLOR,
  PROVIDER_COLOR,
  wholeTokens,
} from "./usage-model";

/** Threads listed before "Show all": enough to read the top at a glance. */
const THREADS_SHOWN = 8;

const ROLE_LABEL: Readonly<Record<UsageThreadRole, string>> = {
  orchestrator: "orchestrator",
  worker: "worker",
  dream: "dream",
  solo: "solo",
};

interface Bar {
  readonly key: string;
  readonly label: string;
  readonly note?: string;
  readonly totals: UsageTotals;
  readonly models: readonly UsageModelShare[];
}

/**
 * Where the period went: each workspace and Solo threads beside the threads that used the most,
 * each bar split by model family on the same scale as its list.
 */
export function UsageBreakdownSection({ breakdown }: { breakdown: UsageBreakdown }) {
  const workspaces: Bar[] = breakdown.workspaces.map((w) => ({
    key: w.workspaceId,
    label: w.name ?? "Removed workspace",
    note: `${w.threads} ${w.threads === 1 ? "thread" : "threads"}`,
    totals: w.totals,
    models: w.models,
  }));
  if (breakdown.solo.threads > 0)
    workspaces.push({
      key: "solo",
      label: "Solo threads",
      note: `${breakdown.solo.threads} ${breakdown.solo.threads === 1 ? "thread" : "threads"}`,
      totals: breakdown.solo.totals,
      models: breakdown.solo.models,
    });
  return (
    <section
      aria-label="Breakdown"
      data-testid="usage-breakdown"
      className="grid grid-cols-1 gap-x-8 gap-y-7 @3xl:grid-cols-2"
    >
      <div>
        <h2 className="mb-2 text-sm font-semibold">By workspace</h2>
        {workspaces.length === 0 ? (
          <p className="text-sm text-muted-foreground">No Gram threads in this period.</p>
        ) : (
          <BarList bars={workspaces} testId="usage-by-workspace" />
        )}
      </div>
      <ThreadList threads={breakdown.threads} />
    </section>
  );
}

function ThreadList({ threads }: { threads: UsageBreakdown["threads"] }) {
  const [all, setAll] = useState(false);
  const shown = all ? threads : threads.slice(0, THREADS_SHOWN);
  const max = Math.max(1, ...threads.map((t) => t.totals.totalTokens));
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2.5">
        <h2 className="text-sm font-semibold">By thread</h2>
        {threads.length > 0 && (
          <span className="text-xs text-muted-foreground">Top {shown.length}</span>
        )}
      </div>
      {threads.length === 0 ? (
        <p className="text-sm text-muted-foreground">No Gram threads in this period.</p>
      ) : (
        <ul data-testid="usage-by-thread" className="grid gap-0.5">
          {shown.map((thread) => {
            const agent = thread.models[0]?.provider ?? "claude";
            return (
              <li
                key={thread.threadId}
                data-testid="usage-thread-row"
                data-thread-id={thread.threadId}
              >
                <div className="flex min-w-0 items-center gap-2 pt-1.5 text-[13px]">
                  <AgentIcon agent={agent} className="size-3.5 shrink-0 text-muted-foreground" />
                  {thread.title === null ? (
                    <span className="truncate text-muted-foreground">Deleted thread</span>
                  ) : (
                    <Link
                      to="/t/$threadId"
                      params={{ threadId: thread.threadId }}
                      className="truncate rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {thread.title}
                    </Link>
                  )}
                  <span className="shrink-0 rounded-sm bg-muted px-1.5 text-[11px] text-muted-foreground">
                    {ROLE_LABEL[thread.role]}
                  </span>
                  <Amount totals={thread.totals} className="ml-auto" />
                </div>
                <SplitBar models={thread.models} total={thread.totals.totalTokens} max={max} />
              </li>
            );
          })}
        </ul>
      )}
      {threads.length > THREADS_SHOWN && (
        <Button
          variant="ghost"
          size="xs"
          className="mt-1.5 -ml-2 text-muted-foreground"
          onClick={() => setAll(!all)}
        >
          {all ? "Show fewer" : `Show all ${threads.length}`}
        </Button>
      )}
    </div>
  );
}

function BarList({ bars, testId }: { bars: readonly Bar[]; testId: string }) {
  const max = Math.max(1, ...bars.map((b) => b.totals.totalTokens));
  return (
    <ul data-testid={testId} className="grid gap-0.5">
      {bars.map((bar) => (
        <li key={bar.key} data-testid="usage-breakdown-row" data-key={bar.key}>
          <div className="flex min-w-0 items-baseline gap-2 pt-1.5 text-[13px]">
            <span className="truncate">{bar.label}</span>
            {bar.note !== undefined && (
              <span className="shrink-0 text-xs text-muted-foreground">{bar.note}</span>
            )}
            <Amount totals={bar.totals} className="ml-auto" />
          </div>
          <SplitBar models={bar.models} total={bar.totals.totalTokens} max={max} />
        </li>
      ))}
    </ul>
  );
}

function Amount({ totals, className }: { totals: UsageTotals; className?: string }) {
  return (
    <span
      data-testid="usage-amount"
      data-value={totals.totalTokens}
      title={`${wholeTokens(totals.totalTokens)} tokens`}
      className={`shrink-0 text-muted-foreground tabular-nums ${className ?? ""}`}
    >
      {compactTokens(totals.totalTokens)}
    </span>
  );
}

/** A row's share of the list's largest, split by family with a 2 px gap between parts. */
function SplitBar({
  models,
  total,
  max,
}: {
  models: readonly UsageModelShare[];
  total: number;
  max: number;
}) {
  const families = familiesOf(models);
  const listed = FAMILIES.reduce((n, f) => n + families[f], 0);
  // Models past the listed few still count: give their share to Other.
  const rest = Math.max(0, total - listed);
  const parts = FAMILIES.map((f) => ({
    family: f,
    value: families[f] + (f === "other" ? rest : 0),
  })).filter((p) => p.value > 0);
  return (
    <div
      aria-hidden
      className="mt-1 flex h-1 gap-[2px]"
      style={{ width: `${(total / max) * 100}%` }}
    >
      {parts.map((p) => (
        <span
          key={p.family}
          className="block h-full min-w-px first:rounded-l-full last:rounded-r-full"
          style={{ flexGrow: p.value, background: FAMILY_COLOR[p.family] }}
        />
      ))}
    </div>
  );
}

/** Your own terminal sessions, from local CLI history: counted toward the limits, in no workspace. */
export function OutsideGramSection({
  outside,
  total,
}: {
  outside: UsageBreakdown["outside"];
  /** The period's counted tokens, for the share. */
  total: number;
}) {
  const sum = outside.reduce((n, row) => n + row.totals.totalTokens, 0);
  return (
    <section
      aria-labelledby="usage-outside-title"
      data-testid="usage-outside"
      className="rounded-lg border border-dashed border-border-strong px-4 py-3.5"
    >
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h2 id="usage-outside-title" className="flex items-center gap-1.5 text-sm font-semibold">
          <SquareTerminal aria-hidden className="size-3.5 text-muted-foreground" />
          Outside Gram
        </h2>
        <p className="text-xs text-muted-foreground">
          Your own terminal sessions, from local CLI history · in no workspace
        </p>
      </div>
      <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-3">
        {outside.map((row) => (
          <div key={row.provider} data-testid="usage-outside-provider" data-provider={row.provider}>
            <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span
                aria-hidden
                className="size-2 rounded-full"
                style={{ background: PROVIDER_COLOR[row.provider] }}
              />
              {agentLabel(row.provider)}
            </dt>
            <dd
              className="text-xl font-medium"
              title={`${wholeTokens(row.totals.totalTokens)} tokens`}
            >
              {compactTokens(row.totals.totalTokens)}
            </dd>
            <dd className="text-xs text-muted-foreground">
              {row.sessions} {row.sessions === 1 ? "session" : "sessions"}
            </dd>
          </div>
        ))}
        {total > 0 && (
          <div>
            <dt className="text-xs text-muted-foreground">Share of all tokens</dt>
            <dd className="text-xl font-medium">{Math.round((sum / total) * 100)}%</dd>
            <dd className="text-xs text-muted-foreground">this period</dd>
          </div>
        )}
      </dl>
    </section>
  );
}
