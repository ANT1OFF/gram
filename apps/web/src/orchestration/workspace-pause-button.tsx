import type { WorkspaceState } from "@gram/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useThreadsStore } from "@/stores/threads";
import { inTurn, pauseClock, pauseConfirmText, pauseText } from "@/thread/orchestration-model";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";
import { useViewWorkspace } from "@/views/view-workspace";

import { setWorkspacePaused } from "./pause-workspace";
import { midTurnWorkers, orchestratorOf } from "./tree-model";

/**
 * Pausing or resuming `state`'s workspace: `confirm` says what a pause stops while work is
 * mid-flight, to ask first; resuming never asks. Failures show in the thread dialogs' error line.
 */
export function useWorkspacePause(state: WorkspaceState): {
  busy: boolean;
  confirm: string | undefined;
  run: (pause: boolean) => void;
} {
  const api = useApi();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const { workspace } = state;
  const working = useThreadsStore((s) => midTurnWorkers(s.byId, workspace.id));
  const orchestratorWorking = useThreadsStore((s) =>
    inTurn(orchestratorOf(Object.values(s.byId), workspace)?.status),
  );
  const confirm = pauseConfirmText(working, orchestratorWorking);
  const run = (next: boolean) => {
    setBusy(true);
    setWorkspacePaused(api, queryClient, workspace, next)
      .catch((error: unknown) =>
        useThreadDialogs
          .getState()
          .fail(`Couldn't ${next ? "pause" : "resume"} the workspace: ${errorMessage(error)}`),
      )
      .finally(() => setBusy(false));
  };
  return { busy, confirm, run };
}

/**
 * The title bar's "Paused 14:02", for the workspace the window is on, while it is paused: a click
 * resumes it. Pausing is in the bar's "…", so a running workspace shows nothing here.
 */
export function TitlebarPause({ className }: { className?: string }) {
  const state = useViewWorkspace();
  if (state?.paused === undefined) return null;
  return <PausedPill key={state.workspace.id} state={state} className={className} />;
}

function PausedPill({ state, className }: { state: WorkspaceState; className?: string }) {
  const { busy, run } = useWorkspacePause(state);
  const paused = state.paused!;
  const label = `${pauseText(paused)} since ${pauseClock(paused.at)}. Resume orchestration`;
  return (
    <Hint
      label={label}
      side="bottom"
      render={
        <Button
          size="xs"
          variant="ghost"
          data-testid="titlebar-pause"
          data-paused=""
          aria-label={label}
          disabled={busy}
          className={cn("tabular-nums", className)}
          onClick={() => run(false)}
        />
      }
    >
      <Play data-icon="inline-start" />
      Paused {pauseClock(paused.at)}
    </Hint>
  );
}
