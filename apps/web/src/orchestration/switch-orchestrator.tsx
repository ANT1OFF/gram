import { type ModelRef, type SessionSwitch, type Thread } from "@gram/contracts";

import { agentLabel } from "@/agents/agent-display";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { useThreadsStore } from "@/stores/threads";
import { continueLabel } from "@/thread/agent-switch-model";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";
import { useSwitchOffer } from "@/thread/use-switch-offer";

const name = (model: ModelRef) =>
  `${agentLabel(model.agent)} · ${model.model}${model.variant ? ` · ${model.variant}` : ""}`;

/** Where a switch of this thread's agent stands, in words for any thread, the orchestrator's included. */
export const switchStatusText = (change: SessionSwitch): string => {
  switch (change.phase) {
    case "checkpoint":
      return "Waiting for current work and questions to finish, then writing what this thread carries over. Its current agent is still selected.";
    case "retry":
      return "Retrying the saved switch. Queued messages stay held until this thread's new session is ready.";
    case "stopping":
      return "Waiting for the previous session to stop. This thread's new session has not started.";
    case "starting":
      return "The previous session has stopped. Waiting for this thread's new session to confirm it has started.";
    case "ready":
      return "This thread's new session has connected. Giving it the handoff before releasing queued messages.";
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

/**
 * The workspace settings' Models row: the current orchestrator, and "Continue in Codex…" (or
 * "…in Claude Code…"), which opens the same sheet as the thread's menu. Offered as it is there:
 * with the other CLI installed, greyed with the server's words when it can't move; while a switch
 * is under way, it opens on how it stands.
 */
export function SwitchOrchestratorAction({
  thread,
  disabled = false,
}: {
  thread: Thread;
  disabled?: boolean;
}) {
  const current = useThreadsStore((state) => state.byId[thread.id]?.thread) ?? thread;
  const identity = useThreadsStore((state) => state.byId[thread.id]?.identity);
  const offer = useSwitchOffer(thread.id);
  const open = () => useThreadDialogs.getState().open({ kind: "continueIn", threadId: thread.id });
  const button = (refusal: string | undefined) => (
    <Button
      size="sm"
      variant="outline"
      disabled={disabled || refusal !== undefined}
      aria-description={refusal}
      onClick={open}
      data-testid="switch-orchestrator-open"
    >
      {offer.offered ? `${continueLabel(offer.to)}…` : ""}
    </Button>
  );
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3"
      data-testid="orchestrator-switch-action"
    >
      <div className="text-meta">
        <p className="font-medium">Current orchestrator</p>
        <p data-testid="orchestrator-current" className="mt-1 text-muted-foreground">
          {switchCurrentText(current, identity?.model)}
        </p>
      </div>
      {offer.offered &&
        (offer.refusal === undefined ? (
          button(undefined)
        ) : (
          // Greyed, it says why on hover, in the words the server would refuse with.
          <Hint label={offer.refusal} side="bottom" render={<span tabIndex={0} />}>
            {button(offer.refusal)}
          </Hint>
        ))}
    </div>
  );
}
