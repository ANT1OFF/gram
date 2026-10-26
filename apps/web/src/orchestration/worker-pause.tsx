import type { ThreadId, ThreadStatus } from "@gram/contracts";
import { Pause } from "lucide-react";

import { cn } from "@/lib/utils";
import { useThreadsStore } from "@/stores/threads";
import { workerPauseHint, workerPauseOf, type WorkerPause } from "@/thread/orchestration-model";

import { useWorkspaces } from "./use-orchestration";

/** A worker in a workspace the user paused: how it stands, and since when the pause has held. */
export interface WorkerPauseState {
  readonly state: WorkerPause;
  readonly at: number;
}

/** The word a row's accessible name takes for it. */
export const PAUSE_WORD: Record<WorkerPause, string> = {
  stopping: "pausing",
  paused: "paused",
  held: "paused, yours",
};

/**
 * How `threadId` stands under its workspace's pause, from its status and whether the user holds it;
 * `undefined` unless the user paused its workspace. A pause the server made leaves workers going.
 */
export function useWorkerPause(
  threadId: ThreadId,
  status: ThreadStatus | undefined,
  held: boolean,
): WorkerPauseState | undefined {
  const workspaceId = useThreadsStore((s) => s.byId[threadId]?.thread.workspaceId);
  const paused = useWorkspaces().find((each) => each.workspace.id === workspaceId)?.paused;
  if (paused?.reason !== "user") return undefined;
  return { state: workerPauseOf(status ?? "cold", held), at: paused.at };
}

/** The pause glyph a worker row carries, its hint the words for how it stands. */
export function WorkerPauseMark({ pause }: { pause: WorkerPauseState }) {
  return (
    <span
      data-testid="overview-worker-paused"
      data-pause={pause.state}
      title={workerPauseHint(pause.state, pause.at)}
      className={cn(
        "flex shrink-0 items-center",
        pause.state === "paused" ? "text-muted-foreground" : "text-status-needs",
      )}
    >
      <Pause aria-hidden className="size-3" />
    </span>
  );
}
