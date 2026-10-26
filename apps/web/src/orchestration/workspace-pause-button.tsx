import type { WorkspaceState } from "@gram/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Pause, Play } from "lucide-react";
import { useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TitlebarPopover } from "@/shell/titlebar-popover";
import { useThreadsStore } from "@/stores/threads";
import { inTurn, pauseClock, pauseConfirmText, pauseText } from "@/thread/orchestration-model";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";
import { useViewWorkspace } from "@/views/view-workspace";

import { setWorkspacePaused } from "./pause-workspace";
import { midTurnWorkers, orchestratorOf } from "./tree-model";

const PAUSE_HINT =
  "Pause the workspace: the orchestrator and its workers finish the step they're on and stop, and nothing wakes them until you resume";

/**
 * Pause or Resume the workspace's orchestration, one click each. A pause with work mid-flight asks
 * first, in a line under the button, since it stops that work; resuming never asks. Paused, it says
 * since when.
 */
function WorkspacePauseButton({
  state,
  testId,
  compact = false,
  className,
}: {
  state: WorkspaceState;
  testId: string;
  /** The title bar's: an icon until paused, then a short "Paused 14:02". */
  compact?: boolean;
  className?: string | undefined;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { workspace, paused } = state;
  const working = useThreadsStore((s) => midTurnWorkers(s.byId, workspace.id));
  const orchestratorWorking = useThreadsStore((s) =>
    inTurn(orchestratorOf(Object.values(s.byId), workspace)?.status),
  );
  const confirm = pauseConfirmText(working, orchestratorWorking);

  const run = (next: boolean) => {
    setConfirming(false);
    setBusy(true);
    setWorkspacePaused(api, queryClient, workspace, next)
      .catch((error: unknown) =>
        useThreadDialogs
          .getState()
          .fail(`Couldn't ${next ? "pause" : "resume"} the workspace: ${errorMessage(error)}`),
      )
      .finally(() => setBusy(false));
  };

  if (paused !== undefined) {
    const label = `${pauseText(paused)} since ${pauseClock(paused.at)}. Resume orchestration`;
    return (
      <Hint
        label={label}
        side="bottom"
        render={
          <Button
            size={compact ? "xs" : "sm"}
            variant="ghost"
            data-testid={testId}
            data-paused=""
            aria-label={label}
            disabled={busy}
            className={cn("tabular-nums", compact && "text-status-needs", className)}
            onClick={() => run(false)}
          />
        }
      >
        <Play data-icon="inline-start" className="text-status-needs" />
        {compact ? `Paused ${pauseClock(paused.at)}` : "Resume"}
      </Hint>
    );
  }

  const trigger = (
    <Button
      size={compact ? "icon-xs" : "sm"}
      variant="ghost"
      data-testid={testId}
      aria-label="Pause"
      disabled={busy}
      className={cn("text-muted-foreground hover:text-foreground", className)}
      onClick={confirm === undefined ? () => run(true) : undefined}
    >
      <Pause data-icon={compact ? undefined : "inline-start"} aria-hidden />
      {compact ? null : "Pause"}
    </Button>
  );
  if (confirm === undefined) {
    return <Hint label={PAUSE_HINT} side="bottom" render={trigger} />;
  }
  return (
    <TitlebarPopover
      trigger={trigger}
      label="Pause the workspace"
      testId={`${testId}-confirm`}
      open={confirming}
      onOpenChange={setConfirming}
      className="flex w-72 flex-col gap-2 p-3 text-xs"
    >
      <p className="font-medium text-foreground">Pause {workspace.name}?</p>
      <p className="text-muted-foreground">{confirm}</p>
      <div className="flex justify-end gap-2">
        <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
        <Button
          size="xs"
          variant="default"
          data-testid={`${testId}-confirm-pause`}
          onClick={() => run(true)}
        >
          <Pause data-icon="inline-start" />
          Pause
        </Button>
      </div>
    </TitlebarPopover>
  );
}

/** The title bar's Pause or Resume, beside Tidy up, for the workspace the window is on. */
export function TitlebarPause({ className }: { className?: string }) {
  const state = useViewWorkspace();
  if (state === undefined) return null;
  return (
    <WorkspacePauseButton
      key={state.workspace.id}
      state={state}
      testId="titlebar-pause"
      compact
      className={className}
    />
  );
}
