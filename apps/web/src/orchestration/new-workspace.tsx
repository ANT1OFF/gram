import {
  autonomyOf,
  type OrchestratorCharter,
  type Project,
  type ProjectId,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { X } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { FOLD, FoldSummary } from "@/components/fold-summary";
import { FormError } from "@/components/form-error";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/input";
import { useModelNames, useModelsSettled } from "@/composer/models";
import {
  needsMachine,
  ON_DEMAND_QUERY_KEY,
  StartMachineCard,
  useOnDemandMachine,
} from "@/composer/start-machine-card";
import { fetchOnDemandStatus, isComing, startOnDemand } from "@/api/on-demand";
import { useMachineNoun, useMachineReachesTheirs, useThreadsWorkspaceNoun } from "@/embed/store";
import { useShortcut } from "@/keyboard/registry";
import { ShortcutKbd } from "@/keyboard/use-shortcut-hint";
import { focusIfConnected } from "@/lib/use-return-focus";
import { Expand, PressScale, Spinner } from "@/motion";
import { AddRepository, type AddRepositoryHandle } from "@/new-thread/add-repository";
import { AutonomyChoice } from "@/new-thread/autonomy-choice";
import { Field } from "@/settings/fields";
import { useDefaultModel, useRosterHere, useSlotModel } from "@/settings/model-slots";
import { useSaveSettings } from "@/settings/use-save-settings";
import {
  defaultWorkerIndex,
  projectNameOf,
  withAutonomy,
} from "@/settings/workspace-settings-model";
import { useServerSettings } from "@/settings-sync/store";
import { useLayoutStore } from "@/stores/layout";
import { useWelcome } from "@/welcome/welcome-state";

import {
  charterOf,
  createInput,
  emptyNewWorkspace,
  firstMessageOf,
  startFrom,
  subscriptionWorkspaceCharter,
  toggleRepo,
  type NewWorkspaceDraft,
} from "./new-workspace-model";
import { RepositoryChecklist } from "./repository-checklist";
import { sendDiscover } from "./use-board-actions";
import { useWorkspacesQuery } from "./use-orchestration";
import { parentFolder } from "./workspace-repos";

/** How often a sheet waiting for the person's machine asks whether it is up. */
const MACHINE_POLL_MS = 1000;

const RosterEditor = lazy(() =>
  import("@/settings/roster-editor").then((module) => ({ default: module.RosterEditor })),
);

/** Where a key press belongs to an open menu, list or dialog rather than to the sheet. */
const inPopup = (target: EventTarget) =>
  target instanceof Element &&
  target.closest('[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]') !== null;

/**
 * New workspace, on one sheet: its repositories, what it should work on, and how far it goes
 * alone. Start makes the workspace and opens its orchestrator, with "What should it work on?" as
 * its first message when filled in. The name comes from the home repository. The model defaults
 * come from settings or `from`'s charter, and can be changed before the first turn.
 * ⌘Enter starts, Esc leaves.
 */
export function NewWorkspaceSheet({
  from,
  repo,
  read = false,
}: {
  from?: WorkspaceId | undefined;
  repo?: ProjectId | undefined;
  /** Opens with "Read the repositories first" ticked, as the first-run card promises. */
  read?: boolean | undefined;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  // The embedding app's word for a workspace ("Project"), so the sheet is named as its list is.
  const kind = useThreadsWorkspaceNoun();
  const settings = useServerSettings((s) => s.settings);
  const { data: projects = [], isSuccess: projectsLoaded } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
  const { workspaces, settled, error: loadError } = useWorkspacesQuery();
  // A failed list reads as none, which would drop `from` and name the workspace over one that
  // exists; nothing is decided from it until it loads.
  const claudeDiscovery = useModelsSettled("claude");
  const codexDiscovery = useModelsSettled("codex");
  const modelsSettled = claudeDiscovery.settled && codexDiscovery.settled;
  const explicitModel =
    settings?.agents.defaultModel !== undefined ||
    workspaces.find((state) => state.workspace.id === from)?.charter.orchestratorModel !==
      undefined;
  const loaded =
    settings !== undefined &&
    settled &&
    !loadError &&
    projectsLoaded &&
    (explicitModel || modelsSettled);
  const claudeModels = modelsSettled ? claudeDiscovery.models : undefined;
  const codexModels = modelsSettled ? codexDiscovery.models : undefined;
  const starting = useMemo(
    () => subscriptionWorkspaceCharter(settings, claudeModels, codexModels),
    [settings, claudeModels, codexModels],
  );
  // Once shown, the form stays: a later refetch can't take it away mid-edit.
  const [shown, setShown] = useState(false);
  if (loaded && !shown) setShown(true);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex min-h-full items-center-safe justify-center p-6">
        <div
          data-testid="new-workspace"
          className="flex w-full max-w-lg flex-col gap-5 rounded-lg border border-edge bg-card p-5 text-reading text-card-foreground"
        >
          <h1 className="font-heading text-title">New {kind.toLowerCase()}</h1>
          {loadError && !shown ? (
            <div role="alert" data-testid="sheet-load-error" className="flex flex-col gap-2">
              <p className="text-destructive">
                Couldn't load your workspaces: {errorMessage(loadError)}
              </p>
              <Button
                type="button"
                variant="outline"
                className="self-start"
                onClick={() => void queryClient.invalidateQueries({ queryKey: ["workspaces"] })}
              >
                Retry
              </Button>
            </div>
          ) : !shown || settings === undefined ? (
            <p role="status" className="flex items-center gap-2 text-muted-foreground">
              <Spinner aria-hidden className="size-icon-row" />
              {settings !== undefined && !explicitModel && !modelsSettled
                ? "Finding your agents…"
                : "Loading…"}
            </p>
          ) : (
            <SheetForm
              initial={seedDraft(from, repo, projects, workspaces)}
              starting={starting}
              projects={projects}
              workspaces={workspaces}
              welcomeSeen={settings.onboarding.welcomeSeen}
              read={read}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** The draft the sheet opens with: the picked repo, and the charter of the workspace it starts from. */
const seedDraft = (
  from: WorkspaceId | undefined,
  repo: ProjectId | undefined,
  projects: readonly Project[],
  workspaces: readonly WorkspaceState[],
): NewWorkspaceDraft => {
  const source = workspaces.find((state) => state.workspace.id === from);
  const picked = projects.some((project) => project.id === repo) ? repo : undefined;
  const withRepo =
    picked === undefined ? emptyNewWorkspace : toggleRepo(emptyNewWorkspace, picked, true);
  return source === undefined ? withRepo : startFrom(withRepo, source);
};

function SheetForm({
  initial,
  starting,
  projects,
  workspaces,
  welcomeSeen,
  read,
}: {
  initial: NewWorkspaceDraft;
  starting: OrchestratorCharter;
  projects: readonly Project[];
  workspaces: readonly WorkspaceState[];
  welcomeSeen: boolean;
  read: boolean;
}) {
  const api = useApi();
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const save = useSaveSettings();

  // Kept in a ref as well, written by every change, so a Start that first waits for a typed
  // repository to be added goes on with the draft that has it.
  const [draft, setDraftState] = useState(initial);
  const draftRef = useRef(initial);
  const setDraft = (update: (current: NewWorkspaceDraft) => NewWorkspaceDraft) => {
    const next = update(draftRef.current);
    draftRef.current = next;
    setDraftState(next);
  };
  const charter = charterOf(draft, starting);
  // Repositories added here, named before the projects list has them.
  const addedRef = useRef<readonly Project[]>([]);
  const [added, setAdded] = useState<readonly Project[]>([]);
  const known = useMemo(
    () => [...projects, ...added.filter((each) => !projects.some((p) => p.id === each.id))],
    [projects, added],
  );
  const [issue, setIssue] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ state: WorkspaceState; text: string | undefined }>();
  const [pending, setPending] = useState(false);
  // Where the deployment starts machines on demand, the person's own runs the orchestrator: with
  // none online the card to start it shows here, and a workspace started meanwhile opens once it
  // is up, rather than failing for want of one.
  const onDemand = useOnDemandMachine();
  const machineWanted = needsMachine(onDemand.status);
  const [waiting, setWaiting] = useState(false);
  const noun = useMachineNoun();
  const kind = useThreadsWorkspaceNoun();
  const reachesTheirs = useMachineReachesTheirs();
  // Stops a wait for the machine when the sheet goes.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  /**
   * Opens `state` once the person's machine is online, starting it with their defaults where it
   * reaches all their repositories and none is on its way: Start is then the one click. Where
   * repositories are picked for it, the card above starts it. A start that fails says so on the
   * card, with Try again, and Start stops waiting on it.
   */
  const openOnceUp = async (state: WorkspaceState, text: string | undefined) => {
    setWaiting(true);
    try {
      if (reachesTheirs && !isComing(onDemand.status)) await startOnDemand([]);
      for (;;) {
        const status = await queryClient.fetchQuery({
          queryKey: ON_DEMAND_QUERY_KEY,
          queryFn: fetchOnDemandStatus,
          staleTime: 0,
        });
        if (!alive.current) return;
        if (!needsMachine(status)) break;
        if (status?.progress?.phase === "failed") return setWaiting(false);
        await new Promise((resolve) => setTimeout(resolve, MACHINE_POLL_MS));
      }
    } catch (e) {
      setWaiting(false);
      return setIssue(errorMessage(e) || `Couldn't start your ${noun}.`);
    }
    setWaiting(false);
    await open(state, text);
  };
  // With nothing picked yet, adding a repository is the first thing to do.
  const [adding, setAdding] = useState(initial.projectIds.length === 0);
  const repositoryRef = useRef<AddRepositoryHandle>(null);
  // Discover goes once per workspace made here, however many times opening it is retried.
  const discovered = useRef(false);
  // Whether Start has the orchestrator read the repositories first. Until the person says, it
  // follows the task: with one it reads first, with none nothing runs until a task is sent. Opened
  // from the first-run card, whose line promises the survey, it starts ticked.
  const [survey, setSurvey] = useState<boolean | undefined>(read ? true : undefined);
  const reads = survey ?? firstMessageOf(draft) !== undefined;
  const taskId = useId();
  // With a repo picked, focus goes to the task: what is next.
  const focusTask = useCallback(
    (element: HTMLTextAreaElement | null) => {
      if (element !== null && !adding) focusIfConnected(element);
    },
    [adding],
  );

  const cancel = () => {
    if (router.history.canGoBack()) router.history.back();
    else void navigate({ to: "/" });
  };

  /** Opens the new workspace's orchestrator, handing it the first message when there is one. */
  const open = async (state: WorkspaceState, text: string | undefined) => {
    setBusy(true);
    setIssue(undefined);
    try {
      const thread =
        text === undefined
          ? await api.openOrchestrator({ workspaceId: state.workspace.id })
          : await api.startTask({ target: { workspaceId: state.workspace.id }, input: { text } });
      // A new workspace discovers itself when the person keeps that on, as the Discover menu item
      // asks: queued behind the first message, if there is one. A failure costs only the survey.
      if (reads && !discovered.current) {
        discovered.current = true;
        await sendDiscover(api, thread.id).catch((e: unknown) =>
          console.error("new workspace: discover", e),
        );
      }
      useLayoutStore.getState().openThread(thread.id);
      await navigate({ to: "/t/$threadId", params: { threadId: thread.id } });
    } catch (e) {
      setBusy(false);
      setIssue(errorMessage(e) || "Couldn't open the orchestrator.");
    }
  };

  /** Makes the workspace from the sheet, once: its state and first message, or nothing on a refusal. */
  const create = async (): Promise<
    { state: WorkspaceState; text: string | undefined } | undefined
  > => {
    if (created !== undefined) return created;
    // A repository typed but not added yet is added first, as Enter would.
    const typed = repositoryRef.current?.submit();
    if (typed !== undefined) {
      if (!(await typed)) return undefined;
    } else if (pending) {
      setIssue("Wait for the repository to finish adding.");
      return undefined;
    }
    const current = draftRef.current;
    const result = createInput(current, starting, [...projects, ...addedRef.current], workspaces);
    if ("error" in result) {
      setAdding(true);
      setIssue(result.error);
      return undefined;
    }
    setBusy(true);
    setIssue(undefined);
    let state: WorkspaceState;
    try {
      state = await api.saveWorkspace(result.input);
    } catch (e) {
      setBusy(false);
      setIssue(errorMessage(e) || "Couldn't create the workspace.");
      return undefined;
    }
    const made = { state, text: firstMessageOf(current) };
    setCreated(made);
    await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    // The first run is done once there is a workspace, not when the sheet opens: leaving it by
    // Esc keeps the first-run screen for next time.
    if (!welcomeSeen) {
      useWelcome.setState({ open: false });
      save({ onboarding: { welcomeSeen: true } }).catch((e: unknown) =>
        console.error("new workspace: welcome", e),
      );
    }
    return made;
  };

  const start = async () => {
    if (busy) return;
    const made = await create();
    if (made === undefined) return;
    if (machineWanted) {
      setBusy(false);
      return void openOnceUp(made.state, made.text);
    }
    await open(made.state, made.text);
  };

  /** Saves the workspace and runs nothing: no machine, no orchestrator, no model call. */
  const saveOnly = async () => {
    if (busy || waiting) return;
    const made = await create();
    if (made === undefined) return;
    setBusy(false);
    await navigate({ to: "/threads" });
  };

  useShortcut({
    id: "draft.create",
    keys: "mod+enter",
    label: "Start the workspace",
    group: "Composer",
    run: () => void start(),
  });

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || inPopup(event.target)) return;
    if (event.key !== "Escape") return;
    // Esc never throws away what was typed: in a field with text it only leaves the field.
    const target = event.target;
    if (
      (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) &&
      target.value !== ""
    ) {
      event.preventDefault();
      target.blur();
      return;
    }
    event.preventDefault();
    cancel();
  };

  const source = workspaces.find((state) => state.workspace.id === draft.from);

  return (
    <form
      aria-label={`New ${kind.toLowerCase()}`}
      aria-busy={pending || undefined}
      className="flex flex-col gap-5"
      noValidate
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
    >
      <ReposField
        draft={draft}
        projects={known}
        onAdded={(project) => {
          addedRef.current = [...addedRef.current, project];
          setAdded(addedRef.current);
        }}
        adding={adding}
        onAdding={setAdding}
        onChange={(update) => {
          setIssue(undefined);
          setDraft(update);
        }}
        repositoryRef={repositoryRef}
        onPendingChange={setPending}
      />
      <AutonomyChoice
        testId="autonomy"
        explain
        value={autonomyOf(charter)}
        onChange={(autonomy) =>
          setDraft((current) => ({
            ...current,
            charter: withAutonomy(charterOf(current, starting), autonomy),
          }))
        }
      />
      <WorkspaceModels
        charter={charter}
        disabled={busy || waiting || created !== undefined}
        onChange={(next) => setDraft((current) => ({ ...current, charter: next }))}
      />
      <Field label="What should it work on?" htmlFor={taskId}>
        <Textarea
          ref={focusTask}
          id={taskId}
          data-testid="new-workspace-task"
          rows={3}
          // As wide as the rows above it: a settings field's own width stopped it short of them.
          className="min-h-18"
          value={draft.task}
          placeholder="Optional"
          onChange={(event) => {
            const task = event.target.value;
            setDraft((current) => ({ ...current, task }));
          }}
        />
      </Field>
      <Checkbox
        data-testid="new-workspace-discover"
        label="Read the repositories first"
        description="The orchestrator surveys them before the first task. A few minutes of model use."
        checked={reads}
        disabled={created !== undefined}
        onCheckedChange={setSurvey}
      />
      <StartSteps
        machine={machineWanted ? noun : undefined}
        reads={reads}
        task={firstMessageOf(draft) !== undefined}
      />
      {issue !== undefined && <FormError message={issue} />}
      {/* Where the machine reaches every repository, Start starts it: no second start. */}
      {machineWanted && !reachesTheirs && <StartMachineCard />}
      <div className="flex flex-wrap items-center gap-2">
        <PressScale>
          <Button
            type="submit"
            data-testid="new-workspace-start"
            disabled={busy || waiting}
            aria-label={waiting ? `Start, waiting for your ${noun}` : undefined}
          >
            {(busy || waiting) && <Spinner aria-hidden />}
            {waiting
              ? `Opens once your ${noun} is up…`
              : created === undefined
                ? "Start"
                : "Open orchestrator"}
            <ShortcutKbd id="draft.create" cap />
          </Button>
        </PressScale>
        {created === undefined && (
          <Button
            type="button"
            variant="outline"
            data-testid="new-workspace-save"
            disabled={busy || waiting}
            onClick={() => void saveOnly()}
          >
            Save without starting
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={cancel}>
          Cancel
        </Button>
        {source !== undefined && (
          <span
            data-testid="new-workspace-from"
            className="ml-auto text-meta text-muted-foreground"
          >
            Setup from {source.workspace.name}
          </span>
        )}
      </div>
    </form>
  );
}

/**
 * What Start will do, in order, so nothing it starts is a surprise: the machine where one is
 * needed, the survey where it is on, then the first task, or a wait for one with nothing run.
 */
function StartSteps({
  machine,
  reads,
  task,
}: {
  /** The machine's word where Start must start one first. */
  machine: string | undefined;
  reads: boolean;
  task: boolean;
}) {
  const steps = [
    ...(machine === undefined ? [] : [`Start a ${machine} and check out the repositories`]),
    ...(reads ? ["The orchestrator reads the repositories"] : []),
    task
      ? "The orchestrator plans the first task and starts workers"
      : "Wait for your first task. Nothing else runs until you send one.",
  ];
  return (
    <div data-testid="new-workspace-steps" className="flex flex-col gap-1.5">
      <span className="text-meta font-medium text-muted-foreground">Start will</span>
      <ol className="flex flex-col gap-1 text-meta">
        {steps.map((step, index) => (
          <li key={step} className="flex items-baseline gap-2">
            <span
              aria-hidden
              className="w-4 shrink-0 text-right text-muted-foreground tabular-nums"
            >
              {index + 1}.
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function WorkspaceModels({
  charter,
  disabled,
  onChange,
}: {
  charter: OrchestratorCharter;
  disabled: boolean;
  onChange: (charter: OrchestratorCharter) => void;
}) {
  const [opened, setOpened] = useState(false);
  const own = useSlotModel(charter.orchestratorModel);
  const inherited = useDefaultModel();
  const orchestrator = charter.orchestratorModel === undefined ? inherited : own;
  const workers = charter.workerModels ?? [];
  const roster = useRosterHere(workers);
  const defaultIndex = defaultWorkerIndex(workers);
  const picked = defaultIndex === undefined ? undefined : roster[defaultIndex];
  const worker =
    picked === undefined ? orchestrator : picked.missing === undefined ? picked.entry : undefined;
  const nameOf = useModelNames([orchestrator, worker]);

  return (
    <details
      className={FOLD}
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true);
      }}
    >
      <FoldSummary className="items-baseline text-reading">
        <span className="font-medium">Models</span>
        {(orchestrator || worker) && (
          <span className="flex flex-wrap gap-x-4 text-meta text-description">
            {orchestrator && <span>Orchestrator · {nameOf(orchestrator)}</span>}
            {worker && <span>Default worker · {nameOf(worker)}</span>}
          </span>
        )}
      </FoldSummary>
      {opened && (
        <div className="mt-3 flex flex-col gap-4">
          <Suspense
            fallback={<Spinner aria-label="Loading model settings" className="size-icon-row" />}
          >
            <RosterEditor
              charter={charter}
              disabled={disabled}
              onChange={onChange}
              orchestratorDescription="Used for the repository survey and the first task."
            />
          </Suspense>
        </div>
      )}
    </details>
  );
}

/**
 * The workspace's repositories as chips, removed with ×; Add opens the known and found
 * repositories not picked yet, to tick, and a field for a folder or a GitHub repo to clone. The first is home.
 */
function ReposField({
  draft,
  projects,
  adding,
  onAdding,
  onChange,
  onPendingChange,
  onAdded,
  repositoryRef,
}: {
  draft: NewWorkspaceDraft;
  projects: readonly Project[];
  onAdded: (project: Project) => void;
  adding: boolean;
  onAdding: (adding: boolean) => void;
  onChange: (update: (draft: NewWorkspaceDraft) => NewWorkspaceDraft) => void;
  onPendingChange: (pending: boolean) => void;
  repositoryRef: React.RefObject<AddRepositoryHandle | null>;
}) {
  // Either a box being ticked or the field below can be adding a repository.
  const [ticking, setTicking] = useState(false);
  const [typing, setTyping] = useState(false);
  useEffect(() => onPendingChange(ticking || typing), [ticking, typing, onPendingChange]);
  const anyRoot = projects.find((project) => project.id === draft.homeProjectId)?.root;
  return (
    // `min-w-0`: a fieldset is as wide as its widest content by default, so one long row would
    // push the field past the sheet.
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-2 font-medium">Repositories</legend>
      <div className="flex flex-wrap items-center gap-1.5" data-testid="new-workspace-repos">
        {draft.projectIds.map((projectId) => {
          const name = projectNameOf(projects, projectId);
          return (
            <span
              key={projectId}
              data-testid="new-workspace-repo"
              className="flex items-center gap-1 rounded-full border border-border py-0.5 ps-2.5 pe-1 text-meta"
            >
              {name}
              <button
                type="button"
                aria-label={`Remove ${name}`}
                className="flex size-4 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                onClick={() => onChange((current) => toggleRepo(current, projectId, false))}
              >
                <X aria-hidden className="size-icon-row" />
              </button>
            </span>
          );
        })}
        <Button
          type="button"
          size="xs"
          variant="ghost"
          data-testid="new-workspace-add"
          aria-expanded={adding}
          onClick={() => onAdding(!adding)}
        >
          Add
        </Button>
      </div>
      {/* Kept mounted while closed, so closing it can't abort a clone under way. */}
      <Expand open={adding}>
        <div className="flex flex-col gap-2 pt-1" hidden={!adding}>
          <RepositoryChecklist
            testId="new-workspace-checklist"
            className="flex max-h-48 flex-col gap-1 overflow-y-auto"
            autofocus={adding}
            projects={projects}
            picked={draft.projectIds}
            onToggle={(projectId, included) =>
              onChange((current) => toggleRepo(current, projectId, included))
            }
            onPendingChange={setTicking}
            empty={null}
            // The chips above are the picks; the list offers the rest.
            hidePicked
          />
          <AddRepository
            ref={repositoryRef}
            onPendingChange={setTyping}
            defaultPath={anyRoot === undefined ? undefined : parentFolder(anyRoot)}
            onAdded={(project) => {
              onAdded(project);
              onChange((current) => toggleRepo(current, project.id, true));
            }}
          />
        </div>
      </Expand>
    </fieldset>
  );
}
