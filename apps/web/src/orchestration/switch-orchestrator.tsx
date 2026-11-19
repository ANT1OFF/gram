import {
  type ModelRef,
  type SessionSwitch,
  type Thread,
  type WorkspaceState,
} from "@gram/contracts";
import { Check, Layers, TriangleAlert, X } from "lucide-react";
import { useState } from "react";

import { agentLabel } from "@/agents/agent-display";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { modelDisplayName, useModels } from "@/composer/models";
import { useThreadsStore } from "@/stores/threads";
import { continueLabel, leavesLine } from "@/thread/agent-switch-model";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";
import { useSwitchOffer } from "@/thread/use-switch-offer";

import { HandingOff, SaveFirst } from "./fresh-session";
import { useHandoff } from "./use-board-actions";

const name = (model: ModelRef) =>
  `${agentLabel(model.agent)} · ${model.model}${model.variant ? ` · ${model.variant}` : ""}`;

const savedDiffers = (saved: ModelRef, running: ModelRef) =>
  saved.agent !== running.agent ||
  saved.model !== running.model ||
  (saved.variant !== undefined && saved.variant !== running.variant);

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
  state,
  saved,
  disabled = false,
}: {
  thread: Thread;
  /** The orchestrator's workspace, whose fresh session it starts where a switch can't move it. */
  state?: WorkspaceState | undefined;
  /** The model the workspace's settings name for its orchestrator, when one of its own. */
  saved?: ModelRef | undefined;
  disabled?: boolean;
}) {
  const current = useThreadsStore((s) => s.byId[thread.id]?.thread) ?? thread;
  const identity = useThreadsStore((s) => s.byId[thread.id]?.identity);
  const offer = useSwitchOffer(thread.id);
  const pending =
    saved !== undefined && current.sessionSwitch === undefined && savedDiffers(saved, current.model)
      ? saved
      : undefined;
  // Continue in… carries this session over only to the other agent, on the CLI's own sign-in.
  const carries =
    pending !== undefined &&
    offer.offered &&
    offer.refusal === undefined &&
    offer.to === pending.agent &&
    pending.profileId === undefined &&
    current.model.profileId === undefined;
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
    // A row of the card like the settings under it: a frame of its own inside the card read as a
    // different kind of thing, in smaller type than the names below.
    <div
      className="flex flex-wrap items-center justify-between gap-2"
      data-testid="orchestrator-switch-action"
    >
      <div>
        <p className="font-medium">Current orchestrator</p>
        <p data-testid="orchestrator-current" className="text-meta text-description">
          {switchCurrentText(current, identity?.model)}
        </p>
        {/* A saved model the running session isn't on: saving doesn't move it, so say what does. */}
        {pending !== undefined && (
          <p data-testid="orchestrator-saved" className="text-meta text-description">
            Saved: {name(pending)}. The running session stays on {current.model.model}
            {carries ? `; ${continueLabel(offer.to)}… moves it.` : " until it starts fresh on it."}
          </p>
        )}
      </div>
      {pending !== undefined && !carries && state !== undefined ? (
        <StartFreshOn
          state={state}
          running={current}
          onto={pending}
          why={offer.offered ? offer.refusal : undefined}
          disabled={disabled}
        />
      ) : (
        offer.offered &&
        (offer.refusal === undefined ? (
          button(undefined)
        ) : (
          // Greyed, it says why on hover, in the words the server would refuse with.
          <Hint label={offer.refusal} side="bottom" render={<span tabIndex={0} />}>
            {button(offer.refusal)}
          </Hint>
        ))
      )}
    </div>
  );
}

/**
 * Start fresh on the saved model, where the running session can't carry over to it: a button that
 * opens in place what happens (why not a carry-over, what the new session gets, what stays and what
 * is lost), Save to memory first, and the one action that starts it.
 */
function StartFreshOn({
  state,
  running,
  onto,
  why,
  disabled,
}: {
  state: WorkspaceState;
  running: Thread;
  onto: ModelRef;
  /** The server's words for why this session can't move there, where it said. */
  why: string | undefined;
  disabled: boolean;
}) {
  const handoff = useHandoff(state);
  const models = useModels(onto.agent);
  const [open, setOpen] = useState(false);
  const [saveFirst, setSaveFirst] = useState(true);
  const model = modelDisplayName(models, onto.agent, onto.model);
  const action = `Start fresh on ${model}`;
  if (handoff.running) return <HandingOff savingFirst={handoff.savingFirst} />;
  if (!open)
    return (
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || !handoff.available}
        onClick={() => {
          setSaveFirst(true);
          setOpen(true);
        }}
        data-testid="start-fresh-on-open"
      >
        {action}
      </Button>
    );
  const line = "grid grid-cols-[1rem_1fr] items-start gap-2";
  const icon = "mt-0.5 size-icon-row text-muted-foreground";
  return (
    <div
      data-testid="start-fresh-on"
      className="flex w-full flex-col gap-3 rounded-lg border border-edge bg-muted/40 p-3 text-meta"
    >
      <div className="flex flex-col gap-2">
        <p className={line}>
          <TriangleAlert aria-hidden className={icon} />
          <span>
            This session can't carry over to {agentLabel(onto.agent)} · {model}, so it starts a
            fresh one in the same thread.
            {why !== undefined && <span className="block text-muted-foreground">{why}</span>}
          </span>
        </p>
        <p className={line}>
          <Check aria-hidden className="mt-0.5 size-icon-row text-success" />
          <span>Memory, the charter and the ledger carry over. Workers keep running.</span>
        </p>
        <p className={line}>
          <Layers aria-hidden className={icon} />
          <span>This conversation stays in the thread, above a divider.</span>
        </p>
        <p className={line}>
          <X aria-hidden className={icon} />
          <span>{leavesLine(running.model.agent)}</span>
        </p>
      </div>
      <SaveFirst checked={saveFirst} onChange={setSaveFirst} />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Not now
        </Button>
        <Button
          size="sm"
          data-testid="start-fresh-on-start"
          disabled={disabled || !handoff.available}
          onClick={() => {
            setOpen(false);
            void handoff.start({ checkpoint: saveFirst, model: onto });
          }}
        >
          {action}
        </Button>
      </div>
    </div>
  );
}
