import type { AgentRuntime, CliUpdateState, GatewayAgentTool, InstallStep } from "@gram/contracts";
import { CircleX, Download, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { agentLabel } from "@/agents/agent-display";
import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DrawnCheck, Spinner } from "@/motion";

import {
  cliUpdateStep,
  runningThreadsNote,
  updateLabel,
  updateOutcome,
} from "./agent-runtime-model";
import { CopyCommandButton } from "./agent-runtime-row";
import { CommandText } from "./command-text";
import { useAgentRuntimes, useCliUpdate } from "./use-agent-runtimes";

/** Update on an agent's row: opens the strip that shows what will run. */
export function CliUpdateButton({
  runtime,
  step,
  onClick,
}: {
  runtime: AgentRuntime;
  step: InstallStep;
  onClick: () => void;
}) {
  return (
    <Hint
      label={<CommandText text={`Run \`${step.command}\` for you, after you confirm`} />}
      render={<Button size="xs" variant="outline" data-testid="cli-update" onClick={onClick} />}
    >
      <Download aria-hidden />
      {updateLabel(runtime, step)}
    </Hint>
  );
}

/** The command's output so far, scrolled to its end as it grows. */
function Output({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const pre = ref.current;
    if (pre !== null && text !== "") pre.scrollTop = pre.scrollHeight;
  }, [text]);
  if (text === "") return null;
  return (
    <pre
      ref={ref}
      data-testid="cli-update-output"
      className="max-h-32 overflow-auto rounded-sm bg-muted px-2 py-1 font-mono text-[0.7rem] leading-4 wrap-break-word whitespace-pre-wrap text-muted-foreground"
    >
      {text}
    </pre>
  );
}

function CommandLine({ command }: { command: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <code className="min-w-0 truncate rounded-sm bg-muted px-1 font-mono">{command}</code>
      <CopyCommandButton command={command} />
    </div>
  );
}

/**
 * Under an agent's row: the command Update would run, to confirm or copy; then its output while it
 * runs, with Cancel; then how it went, the copy to run it by hand when it failed, and what threads
 * already running keep. Unrelated to the managed store, which the row's other Update drives.
 */
export function CliUpdatePanel({
  runtime,
  step,
  state,
  confirming,
  onClose,
}: {
  runtime: AgentRuntime;
  step: InstallStep | undefined;
  state: CliUpdateState | undefined;
  confirming: boolean;
  onClose: () => void;
}) {
  const api = useApi();
  const agent = runtime.agent;
  const name = agentLabel(agent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const act = async (what: string, run: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await run();
    } catch (e) {
      setError(`Couldn't ${what}: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const phase = state === undefined || state.state === "idle" ? "confirm" : state.state;
  if (phase === "confirm" && (!confirming || step === undefined)) return null;
  const note = runningThreadsNote(name, state);
  const close = () => {
    onClose();
    if (state !== undefined && state.state !== "idle" && state.state !== "running")
      void act("dismiss", () => api.cancelCliUpdate(agent));
  };

  return (
    <div
      data-testid="cli-update-panel"
      data-state={phase}
      className="ms-6 mt-1 mb-2 flex flex-col gap-1.5 rounded-md border border-border/60 p-2 text-xs"
    >
      {phase === "confirm" && step !== undefined && (
        <>
          <span className="text-muted-foreground">
            Gram runs this in your home folder, with your login-shell PATH and your own package
            manager settings:
          </span>
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0 flex-1">
              <CommandLine command={step.command} />
            </div>
            <Button
              size="xs"
              disabled={busy}
              data-testid="cli-update-run"
              onClick={() => void act("start the update", () => api.updateCli(agent, step.command))}
            >
              Run
            </Button>
            <Button size="xs" variant="ghost" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
          </div>
          {step.installer === "native" && runtime.resolved?.source === "path" && (
            <span className="text-muted-foreground" data-testid="cli-update-executable">
              {"as "}
              <span className="font-mono break-all">{runtime.resolved.path}</span>
            </span>
          )}
        </>
      )}
      {state?.state === "running" && (
        <>
          <div className="flex min-w-0 items-center gap-2">
            <Spinner aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span aria-live="polite" className="min-w-0 truncate">
              <CommandText text={`Running \`${state.command}\`…`} />
            </span>
            <Button
              size="xs"
              variant="ghost"
              className="ms-auto"
              disabled={busy}
              data-testid="cli-update-cancel"
              onClick={() => void act("cancel", () => api.cancelCliUpdate(agent))}
            >
              Cancel
            </Button>
          </div>
          <Output text={state.output} />
        </>
      )}
      {state?.state === "succeeded" && <Succeeded name={name} state={state} onClose={close} />}
      {state?.state === "failed" && (
        <>
          <div className="flex min-w-0 items-start gap-2">
            {state.problem === "cancelled" ? (
              <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
            ) : (
              <CircleX aria-hidden className="mt-0.5 size-3.5 shrink-0 text-destructive" />
            )}
            <span
              aria-live="polite"
              data-testid="cli-update-message"
              data-problem={state.problem}
              className="min-w-0"
            >
              <CommandText text={state.message} />
            </span>
            <DismissButton onClick={close} disabled={busy} />
          </div>
          <span className="text-muted-foreground">To run it yourself in a terminal:</span>
          <CommandLine command={state.command} />
          <Output text={state.output} />
        </>
      )}
      {note !== undefined && (
        <span data-testid="cli-update-threads" className="text-muted-foreground">
          {note}
        </span>
      )}
      {error !== undefined && <span className="text-destructive">{error}</span>}
    </div>
  );
}

function Succeeded({
  name,
  state,
  onClose,
}: {
  name: string;
  state: Extract<CliUpdateState, { state: "succeeded" }>;
  onClose: () => void;
}) {
  const outcome = updateOutcome(name, state);
  return (
    <div className="flex min-w-0 items-center gap-2">
      {outcome.tone === "success" ? (
        <DrawnCheck className="size-3.5 shrink-0 text-success" />
      ) : (
        <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-warning" />
      )}
      <span
        aria-live="polite"
        data-testid="cli-update-message"
        className={cn("min-w-0", outcome.tone === "warning" && "text-warning")}
      >
        {outcome.text}
      </span>
      <DismissButton onClick={onClose} />
    </div>
  );
}

function DismissButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <Button size="xs" variant="ghost" className="ms-auto" disabled={disabled} onClick={onClick}>
      Dismiss
    </Button>
  );
}

/**
 * Update on a launch-check line about an outdated agent: one click runs the step the Agents row's
 * Update runs, through the same `updateCli`. A spinner while it runs; on success the launch checks
 * are read again and the line goes; on failure the reason, with the command to copy.
 */
export function BannerCliUpdate({ agent }: { agent: GatewayAgentTool }) {
  const api = useApi();
  const { byAgent } = useAgentRuntimes();
  const { state } = useCliUpdate(agent);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();
  const step = cliUpdateStep(byAgent(agent));
  const name = agentLabel(agent);

  const start = async (command: string) => {
    setStarting(true);
    setError(undefined);
    try {
      await api.updateCli(agent, command);
    } catch (e) {
      setError(`Couldn't start the update: ${errorMessage(e)}`);
    } finally {
      setStarting(false);
    }
  };

  if (starting || state?.state === "running")
    return (
      <span
        aria-live="polite"
        data-testid="banner-cli-update"
        data-state="running"
        className="flex items-center gap-1 text-xs text-muted-foreground"
      >
        <Spinner aria-hidden className="size-3.5" />
        Updating…
      </span>
    );

  const updateButton = step !== undefined && (
    <Hint
      label={<CommandText text={`Run \`${step.command}\` for you`} />}
      render={
        <Button
          size="xs"
          variant="outline"
          aria-label={`Update ${name}`}
          data-testid="banner-cli-update-run"
          onClick={() => void start(step.command)}
        />
      }
    >
      <Download aria-hidden />
      Update
    </Hint>
  );
  const outcome = bannerOutcome(name, state, error);
  return (
    <>
      {updateButton}
      {outcome !== undefined && (
        <span
          aria-live="polite"
          data-testid="banner-cli-update"
          data-state={error === undefined ? state?.state : "refused"}
          className={cn("flex basis-full items-center gap-1 text-xs", OUTCOME_TONE[outcome.tone])}
        >
          <span className="min-w-0">
            <CommandText text={outcome.text} />
          </span>
          {state?.state === "failed" && <CopyCommandButton command={state.command} />}
        </span>
      )}
    </>
  );
}

const OUTCOME_TONE = {
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive",
} as const;

/** What a launch-check line says under its Update: a refusal, or how the last run went. */
function bannerOutcome(
  name: string,
  state: CliUpdateState | undefined,
  error: string | undefined,
): { readonly tone: "success" | "warning" | "error"; readonly text: string } | undefined {
  if (error !== undefined) return { tone: "error", text: error };
  if (state?.state === "succeeded") return updateOutcome(name, state);
  if (state?.state !== "failed") return undefined;
  // The output the server's message points below to is on the Agents row, not in the banner.
  if (state.problem === "failed")
    return {
      tone: "error",
      text: `\`${state.command}\` failed. Settings → Agents shows its output.`,
    };
  return { tone: state.problem === "cancelled" ? "warning" : "error", text: state.message };
}
