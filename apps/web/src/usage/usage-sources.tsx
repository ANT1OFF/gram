import { usageHistoryEnabled, type UsageOverview, type UsageProvider } from "@gram/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { agentLabel } from "@/agents/agent-label";
import { errorMessage } from "@/api/errors";
import { Toggle } from "@/settings/fields";
import { useSaveSettings } from "@/settings/use-save-settings";
import { useServerSettings } from "@/settings-sync/store";

const WHOLE = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });
const number = (n: number) => WHOLE.format(n);

const HISTORY_HELP: Readonly<Record<UsageProvider, string>> = {
  claude:
    "Reads token counts and models from Claude Code's local project logs on this computer, including sessions you ran yourself. Never the conversation.",
  codex:
    "Reads token counts, models and limit snapshots from Codex's local session logs on this computer, including sessions you ran yourself. Never the conversation.",
};

/**
 * What the page reads beyond Gram's own turns: each CLI's local history, on or off, and folded
 * under it the coverage of what was and wasn't counted.
 */
export function UsageSourcesSection({ data }: { data: UsageOverview | undefined }) {
  const settings = useServerSettings((s) => s.settings);
  const save = useSaveSettings();
  const queryClient = useQueryClient();
  const [failed, setFailed] = useState<{ provider: UsageProvider; message: string }>();
  const files = (provider: UsageProvider) => {
    const sources = data?.history?.sources.filter((s) => s.provider === provider) ?? [];
    if (sources.length === 0) return undefined;
    const read = sources.reduce((n, s) => n + s.files, 0);
    const skipped = sources.reduce((n, s) => n + s.skippedFiles, 0);
    return `${number(read)} ${read === 1 ? "file" : "files"} read${skipped === 0 ? "" : ` · ${number(skipped)} skipped`}`;
  };
  const set = (provider: UsageProvider) => (on: boolean) => {
    setFailed(undefined);
    save({ usageHistory: { [provider]: on } })
      .then(() => queryClient.invalidateQueries({ queryKey: ["usage-overview"] }))
      .catch((e: unknown) => setFailed({ provider, message: errorMessage(e) }));
  };
  return (
    <section
      aria-labelledby="usage-sources-title"
      data-testid="usage-sources"
      className="border-t border-border pt-5"
    >
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2.5">
        <h2 id="usage-sources-title" className="text-sm font-semibold">
          Sources
        </h2>
        <p className="text-xs text-muted-foreground">Gram's own turns, and on this computer:</p>
      </div>
      {settings === undefined ? (
        <p className="text-sm text-muted-foreground">Loading settings…</p>
      ) : (
        <div className="mt-2 grid gap-2.5 text-[13px]">
          {(["claude", "codex"] as const).map((provider) => {
            const detail = usageHistoryEnabled(settings, provider) ? files(provider) : undefined;
            return (
              <Toggle
                key={provider}
                label={`${agentLabel(provider)} history`}
                description={HISTORY_HELP[provider]}
                checked={usageHistoryEnabled(settings, provider)}
                onChange={set(provider)}
                error={failed?.provider === provider ? failed.message : undefined}
                detail={
                  detail === undefined ? undefined : (
                    <span className="text-xs text-muted-foreground tabular-nums">{detail}</span>
                  )
                }
              />
            );
          })}
        </div>
      )}
      {data !== undefined && <Coverage data={data} />}
    </section>
  );
}

function Coverage({ data }: { data: UsageOverview }) {
  const history = data.history;
  const excluded =
    data.missingUsageTurns + data.invalidUsageTurns + data.unattributedTurns + data.openTurns;
  return (
    <details
      className="mt-3 text-xs leading-relaxed text-muted-foreground"
      data-testid="usage-coverage"
    >
      <summary className="w-fit cursor-pointer rounded-sm outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
        Coverage · {number(data.recordedTurns)} {history === undefined ? "turns" : "records"}{" "}
        counted
        {excluded === 0 ? "" : ` · ${number(excluded)} not counted`}
      </summary>
      <div className="mt-3 grid max-w-3xl gap-4">
        {history !== undefined && <HistoryCoverage data={data} />}
        <section aria-labelledby="usage-coverage-title">
          <h3 id="usage-coverage-title" className="mb-1.5 text-[13px] font-medium text-foreground">
            Recording coverage
          </h3>
          <p>
            {number(data.missingUsageTurns)} ended turns without usage ·{" "}
            {number(data.invalidUsageTurns)} unreadable or inconsistent usage records ·{" "}
            {number(data.openTurns)} open turns excluded.
          </p>
          <p>
            {number(data.unattributedTurns)} turns in the period have unknown or unsupported
            providers and are excluded{data.provider === null ? "." : " from the provider filter."}{" "}
            {number(data.unknownModelTurns)} counted turns have unknown models.{" "}
            {number(data.incompleteCacheTurns)} have incomplete cache detail; missing counts are
            unknown, so Claude totals may be lower bounds.
          </p>
          <p>
            {number(data.interruptedTurns)} counted turns ended cancelled, interrupted or with an
            error; their last reported telemetry may be partial.
          </p>
          <p className="mt-2">
            Gram turns use their final saved usage snapshot. Retained open and closed conversations,
            workers and Dream conversations are included. Available local CLI history can add older
            requests. Exact provider, original session and native request identities prevent matched
            records from being added twice. Nested subagent and inherited fork usage are excluded
            when identifiable. Models come from actual assistant or turn metadata; the
            conversation’s current selection is never used. Claude Code and Codex recordings can
            omit main-lane model metadata.
          </p>
          <p className="mt-2">
            Days are UTC. This page counts tokens, not your subscription bill; the limits above are
            the agents' own readings.
          </p>
        </section>
      </div>
    </details>
  );
}

function HistoryCoverage({ data }: { data: UsageOverview }) {
  const history = data.history!;
  return (
    <section aria-labelledby="usage-history-title" data-testid="usage-history-coverage">
      <h3 id="usage-history-title" className="mb-1.5 text-[13px] font-medium text-foreground">
        Local history coverage
      </h3>
      <p>
        {number(history.importedRecords)} CLI usage records added · {number(history.matchedTurns)}{" "}
        Gram turns matched to complete CLI records · {number(history.duplicateRecords)} duplicate
        CLI records excluded.
      </p>
      <p>
        {number(data.partialUsageTurns ?? 0)} counted records contain known partial usage. These
        known contributions may omit requests; they do not establish complete account totals.
      </p>
      <p>
        {number(history.untrustedGramTurns)} Codex turns without request telemetry have untrusted
        amounts and are excluded. Their saved counters may include prior session usage.
      </p>
      <p>
        {number(history.ambiguousGramTurns)} Gram turns have ambiguous identity overlap and are
        excluded · {number(history.omittedRecords)} CLI records omitted due to inherited,
        conflicting or unsupported identity/accounting.
      </p>
      <div className="mt-2 flex flex-col gap-1">
        {(["codex", "claude"] as const).map((provider) => {
          const sources = history.sources.filter((source) => source.provider === provider);
          if (sources.length === 0) return null;
          return (
            <p key={provider}>
              {agentLabel(provider)}: {number(sources.reduce((n, source) => n + source.files, 0))}{" "}
              history files read ·{" "}
              {number(sources.filter((source) => source.status === "partial").length)} incomplete
              locations · {number(sources.filter((source) => source.status === "missing").length)}{" "}
              unavailable locations ·{" "}
              {number(sources.reduce((n, source) => n + source.skippedFiles, 0))} files skipped ·{" "}
              {number(sources.reduce((n, source) => n + source.invalidLines, 0))} invalid records.
            </p>
          );
        })}
      </div>
      {data.localLimitHistory !== undefined && (
        <p className="mt-2">
          {number(data.localLimitHistory.observations.length)} local limit snapshots read
          {data.localLimitHistory.truncated ? ", the newest kept" : ""} ·{" "}
          {number(data.localLimitHistory.invalidReadings)} unreadable. They are history, not your
          account's live state.
        </p>
      )}
      <p className="mt-2">
        Refresh checks available local history again with bounded work. A shorter period can reduce
        accounting limits. Missing, unreadable, compressed or truncated files and unresolved
        relative CLI homes leave coverage incomplete. Homes configured only in an interactive shell
        may be unavailable to the server. Only retained local history is available; deleted history
        and remote account activity are not retrieved.
      </p>
    </section>
  );
}
