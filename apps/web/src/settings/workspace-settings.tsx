import {
  autonomyOf,
  continueAfterRestart,
  orchestratorConnectors,
  orchestratorPeerMessaging,
  type Project,
  type Settings,
  type WorkerModel,
  type WorkspaceState,
} from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { CirclePause, CirclePlay, Columns3, CopyPlus, Plus, Settings2, Trash2 } from "lucide-react";
import { useId, useMemo, useState } from "react";

import { agentLabel } from "@/agents/agent-display";
import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { AutonomyChip } from "@/orchestration/autonomy-chip";
import { askKeysByThread } from "@/orchestration/ask-model";
import { useWorkspaceAsks } from "@/orchestration/ask-stack";
import { useOrchestratorLedger } from "@/orchestration/use-orchestration";
import { useWorkerTally } from "@/orchestration/use-workspace-statuses";
import { useServerSettings } from "@/settings-sync/store";
import { showUndo } from "@/stores/undo-toasts";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";

import { useOpenBoard } from "@/orchestration/open-board";
import { SettingRow, Toggle, inputCls } from "./fields";
import { OrchestratorConnectorsField } from "./orchestrator-connectors-field";
import { RowContextMenu, RowMenuButton, type RowAction } from "./row-menu";
import { SearchScope } from "./search-scope";
import { SettingsGroup } from "./settings-group";
import { useSaveSettings } from "./use-save-settings";
import { useWorkspaceChanges } from "./workspace-actions";
import { projectNameOf, sameRoster } from "./workspace-settings-model";

const WORKSPACE_KEYWORDS = [
  "orchestrator",
  "charter",
  "workers",
  "repositories",
  "pause",
  "autonomy",
  "merge policy",
  "worker models",
  "roster",
];

/**
 * Settings → Workspaces: every workspace on a line of its own, each opening its settings page, then
 * the defaults that hold for all of them.
 */
export function WorkspacesSettings() {
  const settings = useServerSettings((s) => s.settings);
  if (!settings) return <p className="text-sm text-muted-foreground">Loading settings…</p>;
  return (
    <div className="flex flex-col gap-8 text-sm" data-testid="workspace-settings">
      <WorkspaceList />
      <Defaults settings={settings} />
    </div>
  );
}

function WorkspaceList() {
  const api = useApi();
  const navigate = useNavigate();
  const { data: workspaces = [] } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api.listWorkspaces(),
  });
  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
  return (
    <SettingsGroup
      label="Workspaces"
      keywords={WORKSPACE_KEYWORDS}
      card={false}
      action={
        <Button
          size="xs"
          variant="ghost"
          data-testid="settings-new-workspace"
          onClick={() => void navigate({ to: "/new-workspace" })}
        >
          <Plus data-icon="inline-start" />
          New workspace…
        </Button>
      }
    >
      {workspaces.length === 0 ? (
        <p className="px-1 text-muted-foreground">No workspaces yet.</p>
      ) : (
        <ul
          className="flex flex-col rounded-lg border border-border/60 bg-card/40 [&>li~li]:border-t [&>li~li]:border-border/50"
          data-testid="workspaces"
        >
          {workspaces.map((state) => (
            <WorkspaceRow key={state.workspace.id} state={state} projects={projects} />
          ))}
        </ul>
      )}
    </SettingsGroup>
  );
}

/** One workspace: what it is and how it runs, at a glance, with its settings a click away. */
function WorkspaceRow({
  state,
  projects,
}: {
  state: WorkspaceState;
  projects: readonly Project[];
}) {
  const navigate = useNavigate();
  const openBoard = useOpenBoard();
  const { workspace, charter, paused } = state;
  const changes = useWorkspaceChanges(state);
  // How many of its workers work now, by their tones, as the overview's line counts them.
  const ledger = useOrchestratorLedger(workspace.id).data;
  const asks = useWorkspaceAsks();
  const asking = useMemo(
    () =>
      new Set(askKeysByThread(asks.find((w) => w.workspaceId === workspace.id)?.asks ?? []).keys()),
    [asks, workspace.id],
  );
  const { working } = useWorkerTally(workspace.id, ledger, asking);
  const repos = [
    workspace.homeProjectId,
    ...workspace.projectIds.filter((id) => id !== workspace.homeProjectId),
  ].map((id) => projectNameOf(projects, id));

  const actions: RowAction[] = [
    {
      label: "Settings",
      icon: Settings2,
      onSelect: () =>
        void navigate({
          to: "/settings/workspaces/$workspaceId",
          params: { workspaceId: workspace.id },
        }),
    },
    {
      label: "Open board",
      icon: Columns3,
      onSelect: () => openBoard(workspace.id),
    },
    {
      label: paused === undefined ? "Pause" : "Resume",
      icon: paused === undefined ? CirclePause : CirclePlay,
      disabled: changes.busy,
      onSelect: () => void changes.setPaused(paused === undefined),
    },
    {
      label: "New workspace like this…",
      icon: CopyPlus,
      onSelect: () => void navigate({ to: "/new-workspace", search: { from: workspace.id } }),
    },
    {
      label: "Remove…",
      icon: Trash2,
      danger: true,
      disabled: changes.busy,
      onSelect: () =>
        useThreadDialogs.getState().open({ kind: "removeWorkspace", workspaceId: workspace.id }),
    },
  ];

  return (
    <li aria-label={`Workspace ${workspace.name}`} data-testid="workspace">
      <SearchScope label={workspace.name}>
        <RowContextMenu
          actions={actions}
          render={
            <div
              data-testid="workspace-row"
              className="flex items-center gap-3 px-3 py-2.5 hover:bg-accent/40"
            />
          }
        >
          <Link
            to="/settings/workspaces/$workspaceId"
            params={{ workspaceId: workspace.id }}
            data-testid="workspace-link"
            className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium">{workspace.name}</span>
              <AutonomyChip autonomy={autonomyOf(charter)} testId="workspace-autonomy" />
              {paused !== undefined ? (
                <span
                  data-testid="workspace-paused"
                  className="inline-flex items-center gap-1 text-xs text-status-needs"
                >
                  <CirclePause aria-hidden className="size-3" />
                  Paused
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">Active</span>
              )}
              <span data-testid="workspace-working" className="text-xs text-muted-foreground">
                · {working} working
              </span>
            </span>
            <span
              className="truncate text-xs text-muted-foreground"
              data-testid="workspace-projects"
            >
              {repos.join(", ")}
            </span>
          </Link>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={changes.busy}
              onClick={() => void changes.openOrchestrator()}
            >
              Open orchestrator
            </Button>
            <RowMenuButton label={`Workspace ${workspace.name} actions`} actions={actions} />
          </div>
        </RowContextMenu>
        {changes.error !== undefined && (
          <p role="alert" className="px-3 pb-2 text-xs text-destructive">
            {changes.error}
          </p>
        )}
      </SearchScope>
    </li>
  );
}

/** What holds for every workspace: restarts, connectors and the starting roster. */
function Defaults({ settings }: { settings: Settings }) {
  const save = useSaveSettings();
  const [continueError, setContinueError] = useState<string>();
  const [peerError, setPeerError] = useState<string>();
  return (
    <SettingsGroup
      label="Defaults"
      description="An orchestrator dispatches workers into worktrees and spends tokens while you aren't watching. Gram sets no spending or time limits; your provider's apply."
      testId="workspace-defaults"
    >
      <Toggle
        label="Resume workers on restart"
        description="Ask cut-off workers once to carry on when Gram starts again."
        keywords={["restart", "resume", "crash", "update", "cut off", "continue"]}
        checked={continueAfterRestart(settings)}
        error={continueError}
        learnMore={
          <p>
            Not while its workspace is paused, while you hold it, or when something is already
            queued for it. Either way, its orchestrator hears which workers were cut off.
          </p>
        }
        onChange={(next) => {
          setContinueError(undefined);
          save({ workspaces: { continueAfterRestart: next } }).catch((e: unknown) =>
            setContinueError(errorMessage(e)),
          );
        }}
      />
      <OrchestratorConnectorsField
        entries={orchestratorConnectors(settings)}
        onChange={(next) => save({ workspaces: { orchestratorConnectors: next } })}
      />
      <Toggle
        label="Message other sessions"
        description="Let a Claude orchestrator send to your Claude Code sessions outside Gram."
        keywords={["ListAgents", "SendMessage", "peer", "cross-session", "message", "sessions"]}
        checked={orchestratorPeerMessaging(settings)}
        error={peerError}
        learnMore={
          <p>
            Uses Claude Code&apos;s own ListAgents and SendMessage. Workers never can, and no
            session Gram runs accepts such a message, so replies don&apos;t come back and Gram
            sessions can&apos;t be reached this way. A change applies from an orchestrator&apos;s
            next session.
          </p>
        }
        onChange={(next) => {
          setPeerError(undefined);
          save({ workspaces: { orchestratorPeerMessaging: next } }).catch((e: unknown) =>
            setPeerError(errorMessage(e)),
          );
        }}
      />
      <StartingRosterRow settings={settings} />
    </SettingsGroup>
  );
}

/** A roster in a line: `Claude opus, Codex gpt-6.1-sol`. */
const rosterLine = (models: readonly WorkerModel[]): string =>
  models.length === 0
    ? "None: workers run on the orchestrator's model."
    : models.map((model) => `${agentLabel(model.agent)} ${model.model}`).join(", ");

/** The worker models a new workspace starts with, copied from a workspace; none until then. */
function StartingRosterRow({ settings }: { settings: Settings }) {
  const api = useApi();
  const save = useSaveSettings();
  const id = useId();
  const [error, setError] = useState<string>();
  const { data: workspaces = [] } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api.listWorkspaces(),
  });
  const roster = settings.agents.workerModels ?? [];
  const sources = workspaces.filter((state) => !sameRoster(state.charter.workerModels, roster));
  const use = (models: readonly WorkerModel[], from: string) => {
    setError(undefined);
    const before = roster;
    save({ agents: { workerModels: models } })
      .then(() =>
        showUndo({
          key: "starting-roster",
          title: `New workspaces start with ${from}'s roster`,
          undo: () => save({ agents: { workerModels: before } }),
        }),
      )
      .catch((e: unknown) => setError(errorMessage(e)));
  };
  return (
    <SettingRow
      label="Starting roster"
      description="The worker models a new workspace starts with."
      htmlFor={id}
      keywords={["roster", "worker models", "default", "new workspace"]}
      error={error}
      detail={
        <p data-testid="starting-roster" className="text-xs text-muted-foreground">
          {rosterLine(roster)}
        </p>
      }
    >
      <select
        id={id}
        aria-label="Copy the starting roster from"
        data-testid="starting-roster-from"
        className={inputCls}
        value=""
        disabled={sources.length === 0}
        onChange={(event) => {
          const value = event.target.value;
          const source = workspaces.find((state) => state.workspace.id === value);
          if (source !== undefined) use(source.charter.workerModels ?? [], source.workspace.name);
        }}
      >
        <option value="">Copy from…</option>
        {sources.map((state) => (
          <option key={state.workspace.id} value={state.workspace.id}>
            {state.workspace.name}
          </option>
        ))}
      </select>
    </SettingRow>
  );
}
