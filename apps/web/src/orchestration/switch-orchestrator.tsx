import { type ModelRef, type SessionSwitch, type Thread, type WorkspaceId } from "@gram/contracts";
import { useState } from "react";

import { agentLabel } from "@/agents/agent-display";
import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { AgentFields, choiceModel, type AgentChoice } from "@/composer/agent-fields";
import { useModelsSettled } from "@/composer/models";
import { useThreadsStore } from "@/stores/threads";
import { DialogShell } from "@/thread/dialog-shell";

const name = (model: ModelRef) =>
  `${agentLabel(model.agent)} · ${model.model}${model.variant ? ` · ${model.variant}` : ""}`;

export const switchStatusText = (change: SessionSwitch): string => {
  switch (change.phase) {
    case "checkpoint":
      return "Waiting for current work and questions to finish, then saving workspace memory. Your current orchestrator is still selected.";
    case "retry":
      return "Retrying the saved switch. Queued messages stay held until the selected session is ready.";
    case "stopping":
      return "Waiting for the previous session to stop. The requested orchestrator has not started.";
    case "starting":
      return "The previous session has stopped. Waiting for the requested orchestrator to confirm it has started.";
    case "ready":
      return "The requested orchestrator has connected. Preparing its workspace context before releasing queued messages.";
    case "failed":
      return change.oldExited
        ? "The previous session has stopped. The switch did not complete; no fallback or automatic retry was started."
        : "The switch did not complete. The previous session's exit is not confirmed; no replacement was started.";
  }
};

export const switchCurrentText = (
  thread: Pick<Thread, "model" | "sessionSwitch">,
  reportedModel?: string,
): string => {
  const change = thread.sessionSwitch;
  if (change?.phase === "stopping") return `Waiting for ${name(change.previous)} to stop`;
  if (change?.phase === "starting")
    return `Previous session stopped · starting ${name(change.target)}`;
  if (change?.phase === "ready") return `Connected: ${name(change.target)}`;
  if (change?.phase === "retry") return "Checking the previous session before retrying";
  if (change?.phase === "failed")
    return change.oldExited
      ? "Previous session stopped · requested session not adopted"
      : `Previous exit unconfirmed · ${name(change.previous)}`;
  return name(
    reportedModel === undefined ? thread.model : { ...thread.model, model: reportedModel },
  );
};

/** What opens the switch: "View orchestrator switch…" while one is under way. */
export const switchOpenLabel = (thread: Pick<Thread, "sessionSwitch">): string =>
  thread.sessionSwitch === undefined ? "Switch orchestrator…" : "View orchestrator switch…";

/** The workspace settings' Models row: the current orchestrator, and the way to switch it. */
export function SwitchOrchestratorAction({
  thread,
  workspaceId,
  disabled = false,
}: {
  thread: Thread;
  workspaceId: WorkspaceId;
  disabled?: boolean;
}) {
  const current = useThreadsStore((state) => state.byId[thread.id]?.thread) ?? thread;
  const identity = useThreadsStore((state) => state.byId[thread.id]?.identity);
  const [open, setOpen] = useState(false);
  return (
    <>
      <div
        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3"
        data-testid="orchestrator-switch-action"
      >
        <div className="text-xs">
          <p className="font-medium">Current orchestrator</p>
          <p data-testid="orchestrator-current" className="mt-1 text-muted-foreground">
            {switchCurrentText(current, identity?.model)}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => setOpen(true)}
          data-testid="switch-orchestrator-open"
        >
          {switchOpenLabel(current)}
        </Button>
      </div>
      {open && (
        <SwitchOrchestratorDialog
          thread={thread}
          workspaceId={workspaceId}
          disabled={disabled}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/**
 * The switch itself: pick a harness and model, then save memory and switch; or, while a switch is
 * under way, where it stands. Opened from the workspace settings and the orchestrator's ⋯ menu.
 */
export function SwitchOrchestratorDialog({
  thread,
  workspaceId,
  disabled = false,
  onClose,
}: {
  thread: Thread;
  workspaceId: WorkspaceId;
  disabled?: boolean;
  onClose: () => void;
}) {
  const api = useApi();
  const current = useThreadsStore((state) => state.byId[thread.id]?.thread) ?? thread;
  const identity = useThreadsStore((state) => state.byId[thread.id]?.identity);
  const change = current.sessionSwitch;
  const [choice, setChoice] = useState<AgentChoice>(() => ({
    agent: current.model.agent,
    model: current.model.model,
    ...(current.model.variant === undefined ? {} : { variant: current.model.variant }),
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const catalog = useModelsSettled(choice.agent, true);
  const listed = catalog.models?.find(
    (model) => model.id === choice.model || model.resolvedId === choice.model,
  );
  const known =
    listed !== undefined &&
    listed.description !== "Added in Settings" &&
    listed.warning === undefined;
  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await run();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <DialogShell testId="switch-orchestrator-dialog" title="Switch orchestrator" onClose={onClose}>
      {change === undefined ? (
        <>
          <p className="text-xs text-muted-foreground">
            Current: <span data-testid="switch-current-model">{name(current.model)}</span>
            {identity?.model && identity.model !== current.model.model
              ? ` (CLI reports ${identity.model})`
              : ""}
          </p>
          <div className="flex flex-wrap gap-2" data-testid="switch-target-fields">
            <AgentFields value={choice} onChange={setChoice} subscriptionOnly />
          </div>
          <p className="text-xs text-muted-foreground" data-testid="switch-model-availability">
            {known
              ? "Listed by your installed CLI. Availability still depends on your account."
              : catalog.settled
                ? "Custom or unverified model ID. The exact ID will be sent; account availability is not verified."
                : "Checking the installed CLI's model list…"}
          </p>
          <p className="text-sm">
            The current orchestrator finishes its work and questions, then saves workspace memory
            and stops. The selected harness starts a fresh session on this thread using memory and
            the current ledger. Earlier messages stay visible here; the full provider conversation
            is not transferred.
          </p>
          <p className="text-xs text-muted-foreground">
            Queued messages wait for the new session's workspace context. Worker models, open
            decisions and workspace pauses stay in place. After success, this selection also becomes
            the workspace's preference for future orchestrators.
          </p>
        </>
      ) : (
        <div className="flex flex-col gap-3" data-testid="orchestrator-switch-status">
          <p className="text-xs text-muted-foreground">Previous: {name(change.previous)}</p>
          <p className="text-sm font-medium">Requested: {name(change.target)}</p>
          <p role="status" className="text-sm">
            {switchStatusText(change)}
          </p>
          {change.detail && (
            <p role="alert" className="text-xs text-destructive">
              {change.detail}
            </p>
          )}
          {change.phase === "failed" && (
            <p className="text-xs text-muted-foreground">
              History, workers, decisions and queued messages are retained.{" "}
              {change.targetRelease === "notStarted"
                ? "The target never started a session. Resolve the startup error, then retry safely."
                : change.targetRelease === "exited"
                  ? "The failed target has stopped. Resolve the startup error, then retry safely."
                  : "Resolve the previous session before opening another orchestrator. An unknown owner cannot be replaced safely."}
            </p>
          )}
        </div>
      )}
      {error !== undefined && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
        {change === undefined && (
          <Button
            size="sm"
            disabled={disabled || busy || choice.model === "" || !catalog.settled}
            data-testid="switch-orchestrator-confirm"
            onClick={() => void act(() => api.switchOrchestrator(workspaceId, choiceModel(choice)))}
          >
            {busy ? "Checking…" : "Save memory and switch"}
          </Button>
        )}
        {change?.phase === "failed" && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void act(() => api.retryOrchestratorSwitch(workspaceId))}
          >
            Retry switch safely
          </Button>
        )}
        {change?.phase === "checkpoint" && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void act(() => api.cancelOrchestratorSwitch(workspaceId))}
          >
            Cancel switch
          </Button>
        )}
      </div>
    </DialogShell>
  );
}
