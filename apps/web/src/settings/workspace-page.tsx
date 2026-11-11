import {
  autonomyOf,
  type OrchestratorCharter,
  type Project,
  type ProjectId,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Brain,
  ChevronLeft,
  ChevronRight,
  CirclePause,
  CirclePlay,
  Columns3,
  CopyPlus,
  Trash2,
  X,
} from "lucide-react";
import { useId, useState } from "react";
import { flushSync } from "react-dom";

import { useApi } from "@/api/context";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Expand } from "@/motion";
import { AddRepository } from "@/new-thread/add-repository";
import { AutonomyChip } from "@/orchestration/autonomy-chip";
import { RepositoryChecklist } from "@/orchestration/repository-checklist";
import { SwitchOrchestratorAction } from "@/orchestration/switch-orchestrator";
import { ProjectScriptsEditor } from "@/scripts/project-scripts-editor";
import { useThreadsStore } from "@/stores/threads";
import { parentFolder } from "@/orchestration/workspace-repos";
import { pauseText } from "@/thread/orchestration-model";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";

import { useOpenBoard } from "@/orchestration/open-board";
import { DraftActions, SaveHint } from "./save-hint";
import { AutomaticDreamField } from "./automatic-dream-field";
import { AutonomyField } from "./autonomy-field";
import { Field, inputCls, NumberField } from "./fields";
import { MergeReviewPolicyField } from "./merge-review-policy-field";
import { RouteAtLimitField } from "./route-at-limit-field";
import { IdleCompactField } from "./idle-compact-field";
import { PauseAtLimitField } from "./pause-at-limit-field";
import { RosterEditor } from "./roster-editor";
import { RowMenuButton, type RowAction } from "./row-menu";
import { RoutinesSection } from "./routines-section";
import { SETTINGS_CARD, SETTINGS_STACK, SettingsGroup } from "./settings-group";
import { WorkerBriefFooterField } from "./worker-brief-footer-field";
import { WorkerModeField } from "./worker-mode-field";
import { useWorkspaceChanges } from "./workspace-actions";
import { WorkspaceConnectorsField } from "./workspace-connectors-field";
import {
  autonomyLevel,
  draftOfWorkspace,
  projectNameOf,
  validateWorkspaceDraft,
  withAutonomy,
  withoutWorkspaceRepo,
  withWorkerCap,
  withWorkerMode,
  withWorkspaceRepo,
  workerModeLabel,
  WORKERS_AT_ONCE,
} from "./workspace-settings-model";

type Changes = ReturnType<typeof useWorkspaceChanges>;

/** Shown in the sheet from the orchestrator rather than under Settings. */
export interface WorkspaceSheetProps {
  /** The heading's id, which names the sheet. */
  readonly titleId: string;
  readonly onClose: () => void;
}

/**
 * Settings → Workspaces → one workspace, or the same in the sheet from its orchestrator: its
 * repositories, how far it goes unasked, its models, how its pull requests merge, and the rest
 * folded under More options. Every change saves at once and says so with Undo.
 */
export function WorkspaceSettingsPage({
  workspaceId,
  sheet,
}: {
  workspaceId: WorkspaceId;
  sheet?: WorkspaceSheetProps;
}) {
  const api = useApi();
  const { data: workspaces, isPending } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api.listWorkspaces(),
  });
  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
  const state = workspaces?.find((each) => each.workspace.id === workspaceId);
  const changes = useWorkspaceChanges(state);
  const holder = state?.workspace.orchestratorThreadId;
  const orchestrator = useThreadsStore((store) =>
    holder === undefined ? undefined : store.byId[holder]?.thread,
  );

  if (isPending) return <p className="text-reading text-muted-foreground">Loading workspace…</p>;
  if (state === undefined) {
    return (
      <div data-testid="workspace-page-missing" className="flex flex-col gap-2 text-reading">
        {sheet === undefined && <BackLink />}
        <p className="text-muted-foreground">No such workspace. It may have been removed.</p>
      </div>
    );
  }
  return (
    <div data-testid="workspace-page" className={cn(SETTINGS_STACK, "text-reading")}>
      <Header state={state} changes={changes} sheet={sheet} />
      <Basics state={state} projects={projects} changes={changes} />
      <SettingsGroup
        label="Project scripts"
        description="Build, test, dev and other commands, one click or key away."
        learnMore="Each runs in the thread's own folder, in a terminal tab named after it. Pick one from Run script in a thread's header or the palette, or press its key."
        keywords={[
          "scripts",
          "commands",
          "build",
          "test",
          "lint",
          "dev",
          "run",
          "package.json",
          "makefile",
        ]}
        testId="workspace-scripts"
      >
        {state.workspace.projectIds.map((projectId) => (
          <div key={projectId} className="flex flex-col gap-2">
            {state.workspace.projectIds.length > 1 && (
              <p className="text-meta font-medium">{projectNameOf(projects, projectId)}</p>
            )}
            <ProjectScriptsEditor projectId={projectId} />
          </div>
        ))}
      </SettingsGroup>
      <AutonomySection state={state} changes={changes} />
      <SettingsGroup
        label="Models"
        description="Which models the orchestrator and its workers run on."
        keywords={["roster", "worker models", "orchestrator model", "brief footer"]}
      >
        {orchestrator !== undefined && (
          <SwitchOrchestratorAction thread={orchestrator} disabled={changes.busy} />
        )}
        <RosterEditor
          charter={changes.charter ?? state.charter}
          disabled={changes.busy || orchestrator?.sessionSwitch !== undefined}
          onChange={(next) => void changes.saveCharter(next, "Models saved")}
        />
        <RouteAtLimitField
          charter={changes.charter ?? state.charter}
          disabled={changes.busy}
          onChange={(next, title) => void changes.saveCharter(next, title)}
        />
        <WorkerBriefFooterField
          charter={changes.charter ?? state.charter}
          disabled={changes.busy}
          onChange={(next, title) => void changes.saveCharter(next, title)}
        />
      </SettingsGroup>
      <RoutinesSection state={state} projects={projects} changes={changes} />
      <SettingsGroup
        label="Reviews & merging"
        description="What has to happen before a worker's pull request may merge."
        keywords={["merge", "review", "solo", "bot"]}
      >
        <MergeReviewPolicyField
          charter={changes.charter ?? state.charter}
          disabled={changes.busy}
          onChange={(next) => void changes.saveCharter(next, "Merge policy saved")}
        />
      </SettingsGroup>
      <MoreOptions state={state} changes={changes} />
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to="/settings/workspaces"
      data-testid="workspace-page-back"
      className="inline-flex w-fit items-center gap-0.5 rounded-sm text-meta text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronLeft aria-hidden className="size-icon-chip" />
      Workspaces
    </Link>
  );
}

function Header({
  state,
  changes,
  sheet,
}: {
  state: WorkspaceState;
  changes: Changes;
  sheet: WorkspaceSheetProps | undefined;
}) {
  const navigate = useNavigate();
  const openBoard = useOpenBoard();
  const { workspace, charter, paused } = state;
  const workspaceId = workspace.id;
  const actions: RowAction[] = [
    {
      label: "Open board",
      icon: Columns3,
      onSelect: () => openBoard(workspaceId),
    },
    {
      label: "Memory",
      icon: Brain,
      onSelect: () => void navigate({ to: "/w/$workspaceId/memory", params: { workspaceId } }),
    },
    {
      label: "New workspace like this…",
      icon: CopyPlus,
      onSelect: () => void navigate({ to: "/new-workspace", search: { from: workspaceId } }),
    },
    {
      label: "Remove…",
      icon: Trash2,
      danger: true,
      disabled: changes.busy,
      onSelect: () => {
        sheet?.onClose();
        useThreadDialogs.getState().open({ kind: "removeWorkspace", workspaceId });
      },
    },
  ];
  return (
    <header className="flex flex-col gap-2">
      {sheet === undefined && <BackLink />}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2
          id={sheet?.titleId}
          data-testid="workspace-page-title"
          className="min-w-0 truncate font-heading text-heading font-medium"
        >
          {workspace.name}
        </h2>
        <AutonomyChip autonomy={autonomyOf(charter)} testId="workspace-autonomy" />
        {paused !== undefined && (
          <span
            data-testid="workspace-paused"
            className="inline-flex items-center gap-1 text-meta text-muted-foreground"
          >
            <CirclePause aria-hidden className="size-icon-chip" />
            Paused
          </span>
        )}
        <div className="ms-auto flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            disabled={changes.busy}
            onClick={() => void changes.setPaused(paused === undefined)}
          >
            {paused === undefined ? (
              <CirclePause data-icon="inline-start" />
            ) : (
              <CirclePlay data-icon="inline-start" />
            )}
            {paused === undefined ? "Pause" : "Resume"}
          </Button>
          {sheet === undefined && (
            <Button
              size="sm"
              disabled={changes.busy}
              onClick={() => void changes.openOrchestrator()}
            >
              Open orchestrator
            </Button>
          )}
          <RowMenuButton label={`Workspace ${workspace.name} actions`} actions={actions} />
          {sheet !== undefined && (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Close"
              data-testid="workspace-sheet-close"
              onClick={sheet.onClose}
            >
              <X aria-hidden />
            </Button>
          )}
        </div>
      </div>
      {paused !== undefined && (
        <p data-testid="workspace-pause-reason" className="text-meta text-muted-foreground">
          {pauseText(paused)}. Nothing new starts until you resume.
        </p>
      )}
      {changes.error !== undefined && (
        <p role="alert" className="text-meta text-destructive">
          {changes.error}
        </p>
      )}
    </header>
  );
}

function Basics({
  state,
  projects,
  changes,
}: {
  state: WorkspaceState;
  projects: readonly Project[];
  changes: Changes;
}) {
  const { workspace } = state;
  const homeId = useId();
  const [error, setError] = useState<string>();
  const [ticking, setTicking] = useState(false);
  const [adding, setAdding] = useState(false);
  const home = projects.find((project) => project.id === workspace.homeProjectId)?.root;
  const nameOf = (id: ProjectId) => projectNameOf(projects, id);

  const toggle = (projectId: ProjectId, included: boolean) => {
    setError(undefined);
    if (included) {
      void changes.saveWorkspace(
        withWorkspaceRepo(workspace, projectId),
        `Added ${nameOf(projectId)}`,
        setError,
      );
      return;
    }
    const result = withoutWorkspaceRepo(workspace, projectId);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    void changes.saveWorkspace(
      result.input,
      `Removed ${nameOf(projectId)} from ${workspace.name}`,
      setError,
    );
  };

  return (
    <SettingsGroup
      label="Basics"
      description="The workspace's name and the repositories it covers."
      keywords={["name", "repositories", "home repository"]}
    >
      <NameField state={state} changes={changes} />
      <Field label="Repositories" description="Where the orchestrator may start workers.">
        <RepositoryChecklist
          testId="workspace-repos"
          className="flex flex-col gap-1"
          projects={projects}
          picked={workspace.projectIds}
          onToggle={toggle}
          onPendingChange={setTicking}
          empty={<p className="text-meta text-muted-foreground">No repositories yet.</p>}
        />
        <AddRepository
          defaultPath={home === undefined ? undefined : parentFolder(home)}
          disabled={changes.busy || ticking}
          onPendingChange={setAdding}
          onAdded={(project) =>
            changes.saveWorkspace(
              withWorkspaceRepo(workspace, project.id),
              `Added ${project.name}`,
              setError,
            )
          }
        />
        {error !== undefined && (
          <p role="alert" className="text-meta text-destructive">
            {error}
          </p>
        )}
      </Field>
      {workspace.projectIds.length > 1 && (
        <Field
          label="Home repository"
          description="Where the orchestrator's own session runs."
          htmlFor={homeId}
        >
          <select
            id={homeId}
            data-testid="workspace-home"
            className={inputCls}
            value={workspace.homeProjectId}
            disabled={changes.busy || adding}
            onChange={(event) => {
              const homeProjectId = event.target.value as ProjectId;
              const result = validateWorkspaceDraft(
                { ...draftOfWorkspace(workspace), homeProjectId },
                workspace.id,
              );
              if ("error" in result) return setError(result.error);
              void changes.saveWorkspace(
                result.input,
                `${nameOf(homeProjectId)} is now home`,
                setError,
              );
            }}
          >
            {workspace.projectIds.map((projectId) => (
              <option key={projectId} value={projectId}>
                {nameOf(projectId)}
              </option>
            ))}
          </select>
        </Field>
      )}
    </SettingsGroup>
  );
}

/** The name, typed as a draft and saved when left or on Enter. */
function NameField({ state, changes }: { state: WorkspaceState; changes: Changes }) {
  const { workspace } = state;
  const id = useId();
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  const hintId = useId();
  const dirty = draft !== undefined && draft !== workspace.name;
  const commit = () => {
    if (draft === undefined) return;
    const result = validateWorkspaceDraft(
      { ...draftOfWorkspace(workspace), name: draft },
      workspace.id,
    );
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setDraft(undefined);
    setError(undefined);
    if (result.input.name !== workspace.name) {
      void changes.saveWorkspace(result.input, `Renamed to ${result.input.name}`, setError);
    }
  };
  const cancel = () => {
    setDraft(undefined);
    setError(undefined);
  };
  return (
    <Field
      label="Name"
      description="Shown in the sidebar and the title bar."
      htmlFor={id}
      hint={dirty ? <SaveHint id={hintId} /> : undefined}
    >
      <span className="flex max-w-md items-center gap-2">
        <input
          id={id}
          className={inputCls}
          value={draft ?? workspace.name}
          spellCheck={false}
          autoComplete="off"
          disabled={changes.busy}
          aria-describedby={dirty ? hintId : undefined}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) flushSync(commit);
            if (event.key === "Escape") cancel();
          }}
        />
        {dirty && <DraftActions label="Name" onSave={commit} onCancel={cancel} />}
      </span>
      {error !== undefined && (
        <p role="alert" className="text-meta text-destructive">
          {error}
        </p>
      )}
    </Field>
  );
}

function AutonomySection({ state, changes }: { state: WorkspaceState; changes: Changes }) {
  const charter = changes.charter ?? state.charter;
  // A refused change of level is said by the selector, which never left the level it was on: the
  // server names the threads in the way and the ways out, and that belongs beside the choice.
  // Kept with the charter it was refused against: any later save gives a new charter, which
  // clears it, as one that removes what was in the way should.
  const [refusal, setRefusal] = useState<{
    charter: OrchestratorCharter;
    message: string;
  }>();
  const autonomyError = refusal?.charter === charter ? refusal.message : undefined;
  return (
    <SettingsGroup
      label="Autonomy"
      description="How far the orchestrator and its workers go on their own."
      keywords={["worker mode", "workers at once", "permission", "usage limit"]}
    >
      <AutonomyField
        value={autonomyOf(charter)}
        disabled={changes.busy}
        error={autonomyError}
        onChange={(autonomy) => {
          setRefusal(undefined);
          void changes.saveCharter(
            withAutonomy(charter, autonomy),
            `Autonomy set to ${autonomyLevel(autonomy).label}`,
            (message) => setRefusal({ charter, message }),
          );
        }}
      />
      <WorkerModeField
        value={charter.workerMode}
        disabled={changes.busy}
        onChange={(mode) => {
          const next = withWorkerMode(charter, mode);
          void changes.saveCharter(next, `Worker mode set to ${workerModeLabel(next.workerMode)}`);
        }}
      />
      <NumberField
        label={WORKERS_AT_ONCE.label}
        description={WORKERS_AT_ONCE.description}
        value={charter.maxConcurrentWorkers}
        min={WORKERS_AT_ONCE.min}
        step={WORKERS_AT_ONCE.step}
        disabled={changes.busy}
        // A draft committed while another charter save runs would build on stale props.
        onCommit={(value) => {
          if (!changes.busy) {
            void changes.saveCharter(
              withWorkerCap(charter, value),
              `Workers at once set to ${value}`,
            );
          }
        }}
      />
      <PauseAtLimitField
        charter={charter}
        disabled={changes.busy}
        onChange={(next, title) => void changes.saveCharter(next, title)}
      />
      <IdleCompactField
        charter={charter}
        disabled={changes.busy}
        onChange={(next, title) => void changes.saveCharter(next, title)}
      />
    </SettingsGroup>
  );
}

/** Connectors and automatic Dream, the rarely changed ones: folded under More options. */
function MoreOptions({ state, changes }: { state: WorkspaceState; changes: Changes }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const { workspace } = state;
  const charter = changes.charter ?? state.charter;
  const save = (next: OrchestratorCharter, title: string) => changes.saveCharter(next, title);
  return (
    <section aria-label="More options" className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        data-testid="workspace-advanced"
        onClick={() => setOpen(!open)}
        className="flex min-h-7 items-center gap-1 rounded-sm px-1 text-meta font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-icon-chip transition-transform duration-(--dur-fast)",
            open && "rotate-90",
          )}
        />
        More options
      </button>
      <Expand open={open} id={id}>
        <div className={SETTINGS_CARD}>
          <WorkspaceConnectorsField
            charter={charter}
            disabled={changes.busy}
            onChange={(next) =>
              new Promise<void>((resolve, reject) => {
                void changes
                  .saveCharter(next, "Connectors saved", (message) => reject(new Error(message)))
                  .then(resolve);
              })
            }
          />
          <AutomaticDreamField
            workspaceId={workspace.id}
            charter={charter}
            disabled={changes.busy}
            onChange={(next) => void save(next, "Memory update setting saved")}
          />
        </div>
      </Expand>
    </section>
  );
}
