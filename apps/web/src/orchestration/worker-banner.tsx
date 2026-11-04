import { USER_HOLD_IDLE_MS, type Thread, type ThreadId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Brain,
  Columns3,
  FolderGit2,
  HandGrab,
  MessageCircleQuestion,
  Pause,
  Settings2,
} from "lucide-react";

import { useApi } from "@/api/context";
import { openWorkspaceSettings } from "@/settings/workspace-sheet";
import { Hint } from "@/components/hint";
import { focusOtherWindow } from "@/desktop/open-thread";
import { showInbox } from "@/inbox/inbox-store";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import {
  pauseClock,
  pauseLeavesRunning,
  pauseText,
  WORKER_HELD_LINE,
  workerHeldEnds,
  workerPauseLine,
} from "@/thread/orchestration-model";

import { workerRepoNames } from "./board-model";
import { ContextChip, HandingOff } from "./fresh-session";
import { memoryIsEmpty } from "./memory-model";
import { useOpenBoard } from "./open-board";
import { midTurnWorkers } from "./tree-model";
import { useAskedQuestions } from "./ask-stack";
import { useHandoff, useHandoffStore, useResume } from "./use-board-actions";
import { useOrchestratorLedger, useWorkspaces } from "./use-orchestration";
import { useWorkerPause } from "./worker-pause";

const LINK =
  "shrink-0 rounded-sm px-1 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";
const ACTION = `${LINK} text-foreground/80`;
/** An icon link in the header: a 28 px square, its background on hover and focus. */
const HEADER_LINK =
  "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring";

/** Opens a thread in this window's grid, or brings forward the window that already shows it. */
export const goToThread = (threadId: ThreadId, event?: { preventDefault: () => void }) => {
  if (focusOtherWindow(threadId)) event?.preventDefault();
  else useLayoutStore.getState().openThread(threadId);
};

/** A banner line under a header: a glyph, its lead in words, the sentence, and any action. */
const BANNER =
  "flex min-w-0 items-center gap-2 border-b border-border px-3 py-1 text-xs text-foreground";

/**
 * What a worker's crumbs can't say, under the header and only while it applies: the repos a
 * multi-repo worker works in; that it is under the user's control, what that means and what the header's
 * Hand back does; and its workspace's pause, which reads apart from a hold: a filled band that
 * names the workspace and resumes all of it.
 */
export function WorkerBanner({ thread }: { thread: Thread }) {
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

  return (
    <>
      {pause !== undefined && (
        <div
          data-testid="worker-banner-workspace-paused"
          data-pause={pause.state}
          role="status"
          className={`${BANNER} bg-muted/60`}
        >
          <Pause aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
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
      {held && (
        // Hand back itself is the header's, beside the worker's name, where it always stays.
        <div data-testid="worker-banner-held" role="status" className={BANNER}>
          <HandGrab aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="shrink-0 font-medium">Under your control</span>
          <span
            className="min-w-0 flex-1 truncate text-muted-foreground"
            title={`${WORKER_HELD_LINE} ${workerHeldEnds(USER_HOLD_IDLE_MS / 60_000)}`}
          >
            {WORKER_HELD_LINE}
          </span>
        </div>
      )}
      {repos !== undefined && (
        <p
          data-testid="worker-banner-repos"
          className="flex min-w-0 items-start gap-1.5 border-b border-border bg-card/40 px-3 py-1 text-xs text-muted-foreground"
        >
          <FolderGit2 aria-hidden className="mt-0.5 size-3.5 shrink-0" />
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

/** The workspace an orchestrator runs, while workspaces are on. */
function useOrchestratorWorkspace(thread: Thread) {
  const workspaces = useWorkspaces();
  const state =
    thread.role === "orchestrator"
      ? workspaces.find((candidate) => candidate.workspace.id === thread.workspaceId)
      : undefined;
  return { state, workspaceId: state?.workspace.id };
}

/**
 * An orchestrator's chips in its pane header: once its context is nearly full, the offer of a
 * fresh session, the questions it left open, the ways to its board and
 * its memory, which the thread menu offers too, and its workspace's settings in a sheet. The glyph and title already say whose it is.
 * Switching it is in the thread menu and the workspace settings' Models.
 */
export function OrchestratorChips({
  thread,
  inTitlebar = false,
}: {
  thread: Thread;
  /**
   * In the title bar, beside Chat · Board: no board button of its own, and Memory and the
   * workspace's settings are in the bar's "…".
   */
  inTitlebar?: boolean;
}) {
  const { state, workspaceId } = useOrchestratorWorkspace(thread);
  const handoff = useHandoff(state);
  const { questions } = useAskedQuestions(workspaceId);
  const openBoard = useOpenBoard();
  if (workspaceId === undefined) return null;
  const noun = questions.length === 1 ? "decision" : "decisions";
  return (
    <>
      {handoff.running ? (
        <HandingOff />
      ) : (
        handoff.suggestedAtPct !== undefined && (
          <ContextChip
            pct={handoff.suggestedAtPct}
            onAct={() => useHandoffStore.getState().confirm(workspaceId)}
          />
        )
      )}
      {questions.length > 0 && (
        <Hint
          label={`${questions.length} ${noun} to make in the Inbox`}
          side="bottom"
          render={
            <button
              type="button"
              onClick={() => showInbox({ workspaceId })}
              data-testid="banner-questions"
              className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-status-needs outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          <MessageCircleQuestion aria-hidden className="size-4" />
          <span className="tabular-nums">{questions.length}</span>
          <span className="sr-only"> {noun} to make</span>
        </Hint>
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
          <Columns3 aria-hidden className="size-4" />
        </Hint>
      )}
      {/* In the title bar, Memory and the workspace's settings are the bar's "…". */}
      {!inTitlebar && (
        <>
          <Hint
            label="Memory"
            side="bottom"
            render={
              <Link
                to="/w/$workspaceId/memory"
                params={{ workspaceId }}
                aria-label="Memory"
                className={HEADER_LINK}
              />
            }
          >
            <Brain aria-hidden className="size-4" />
          </Hint>
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
            <Settings2 aria-hidden className="size-4" />
          </Hint>
        </>
      )}
    </>
  );
}

/**
 * Under an orchestrator's header, only while it applies: the offer of an import into an empty
 * memory, which is never started unasked, and a paused workspace, in the attention colour, with the
 * way to resume it: the orchestrator's own thread is where a user looks when it stops answering.
 */
export function OrchestratorBanner({ thread }: { thread: Thread }) {
  const api = useApi();
  const { state, workspaceId } = useOrchestratorWorkspace(thread);
  const resume = useResume(workspaceId);
  const working = useThreadsStore((s) =>
    workspaceId === undefined ? 0 : midTurnWorkers(s.byId, workspaceId),
  );
  const { data: files } = useQuery({
    queryKey: ["memory", workspaceId, "files"],
    queryFn: () => api.listMemory(workspaceId!),
    enabled: workspaceId !== undefined,
    retry: false,
  });
  if (state === undefined || workspaceId === undefined) return null;
  // A parked orchestrator says so itself, and unparking resumes it.
  const paused = state.paused?.reason === "parked" ? undefined : state.paused;

  return (
    <>
      {files !== undefined && memoryIsEmpty(files) && (
        <p
          data-testid="banner-import-offer"
          className="border-b border-border bg-card/40 px-3 py-1 text-xs text-muted-foreground"
        >
          Its memory is empty.{" "}
          <Link
            to="/w/$workspaceId/memory"
            params={{ workspaceId }}
            className="text-foreground/80 underline underline-offset-2 hover:no-underline"
          >
            Draft it from what your past sessions here worked out
          </Link>
          : you see what it would read first.
        </p>
      )}
      {paused !== undefined && (
        <div
          data-testid="orchestrator-banner-paused"
          role="status"
          className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border px-3 py-1 text-xs text-foreground"
        >
          <Pause aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            {pauseText(paused)} since {pauseClock(paused.at)}. While paused, nothing wakes it and it
            can't spawn or message workers. {pauseLeavesRunning(working, paused)}
          </span>
          <button
            type="button"
            data-testid="orchestrator-banner-resume"
            className={`${ACTION} font-medium text-foreground`}
            onClick={() => void resume()}
          >
            Resume
          </button>
        </div>
      )}
    </>
  );
}
