import {
  autonomyOf,
  type OrchestratorLedger,
  type ThreadId,
  type ThreadSummary,
  type WorkspaceState,
} from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CirclePause, CirclePlay, FolderGit2, Settings2 } from "lucide-react";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { useWorkspaceAsks } from "@/orchestration/ask-stack";
import { AutonomyChip } from "@/orchestration/autonomy-chip";
import { newEntryRoute } from "@/orchestration/new-entry";
import { useOpenBoard } from "@/orchestration/open-board";
import { askingOf } from "@/orchestration/overview-sidebar";
import { setWorkspacePaused } from "@/orchestration/pause-workspace";
import { useNeedsYouCounts } from "@/orchestration/use-needs-you";
import { useOrchestratorLedgers } from "@/orchestration/use-orchestration";
import { useWorkerTally } from "@/orchestration/use-workspace-statuses";
import { useOpenPrRows } from "@/reviews/open-prs";
import { openWorkspaceSettings } from "@/settings/workspace-sheet";
import { useThreadsStore } from "@/stores/threads";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";

import {
  emptyWords,
  lastWorkByWorkspace,
  outsideLine,
  prsByWorkspace,
  repositoriesLine,
  workspaceFactWords,
  type WorkspaceWords,
} from "./workspaces-model";

const NO_ASKING: ReadonlySet<ThreadId> = new Set();

/**
 * Every workspace as one list, in the order they were made: each with its repositories, what
 * waits on you, what runs, its open pull requests and its autonomy, and beside them a task for it,
 * its Board, its settings and its pause. For an app in front of Gram whose people start from a
 * workspace, in its own word for one; the threads in none are counted under it, one click away.
 */
export function WorkspacesList({
  workspaces,
  words,
  outside,
  solo,
  onShowThreads,
}: {
  workspaces: readonly WorkspaceState[];
  words: WorkspaceWords;
  /** The threads in no workspace, which this list leaves out. */
  outside: { readonly total: number; readonly running: number };
  /** The embedding app's word for a thread in no workspace, for the empty list's second way in. */
  solo: string | undefined;
  onShowThreads: () => void;
}) {
  const navigate = useNavigate();
  const api = useApi();
  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id as string, project.name])),
    [projects],
  );
  const { byWorkspace } = useNeedsYouCounts();
  const asks = useWorkspaceAsks();
  const asking = useMemo(
    () => new Map(asks.map((each) => [each.workspaceId as string, askingOf(each.asks)] as const)),
    [asks],
  );
  const ids = useMemo(() => workspaces.map((state) => state.workspace.id), [workspaces]);
  const ledgers = useOrchestratorLedgers(ids);
  const { rows: prRows } = useOpenPrRows();
  const byId = useThreadsStore((s) => s.byId);
  const prs = useMemo(() => prsByWorkspace(prRows, byId), [prRows, byId]);
  const own = useThreadsStore(
    useShallow((s) =>
      Object.values(s.byId).filter(
        (summary): summary is ThreadSummary => summary?.thread.workspaceId !== undefined,
      ),
    ),
  );
  const lastWork = useMemo(() => lastWorkByWorkspace(own), [own]);
  const outsideWords = outsideLine(outside, words);

  if (workspaces.length === 0) {
    const empty = emptyWords(words);
    return (
      <EmptyState
        testId="workspaces-empty"
        icon={FolderGit2}
        title={empty.title}
        line={empty.line}
        action={{
          label: `New ${words.noun.toLowerCase()}`,
          testId: "workspaces-empty-new",
          onClick: () => void navigate(newEntryRoute("workspace")),
        }}
      >
        <Button
          type="button"
          size="sm"
          variant="link"
          className="mt-1"
          data-testid="workspaces-empty-solo"
          onClick={() => void navigate(newEntryRoute("oneOff"))}
        >
          {solo === undefined ? "Start a chat" : `Start ${article(solo)} ${solo.toLowerCase()}`}
        </Button>
      </EmptyState>
    );
  }
  return (
    <>
      <ul data-testid="workspaces-list" className="flex flex-col gap-2">
        {workspaces.map((state) => (
          <WorkspaceItem
            key={state.workspace.id}
            state={state}
            words={words}
            repositories={repositoriesLine(state.workspace.projectIds, projectNames)}
            asks={byWorkspace.get(state.workspace.id) ?? 0}
            asking={asking.get(state.workspace.id) ?? NO_ASKING}
            ledger={ledgers.get(state.workspace.id)}
            prs={prs.get(state.workspace.id) ?? 0}
            lastWorkAt={lastWork.get(state.workspace.id)}
          />
        ))}
      </ul>
      {outsideWords !== undefined && (
        <p data-testid="workspaces-outside" className="text-meta text-muted-foreground">
          {outsideWords}{" "}
          <button
            type="button"
            data-testid="workspaces-outside-show"
            onClick={onShowThreads}
            className="rounded-sm text-link underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            See them in Threads
          </button>
        </p>
      )}
    </>
  );
}

const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");

function WorkspaceItem({
  state,
  words,
  repositories,
  asks,
  asking,
  ledger,
  prs,
  lastWorkAt,
}: {
  state: WorkspaceState;
  words: WorkspaceWords;
  repositories: string;
  asks: number;
  asking: ReadonlySet<ThreadId>;
  ledger: OrchestratorLedger | undefined;
  prs: number;
  lastWorkAt: number | undefined;
}) {
  const navigate = useNavigate();
  const api = useApi();
  const queryClient = useQueryClient();
  const openBoard = useOpenBoard();
  const now = useNow(true, undefined, 60_000);
  const { workspace, paused } = state;
  const { working } = useWorkerTally(workspace.id, ledger, asking);
  const facts = workspaceFactWords({ asks, working, prs, pausedAt: paused?.at, lastWorkAt }, now);
  const noun = words.noun.toLowerCase();
  const setPaused = () =>
    void setWorkspacePaused(api, queryClient, workspace, paused === undefined).catch(
      (error: unknown) =>
        useThreadDialogs
          .getState()
          .fail(
            `Couldn't ${paused === undefined ? "pause" : "resume"} the ${noun}: ${errorMessage(error)}`,
          ),
    );
  return (
    <li
      data-testid="workspaces-row"
      data-workspace-id={workspace.id}
      data-paused={paused !== undefined || undefined}
      data-asks={asks}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border px-3.5 py-3"
    >
      <div className="flex min-w-[min(100%,16rem)] flex-1 basis-64 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            data-testid="workspaces-row-open"
            title={`Open ${workspace.name}'s Board`}
            onClick={() => openBoard(workspace.id)}
            className="min-w-0 truncate rounded-sm text-body-strong text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {workspace.name}
          </button>
          {paused !== undefined && (
            <span
              data-testid="workspaces-row-paused"
              className="shrink-0 rounded-sm border border-border px-1 text-meta text-muted-foreground"
            >
              Paused
            </span>
          )}
          <AutonomyChip autonomy={autonomyOf(state.charter)} testId="workspaces-row-autonomy" />
        </div>
        {repositories !== "" && (
          <p
            data-testid="workspaces-row-repositories"
            className="truncate text-meta text-muted-foreground"
          >
            {repositories}
          </p>
        )}
        <p
          data-testid="workspaces-row-facts"
          className="flex flex-wrap gap-x-3 text-meta text-muted-foreground"
        >
          {facts.map((fact) => (
            <span
              key={fact.key}
              data-fact={fact.key}
              className={cn(fact.tone === "asks" && "text-warning")}
            >
              {fact.words}
            </span>
          ))}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {paused === undefined ? (
          <Button
            size="sm"
            variant="outline"
            data-testid="workspaces-row-new"
            onClick={() => void navigate(newEntryRoute("task", workspace.id))}
          >
            New task
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            data-testid="workspaces-row-resume"
            onClick={setPaused}
          >
            <CirclePlay aria-hidden data-icon="inline-start" />
            Resume
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          data-testid="workspaces-row-board"
          onClick={() => openBoard(workspace.id)}
        >
          Board
        </Button>
        {paused === undefined && (
          <Button
            size="icon-xs"
            variant="ghost"
            data-testid="workspaces-row-pause"
            title={`Pause ${workspace.name}`}
            aria-label={`Pause ${workspace.name}`}
            onClick={setPaused}
          >
            <CirclePause aria-hidden />
          </Button>
        )}
        <Button
          size="icon-xs"
          variant="ghost"
          data-testid="workspaces-row-settings"
          title={`${words.noun} settings`}
          aria-label={`Settings of ${workspace.name}`}
          onClick={() => openWorkspaceSettings(workspace.id)}
        >
          <Settings2 aria-hidden />
        </Button>
      </div>
    </li>
  );
}
