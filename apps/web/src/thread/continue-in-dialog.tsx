import {
  autonomyOf,
  type AgentKind,
  type ModelRef,
  type ReasoningVariant,
  type ThreadId,
} from "@gram/contracts";
import { Check, Clock, GitPullRequest, Layers, Lock, TriangleAlert, Users, X } from "lucide-react";
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
import { ModelsAllowedBy, useModels } from "@/composer/models";
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
  FRESH_CARRIES_LINE,
  FRESH_ORCHESTRATOR_LINE,
  FRESH_STAYS_LINE,
  freshLabel,
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
import { SaveFirst } from "@/orchestration/fresh-session";

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

type ContinueInProps = {
  threadId: ThreadId;
  model?: string | undefined;
  onClose: () => void;
};

/** The sheet, offering only the models the thread's profile lets it run. */
export function ContinueInDialog(props: ContinueInProps) {
  const profile = useThreadsStore((s) => s.byId[props.threadId]?.thread.profile);
  return (
    <ModelsAllowedBy profile={profile}>
      <ContinueInSheet {...props} />
    </ModelsAllowedBy>
  );
}

function ContinueInSheet({ threadId, model: picked, onClose }: ContinueInProps) {
  const api = useApi();
  const summary = useThreadsStore((s) => s.byId[threadId]);
  const offer = useSwitchOffer(threadId);
  const { checks } = useLaunchChecks();
  const workspaces = useWorkspaces();
  const thread = summary?.thread;
  const workspaceId = thread?.role === "orchestrator" ? thread.workspaceId : undefined;
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
  const [sent, setSent] = useState(
    () => workspaceId !== undefined && thread?.sessionSwitch !== undefined,
  );

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
  const fresh = offer.offered && !sent ? offer.fresh : undefined;
  const title = fresh === undefined ? continueLabel(to) : freshLabel(to);

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
    if (fresh !== undefined)
      return act(async () => {
        await (workspaceId === undefined
          ? api.startFreshOn(threadId, choice)
          : api.orchestratorHandoff(workspaceId, { checkpoint: note, model: choice }));
        onClose();
      }, false);
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
                    if (next !== null) pickEffort(next);
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
          {fresh !== undefined ? (
            <div className="flex flex-col gap-2">
              <Line
                testId="continue-in-fresh"
                hint="Why a fresh session"
                glyph={<TriangleAlert aria-hidden className="size-icon-row" />}
              >
                This session can't carry over to {AGENT_SHORT[to]}, so it starts a fresh one in this
                thread. <span className="text-muted-foreground">{fresh}</span>
              </Line>
              <Line
                testId="continue-in-carries"
                hint={`What ${AGENT_SHORT[to]} gets`}
                className="text-success"
                glyph={<Check aria-hidden className="size-icon-row" />}
              >
                {orchestrator ? FRESH_ORCHESTRATOR_LINE : FRESH_CARRIES_LINE}
              </Line>
              <Line
                testId="continue-in-stays"
                hint="This conversation"
                glyph={<Layers aria-hidden className="size-icon-row" />}
              >
                {FRESH_STAYS_LINE}
              </Line>
              <Line
                testId="continue-in-leaves"
                hint="What doesn't carry over"
                glyph={<X aria-hidden className="size-icon-row" />}
              >
                {leavesLine(from)}
              </Line>
              {orchestrator && <SaveFirst checked={note} onChange={setNote} />}
            </div>
          ) : (
            <>
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
            {fresh === undefined ? "Continue" : "Start fresh"}
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
