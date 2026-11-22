import { type Thread, type ThreadId } from "@gram/contracts";
import { Link } from "@tanstack/react-router";
import { Brain, Columns3, FolderGit2, Pause, Repeat, Settings2 } from "lucide-react";

import { openWorkspaceSettings } from "@/settings/workspace-sheet";
import { Hint } from "@/components/hint";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { focusOtherWindow } from "@/desktop/open-thread";
import { useEmbedShell } from "@/embed/store";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import {
  pauseClock,
  pauseLeavesRunning,
  pausedOnErrorText,
  pauseText,
  workerPauseLine,
} from "@/thread/orchestration-model";

import { workerRepoNames } from "./board-model";
import { FreshSessionChip, HandingOff } from "./fresh-session";
import { useOpenBoard } from "./open-board";
import { midTurnWorkers } from "./tree-model";
import { useHandoff, useResume } from "./use-board-actions";
import { useOrchestratorLedger, useWorkspaces } from "./use-orchestration";
import { useWorkerPause } from "./worker-pause";

const LINK =
  "shrink-0 rounded-sm px-1 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";
const ACTION = `${LINK} text-foreground/80`;
const HEADER_LINK =
  "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring";

/** Opens a thread in this window's grid, or brings forward the window that already shows it. */
export const goToThread = (threadId: ThreadId, event?: { preventDefault: () => void }) => {
  if (focusOtherWindow(threadId)) event?.preventDefault();
  else useLayoutStore.getState().openThread(threadId);
};

/** A worker's end states. */
export const FINISHED_WORKER: ReadonlySet<string> = new Set(["merged", "delivered", "archived"]);

const BANNER =
  "flex min-w-0 items-center gap-2 border-b border-border px-3 py-1 text-meta text-foreground";

/**
 * What a worker's crumbs can't say, under the header and only while it applies: the repos a
 * multi-repo worker works in, the routine that started it, and its workspace's pause: a filled
 * band that names the workspace and resumes all of it.
 */
export function WorkerBanner({
  thread,
  repos: showRepos = true,
}: {
  thread: Thread;
  /** Its multi-repo note; off where the worker pane's head names the repositories instead. */
  repos?: boolean;
}) {
  const workspace = useWorkspaces().find((state) => state.workspace.id === thread.workspaceId);
  const { data: ledger } = useOrchestratorLedger(workspace?.workspace.id);
  const status = useThreadsStore((s) => s.byId[thread.id]?.status);
  const entry = ledger?.features
    .flatMap((feature) => feature.workers)
    .find((worker) => worker.threadId === thread.id);
  const held = entry?.userIntervened === true;
  const pause = useWorkerPause(thread.id, status, held);
  const resume = useResume(workspace?.workspace.id);
  if (thread.spawnedBy === undefined) return null;
  const repos = workerRepoNames(thread, entry);
  const routine = thread.spawnedBy.routine;

  return (
    <>
      {pause !== undefined && (
        <div
          data-testid="worker-banner-workspace-paused"
          data-pause={pause.state}
          role="status"
          className={`${BANNER} bg-muted/60`}
        >
          <Pause aria-hidden className="size-icon-row shrink-0 text-muted-foreground" />
          <span className="shrink-0 font-medium">Workspace paused</span>
          <span
            className="min-w-0 flex-1 truncate text-muted-foreground"
            title={workerPauseLine(pause.state, pause.at)}
          >
            {workerPauseLine(pause.state, pause.at)}
          </span>
          <button
            type="button"
            data-testid="worker-banner-resume"
            className={`${ACTION} font-medium text-foreground`}
            onClick={() => void resume()}
          >
            Resume workspace
          </button>
        </div>
      )}
      {routine !== undefined && (
        <p
          data-testid="worker-banner-routine"
          className="flex min-w-0 items-center gap-2 border-b border-edge px-3 py-1 text-meta text-muted-foreground"
        >
          <Repeat aria-hidden className="size-icon-row shrink-0" />
          <span className="min-w-0 truncate" title={`From routine ${routine.name}`}>
            From routine <span className="text-foreground/80">{routine.name}</span>
          </span>
          {workspace !== undefined && (
            <Link
              to="/settings/routines"
              search={{ highlight: workspace.workspace.name }}
              data-testid="worker-banner-routines"
              className={ACTION}
            >
              Routines
            </Link>
          )}
        </p>
      )}
      {showRepos && repos !== undefined && (
        <p
          data-testid="worker-banner-repos"
          className="flex min-w-0 items-start gap-1.5 border-b border-edge bg-card/40 px-3 py-1 text-meta text-muted-foreground"
        >
          <FolderGit2 aria-hidden className="mt-0.5 size-icon-row shrink-0" />
          <span className="min-w-0">
            Works in <span className="text-foreground/80">{repos.primary}</span>
            {repos.others.map((name) => (
              <span key={name}>
                , <span className="text-foreground/80">{name}</span>
              </span>
            ))}
            . Rewind, the diff panel and the review monitor follow {repos.primary} only.
          </span>
        </p>
      )}
    </>
  );
}

function useOrchestratorWorkspace(thread: Thread) {
  const workspaces = useWorkspaces();
  const state =
    thread.role === "orchestrator"
      ? workspaces.find((candidate) => candidate.workspace.id === thread.workspaceId)
      : undefined;
  return { state, workspaceId: state?.workspace.id };
}

/**
 * An orchestrator's chips in its pane header: Fresh session, the ways to its board and its memory, which the thread menu offers too, and its
 * workspace's settings in a sheet. The glyph and title already say whose it is. The questions it
 * left open have no chip here: what needs you has one way in (`NeedsYouEntry`), and its workspace's
 * line counts them. Switching it is in the thread menu and the workspace settings' Models.
 */
export function OrchestratorChips({
  thread,
  inTitlebar = false,
}: {
  thread: Thread;
  /**
   * In the title bar, beside Chat · Board: no board button of its own, Memory at the toolbar's
   * glyph size, and the workspace's settings in the bar's "…".
   */
  inTitlebar?: boolean;
}) {
  const { state, workspaceId } = useOrchestratorWorkspace(thread);
  const handoff = useHandoff(state);
  const openBoard = useOpenBoard();
  const pathBar = useEmbedShell((s) => s.threadsPage.bar === "path");
  if (workspaceId === undefined) return null;
  return (
    <>
      {handoff.running ? (
        <HandingOff savingFirst={handoff.savingFirst} />
      ) : (
        state !== undefined && <FreshSessionChip state={state} inTitlebar={inTitlebar} />
      )}
      {!inTitlebar && (
        <Hint
          label="Open board"
          side="bottom"
          render={
            <button
              type="button"
              onClick={() => openBoard(workspaceId)}
              aria-label="Open board"
              data-testid="banner-board"
              className={HEADER_LINK}
            />
          }
        >
          <Columns3 aria-hidden className="size-icon-row" />
        </Hint>
      )}
      {!(inTitlebar && pathBar) && (
        <Hint
          label="Memory"
          side="bottom"
          render={
            <Link
              to="/w/$workspaceId/memory"
              params={{ workspaceId }}
              aria-label="Memory"
              data-testid="orchestrator-memory"
              className={
                inTitlebar
                  ? cn(
                      buttonVariants({ variant: "ghost", size: "icon-sm" }),
                      "text-muted-foreground",
                    )
                  : HEADER_LINK
              }
            />
          }
        >
          <Brain aria-hidden className={inTitlebar ? undefined : "size-icon-row"} />
        </Hint>
      )}
      {!inTitlebar && (
        <>
          <Hint
            label="Workspace settings"
            side="bottom"
            render={
              <button
                type="button"
                aria-label="Workspace settings"
                data-testid="orchestrator-workspace-settings"
                onClick={() => openWorkspaceSettings(workspaceId)}
                className={HEADER_LINK}
              />
            }
          >
            <Settings2 aria-hidden className="size-icon-row" />
          </Hint>
        </>
      )}
    </>
  );
}

/**
 * Under an orchestrator's header, only while it applies: a paused workspace, in the attention
 * colour, with the way to resume it: the orchestrator's own thread is where a user looks when it
 * stops answering. An empty memory's import is offered on the Memory view, not here.
 */
export function OrchestratorBanner({ thread }: { thread: Thread }) {
  const { state, workspaceId } = useOrchestratorWorkspace(thread);
  const resume = useResume(workspaceId);
  const working = useThreadsStore((s) =>
    workspaceId === undefined ? 0 : midTurnWorkers(s.byId, workspaceId),
  );
  const summary = useThreadsStore((s) => s.byId[thread.id]);
  if (state === undefined || workspaceId === undefined) return null;
  const paused = state.paused?.reason === "parked" ? undefined : state.paused;
  const changed = summary?.git?.changedFiles ?? 0;
  const onError =
    paused === undefined || summary === undefined ? undefined : pausedOnErrorText(paused, summary);

  return (
    <>
      {paused !== undefined && (
        <div
          data-testid="orchestrator-banner-paused"
          data-on-error={onError === undefined ? undefined : ""}
          role="status"
          className={cn(
            "flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border px-3 py-1 text-meta text-foreground",
            onError !== undefined && "items-start bg-destructive/5 py-2",
          )}
        >
          <Pause
            aria-hidden
            className={cn(
              "size-icon-row shrink-0",
              onError === undefined ? "text-muted-foreground" : "mt-0.5 text-destructive",
            )}
          />
          {onError === undefined ? (
            <span className="min-w-0 flex-1">
              {pauseText(paused)} since {pauseClock(paused.at)}. While paused, nothing wakes it and
              it can't spawn or message workers. {pauseLeavesRunning(working, paused)}
            </span>
          ) : (
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span data-testid="orchestrator-banner-error" className="font-medium">
                Paused since {pauseClock(paused.at)}. {onError.reason}
              </span>
              <span className="text-muted-foreground">
                {onError.next} {pauseLeavesRunning(working, paused)}
              </span>
              <span className="flex flex-wrap items-center gap-2 pt-1">
                <Button
                  size="xs"
                  data-testid="orchestrator-banner-resume"
                  onClick={() => void resume()}
                >
                  Resume
                </Button>
                {changed > 0 && (
                  <Button
                    size="xs"
                    variant="outline"
                    data-testid="orchestrator-banner-changes"
                    onClick={() => useLayoutStore.getState().revealPanel("diff")}
                  >
                    Show its {changed} changed {changed === 1 ? "file" : "files"}
                  </Button>
                )}
              </span>
            </span>
          )}
          {onError === undefined && (
            <button
              type="button"
              data-testid="orchestrator-banner-resume"
              className={`${ACTION} font-medium text-foreground`}
              onClick={() => void resume()}
            >
              Resume
            </button>
          )}
        </div>
      )}
    </>
  );
}
