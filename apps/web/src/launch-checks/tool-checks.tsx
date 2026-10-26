import type { AgentRuntime } from "@gram/contracts";
import { ChevronRight, CircleX, KeyRound, RotateCw, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { AgentIcon, agentLabel } from "@/agents/agent-display";
import { errorMessage } from "@/api/errors";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { spin } from "@/motion";
import { ExpandableError } from "@/settings/fields";
import { SettingsGroup } from "@/settings/settings-group";

import { AgentRuntimeDetails } from "./agent-runtime-details";
import {
  CopyCommandButton,
  ManagedUpdate,
  NewerMark,
  SourceTag,
  VerdictMark,
} from "./agent-runtime-row";
import { cliUpdateStep } from "./agent-runtime-model";
import { CliUpdateButton, CliUpdatePanel } from "./cli-update";
import { CommandText } from "./command-text";
import {
  agentStatuses,
  codexInheritsSummary,
  toolSummary,
  type AgentStatus,
} from "./tool-checks-model";
import { useAgentRuntimes, useCliUpdate } from "./use-agent-runtimes";
import { useLaunchChecks } from "./use-launch-checks";

/** Runs `recheck` (the launch checks, unless given another), with the state a Re-check button shows. */
function useRecheck(again?: () => Promise<unknown>) {
  const { checks, recheck: launchRecheck } = useLaunchChecks();
  const recheck = again ?? launchRecheck;
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string>();
  const run = async () => {
    if (checking) return;
    setChecking(true);
    setError(undefined);
    try {
      await recheck();
    } catch (e) {
      setError(`Couldn't check again: ${errorMessage(e)}`);
    } finally {
      setChecking(false);
    }
  };
  return { checks, checking, error, run };
}

/** The ↻ on a group's caption; it turns while the checks run. */
function RecheckButton({ checking, onClick }: { checking: boolean; onClick: () => void }) {
  return (
    <Hint
      label={checking ? "Checking…" : "Re-check"}
      render={
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Re-check"
          aria-busy={checking}
          className="text-muted-foreground hover:text-foreground"
          onClick={onClick}
        />
      }
    >
      <RotateCw aria-hidden ref={checking ? spin : undefined} />
    </Hint>
  );
}

/** Settings → Diagnostics → Tools: each launch check in detail, and a re-check. */
export function ToolChecks() {
  const { checks, checking, error, run } = useRecheck();
  return (
    <SettingsGroup
      label="Tools"
      testId="tool-checks"
      action={<RecheckButton checking={checking} onClick={() => void run()} />}
    >
      {checks === undefined ? (
        <p className="text-muted-foreground">Checking…</p>
      ) : (
        checks.tools.map((tool) => (
          <div
            key={tool.tool}
            className="grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-8"
          >
            <span className="font-mono text-muted-foreground">{tool.tool}</span>
            <span className="text-right font-mono text-xs break-all">
              {toolSummary(tool, checks)}
              {tool.found && tool.unusable !== undefined && (
                <span className="block text-destructive">{`can't start threads: ${tool.unusable}`}</span>
              )}
              {tool.tool === "codex" && codexInheritsSummary(checks) !== undefined && (
                <span className="block text-muted-foreground">{codexInheritsSummary(checks)}</span>
              )}
              {tool.shadowed?.map((other) => (
                <span key={other.path} className="block text-muted-foreground">
                  {`also on PATH, not used: ${other.version ?? "version unknown"} at ${other.path}`}
                </span>
              ))}
            </span>
          </div>
        ))
      )}
      {error && <ExpandableError message={error} />}
    </SettingsGroup>
  );
}

/**
 * Settings → Agents: a row per agent Gram runs, with its version. A status shows only for
 * trouble, with the fix to copy where there is one, and Update where Gram can run that fix
 * itself; Diagnostics has the full detail.
 */
export function AgentChecks() {
  const runtimes = useAgentRuntimes();
  // The server's runtime re-check runs the launch checks again as well.
  const { checks, checking, error, run } = useRecheck(runtimes.recheck);
  return (
    <SettingsGroup
      label="Agents"
      keywords={["installed", "version", "signed in", "sign in", "upgrade"]}
      testId="agent-checks"
      action={<RecheckButton checking={checking} onClick={() => void run()} />}
    >
      {checks === undefined ? (
        <p className="text-muted-foreground">Checking…</p>
      ) : (
        agentStatuses(checks).map((status) => (
          <AgentStatusRow
            key={status.agent}
            status={status}
            runtime={runtimes.byAgent(status.agent)}
            releasesCheckedAt={runtimes.runtimes?.releasesCheckedAt}
            releasesUnavailable={runtimes.runtimes?.releasesUnavailable?.message}
            releasesChecking={runtimes.runtimes?.releasesChecking === true}
          />
        ))
      )}
      {runtimes.runtimes?.releasesUnavailable?.problem === "sign-in" && <RegistrySignIn />}
      {error && <ExpandableError message={error} />}
    </SettingsGroup>
  );
}

/**
 * The registry refused npm's credential (a 401 or 403), so no newer release can be checked or
 * fetched. A registry sign-in can expire independently of the installed CLI's subscription login.
 */
function RegistrySignIn() {
  return (
    <div
      data-testid="registry-sign-in"
      className="flex min-h-7 items-center gap-2 text-xs text-warning"
    >
      <KeyRound aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0">
        <CommandText text="npm registry sign-in expired: run `npm login` (or `npm ping`) to check for newer agent releases." />
      </span>
      <span className="ms-auto">
        <CopyCommandButton command="npm login" />
      </span>
    </div>
  );
}

function AgentStatusRow({
  status,
  runtime,
  releasesCheckedAt,
  releasesUnavailable,
  releasesChecking,
}: {
  status: AgentStatus;
  runtime: AgentRuntime | undefined;
  releasesCheckedAt: number | undefined;
  releasesUnavailable: string | undefined;
  releasesChecking: boolean;
}) {
  const { agent, version, note, trouble } = status;
  const name = agentLabel(agent);
  const [open, setOpen] = useState(false);
  const StatusIcon = trouble?.level === "error" ? CircleX : TriangleAlert;
  const tone = trouble?.level === "error" ? "text-destructive" : "text-warning";
  // The managed store's runtime replaces the PATH install the launch checks looked at.
  const shown = runtime?.resolved?.source === "managed" ? runtime.resolved.version : version;
  // Codex's fix is an install, which the runtime's installer-aware, release-gated
  // steps say better than the launch checks; Claude's is its sign-in, which stays.
  const runtimeStep = runtime?.installSteps[0];
  const fix = agent !== "claude" && runtime !== undefined ? undefined : trouble?.fix;
  const step = fix === undefined ? runtimeStep : undefined;
  const runnable = fix === undefined ? cliUpdateStep(runtime) : undefined;
  const update = useCliUpdate(agent);
  const [confirming, setConfirming] = useState(false);
  const updating = update.state !== undefined && update.state.state !== "idle";
  return (
    <div role="group" aria-label={name} data-testid="agent-check" data-trouble={trouble?.level}>
      <div className="flex min-h-7 items-center gap-2">
        <AgentIcon agent={agent} className="size-4" />
        <span className="font-medium">{name}</span>
        {shown !== undefined && (
          <span className="font-mono text-xs text-muted-foreground">{shown}</span>
        )}
        {runtime !== undefined && <SourceTag runtime={runtime} />}
        {note !== undefined && <span className="text-xs text-muted-foreground">{note}</span>}
        {runtime !== undefined && trouble === undefined && note === undefined && (
          <VerdictMark runtime={runtime} />
        )}
        <span className="ms-auto flex min-w-0 items-center gap-1.5">
          {trouble !== undefined && (
            <Hint
              label={<CommandText text={trouble.detail} />}
              render={
                <span
                  tabIndex={0}
                  className={cn(
                    "flex min-w-0 items-center gap-1 rounded-sm text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                    tone,
                  )}
                />
              }
            >
              <StatusIcon aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">{trouble.summary}</span>
              <span className="sr-only">. {trouble.detail.replaceAll("`", "")}</span>
            </Hint>
          )}
          {trouble === undefined && runtime !== undefined && <NewerMark runtime={runtime} />}
          {runtime !== undefined && <ManagedUpdate runtime={runtime} />}
          {runtime !== undefined && runnable !== undefined && !confirming && !updating && (
            <CliUpdateButton
              runtime={runtime}
              step={runnable}
              onClick={() => setConfirming(true)}
            />
          )}
          {fix !== undefined && <CopyCommandButton command={fix} label={`Copy the fix: ${fix}`} />}
          {step !== undefined && runtime?.managed?.candidate === undefined && (
            <CopyCommandButton
              command={step.command}
              label={trouble === undefined ? undefined : `Copy the fix: ${step.command}`}
            />
          )}
          {runtime !== undefined && (
            <Hint
              label={open ? "Hide details" : "Details"}
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`${name} details`}
                  aria-expanded={open}
                  data-testid="runtime-details-toggle"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setOpen((was) => !was)}
                />
              }
            >
              <ChevronRight
                aria-hidden
                className={cn("transition-transform", open && "rotate-90")}
              />
            </Hint>
          )}
        </span>
      </div>
      {runtime !== undefined && (
        <CliUpdatePanel
          runtime={runtime}
          step={runnable}
          state={update.state}
          confirming={confirming}
          onClose={() => setConfirming(false)}
        />
      )}
      {open && runtime !== undefined && (
        <AgentRuntimeDetails
          runtime={runtime}
          releasesCheckedAt={releasesCheckedAt}
          releasesUnavailable={releasesUnavailable}
          releasesChecking={releasesChecking}
        />
      )}
    </div>
  );
}
