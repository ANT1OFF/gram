import {
  autonomyOf,
  type AgentKind,
  type ModelRef,
  type ReasoningVariant,
  type ThreadId,
} from "@gram/contracts";
import { Check, Clock, GitPullRequest, Lock, Users, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { AgentIcon } from "@/agents/agent-display";
import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Hint } from "@/components/hint";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useModels } from "@/composer/models";
import { EFFORT_OPTIONS } from "@/composer/options";
import { useLaunchChecks } from "@/launch-checks/use-launch-checks";
import { cn } from "@/lib/utils";
import { switchStatusText } from "@/orchestration/switch-orchestrator";
import { useWorkspaces } from "@/orchestration/use-orchestration";
import { useThreadsStore } from "@/stores/threads";

import {
  AGENT_SHORT,
  carriesLine,
  continueLabel,
  defaultTarget,
  leavesLine,
  limitLine,
  modeLine,
  ORCHESTRATOR_LINE,
  orchestratorCarriesLine,
  otherAgent,
  sheetEfforts,
  switchLimitOf,
  WORKER_LINE,
} from "./agent-switch-model";
import { DialogShell } from "./dialog-shell";
import { useSwitchOffer } from "./use-switch-offer";

/** One of the sheet's lines: its glyph, whose words are on hover, then the line. */
function Line({
  glyph,
  hint,
  testId,
  className,
  children,
}: {
  glyph: ReactNode;
  hint: string;
  testId: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div data-testid={testId} className="flex items-start gap-2 text-reading">
      <Hint
        label={hint}
        render={
          <span
            role="img"
            tabIndex={0}
            aria-label={hint}
            className={cn(
              "flex h-lh shrink-0 items-center rounded-sm text-muted-foreground outline-none focus-visible:focus-ring",
              className,
            )}
          />
        }
      >
        {glyph}
      </Hint>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/**
 * "Continue in Codex" (or Claude Code): the confirm sheet for moving a thread, a worker or the
 * orchestrator to the other agent, from the choices chip's other-agent group, the thread's "…" menu
 * or, for the orchestrator, Settings → Workspaces. Its model and effort (up to High), what carries
 * over and what doesn't, the note checkbox (limit mode's line in its place), a worker's or the
 * orchestrator's line and the mode line when the mode changes. Nothing changes until Continue; then
 * it says where the switch stands, and closes once the thread is on its new agent. The
 * orchestrator's switch saves memory first, and while one is under way the sheet opens on how it
 * stands, with Cancel switch before the old session stops and Retry once it has failed.
 */
export function ContinueInDialog({
  threadId,
  model: picked,
  onClose,
}: {
  threadId: ThreadId;
  /** The model picked in the chip's group; absent, §3.5's default target. */
  model?: string | undefined;
  onClose: () => void;
}) {
  const api = useApi();
  const summary = useThreadsStore((s) => s.byId[threadId]);
  const offer = useSwitchOffer(threadId);
  const { checks } = useLaunchChecks();
  const workspaces = useWorkspaces();
  const thread = summary?.thread;
  // The orchestrator's goes through its workspace: its checkpoint saves memory and writes the note.
  const workspaceId = thread?.role === "orchestrator" ? thread.workspaceId : undefined;
  // Fixed as the sheet opens: once the switch lands, the thread's agent is the target. One under
  // way (an orchestrator's, opened again) is read from its claim.
  const [from] = useState<AgentKind>(
    () => thread?.sessionSwitch?.previous.agent ?? thread?.model.agent ?? "claude",
  );
  const [to] = useState<AgentKind>(() => thread?.sessionSwitch?.target.agent ?? otherAgent(from));
  const models = useModels(to);
  const current = useModels(from);
  const [choice, setChoice] = useState<ModelRef>();
  const [note, setNote] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // An orchestrator's switch already under way opens on how it stands.
  const [sent, setSent] = useState(
    () => workspaceId !== undefined && thread?.sessionSwitch !== undefined,
  );

  // Preselected once the target's models are in: the pick, else the default target.
  const listed = models ?? [];
  const target = (model: string | undefined) =>
    thread === undefined
      ? undefined
      : defaultTarget({
          current: thread.model,
          to,
          models: listed,
          currentModels: current,
          picked: model,
        });
  if (choice === undefined && listed.length > 0) {
    const start = target(picked);
    if (start !== undefined) setChoice(start);
  }
  // Done: the switch went through and the thread is on its new agent.
  const landed =
    sent && thread !== undefined && thread.sessionSwitch === undefined && thread.model.agent === to;
  useEffect(() => {
    if (landed) onClose();
  }, [landed, onClose]);

  if (thread === undefined || summary === undefined) return null;
  const change = thread.sessionSwitch;
  const limit = switchLimitOf(summary);
  const worker = thread.spawnedBy !== undefined;
  const orchestrator = workspaceId !== undefined;
  const workspace = workspaces.find((each) => each.workspace.id === thread.workspaceId);
  const gated =
    (worker || orchestrator) && workspace !== undefined && autonomyOf(workspace.charter) !== "full";
  const codexVersion = checks?.tools.find((tool) => tool.tool === "codex")?.version;
  const mode = modeLine({ mode: thread.mode, to, worker, orchestrator, gated, codexVersion });
  const efforts = choice === undefined ? [] : sheetEfforts(models, choice.model);
  const effortItems = EFFORT_OPTIONS.filter((option) => efforts.includes(option.value)).map(
    (option) => ({ value: option.value, label: option.short ?? option.label }),
  );
  const modelItems = listed.map((m) => ({ value: m.id, label: m.displayName }));
  const refusal = offer.offered ? offer.refusal : undefined;
  const title = continueLabel(to);

  const pickModel = (id: string) => setChoice(target(id) ?? choice);
  const pickEffort = (variant: ReasoningVariant) =>
    setChoice((was) => (was === undefined ? was : { ...was, variant }));

  const act = async (run: () => Promise<unknown>, after: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      await run();
      setSent(after);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const confirm = () => {
    if (choice === undefined) return;
    const options = limit === undefined ? { note } : {};
    return act(
      () =>
        workspaceId === undefined
          ? api.switchAgent(threadId, choice, options)
          : api.switchOrchestrator(workspaceId, choice, options),
      true,
    );
  };

  return (
    <DialogShell testId="continue-in-dialog" title={title} onClose={onClose}>
      {change !== undefined && sent ? (
        <div className="flex flex-col gap-2">
          <p role="status" data-testid="continue-in-status" className="text-reading">
            {switchStatusText(change)}
          </p>
          {orchestrator && change.detail !== undefined && (
            <p role="alert" className="text-meta text-destructive">
              {change.detail}
            </p>
          )}
          {orchestrator && change.phase === "failed" && (
            <p className="text-meta text-muted-foreground">
              History, workers, decisions and queued messages are kept.{" "}
              {change.targetRelease === undefined
                ? "Resolve the previous session before opening another orchestrator: an unknown owner can't be replaced safely."
                : "Resolve the startup error, then retry safely."}
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-0 flex-col gap-1 text-meta text-muted-foreground">
              Model
              <Select
                value={choice?.model ?? null}
                items={modelItems}
                onValueChange={(next) => {
                  if (next !== null) pickModel(next);
                }}
              >
                <SelectTrigger
                  aria-label="Model"
                  data-testid="continue-in-model"
                  className="min-w-44"
                >
                  <AgentIcon agent={to} className="size-icon-row" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {modelItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            {effortItems.length > 0 && (
              <label className="flex flex-col gap-1 text-meta text-muted-foreground">
                Effort
                <Select
                  value={choice?.variant ?? null}
                  items={effortItems}
                  onValueChange={(next) => {
                    if (next !== null) pickEffort(next as ReasoningVariant);
                  }}
                >
                  <SelectTrigger
                    aria-label="Effort"
                    data-testid="continue-in-effort"
                    className="min-w-28"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {effortItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            )}
          </div>
          <div className="flex flex-col gap-2">
            {limit !== undefined && (
              <Line
                testId="continue-in-limit"
                hint={`${AGENT_SHORT[from]}'s usage`}
                glyph={<Clock aria-hidden className="size-icon-row" />}
              >
                {limitLine(limit, from, to)}
              </Line>
            )}
            <Line
              testId="continue-in-carries"
              hint={`What ${AGENT_SHORT[to]} gets`}
              className="text-success"
              glyph={<Check aria-hidden className="size-icon-row" />}
            >
              {orchestrator
                ? orchestratorCarriesLine(from, note, limit !== undefined)
                : carriesLine(from, note, limit !== undefined)}
            </Line>
            <Line
              testId="continue-in-leaves"
              hint="What doesn't carry over"
              glyph={<X aria-hidden className="size-icon-row" />}
            >
              {leavesLine(from)}
            </Line>
            {orchestrator && (
              <Line
                testId="continue-in-orchestrator"
                hint="Its workers and model"
                glyph={<Users aria-hidden className="size-icon-row" />}
              >
                {ORCHESTRATOR_LINE}
              </Line>
            )}
            {worker && (
              <Line
                testId="continue-in-worker"
                hint="This worker's pull request"
                glyph={<GitPullRequest aria-hidden className="size-icon-row" />}
              >
                {WORKER_LINE}
              </Line>
            )}
            {mode !== undefined && (
              <Line
                testId="continue-in-mode"
                hint="Mode changes"
                className="text-warning"
                glyph={<Lock aria-hidden className="size-icon-row" />}
              >
                {mode}
              </Line>
            )}
          </div>
          {limit === undefined && (
            <label className="flex items-center gap-2 text-reading">
              <input
                type="checkbox"
                data-testid="continue-in-note"
                checked={note}
                onChange={(event) => setNote(event.target.checked)}
              />
              Ask {AGENT_SHORT[from]} for a handoff note first
            </label>
          )}
        </>
      )}
      {(error ?? (sent ? undefined : refusal)) !== undefined && (
        <p role="alert" className="text-meta text-destructive">
          {error ?? refusal}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose}>
          {sent ? "Close" : "Cancel"}
        </Button>
        {!sent && (
          <Button
            size="sm"
            data-testid="continue-in-confirm"
            disabled={busy || choice === undefined || refusal !== undefined}
            onClick={() => void confirm()}
          >
            Continue
          </Button>
        )}
        {sent && workspaceId !== undefined && change?.phase === "checkpoint" && (
          <Button
            size="sm"
            variant="outline"
            data-testid="continue-in-cancel-switch"
            disabled={busy}
            onClick={() => void act(() => api.cancelOrchestratorSwitch(workspaceId), false)}
          >
            Cancel switch
          </Button>
        )}
        {sent && workspaceId !== undefined && change?.phase === "failed" && (
          <Button
            size="sm"
            data-testid="continue-in-retry-switch"
            disabled={busy}
            onClick={() => void act(() => api.retryOrchestratorSwitch(workspaceId), true)}
          >
            Retry switch safely
          </Button>
        )}
      </div>
    </DialogShell>
  );
}
