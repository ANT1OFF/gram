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
import { FormError } from "@/components/form-error";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Textarea } from "@/components/ui/input";
import { carriedDraft } from "@/composer/draft-prefill";
import { useModelsSettled } from "@/composer/models";
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
import { useSaveSettings } from "@/settings/use-save-settings";
import { projectNameOf, withAutonomy } from "@/settings/workspace-settings-model";
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
  workspaceNameFor,
  type NewWorkspaceDraft,
} from "./new-workspace-model";
import { EnvironmentField, useEnvironments } from "./environment-field";
import { environmentLabel } from "./environment-field-model";
import { RepositoryAccess } from "./repository-access";
import { WorkspaceModels } from "./workspace-models";
import { SavedNotOpened } from "./saved-not-opened";
import { StartSteps } from "./start-steps";
import { RepositoryChecklist } from "./repository-checklist";
import { sendDiscover } from "./use-board-actions";
import { useWorkspacesQuery } from "./use-orchestration";
import { parentFolder } from "./workspace-repos";
import { sleep } from "@/lib/sleep";

const MACHINE_POLL_MS = 1000;

/** Where a key press belongs to an open menu, list or dialog rather than to the sheet. */
const inPopup = (target: EventTarget) =>
  target instanceof Element &&
  target.closest('[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]') !== null;

/**
 * New workspace, on one sheet: its name, repositories and what it should work on beside how far it
 * goes alone and on which models. Start makes the workspace and opens its orchestrator, with "What
 * should it work on?" as its first message when filled in. Left blank, the name is the home
 * repository's, shown in the field until one is typed. The model defaults come from settings or
 * `from`'s charter, and can be changed before the first turn.
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
  const kind = useThreadsWorkspaceNoun();
  const settings = useServerSettings((s) => s.settings);
  const { data: projects = [], isSuccess: projectsLoaded } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
  const { workspaces, settled, error: loadError } = useWorkspacesQuery();
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
  const [carried] = useState(() => carriedDraft()?.text);
  const [shown, setShown] = useState(false);
  if (loaded && !shown) setShown(true);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex min-h-full items-center-safe justify-center p-6">
        <div
          data-testid="new-workspace"
          className="flex w-full max-w-4xl flex-col gap-5 rounded-lg border border-edge bg-card p-5 text-reading text-card-foreground"
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
                onClick={() =>
                  void queryClient.invalidateQueries({
                    queryKey: ["workspaces"],
                  })
                }
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
              initial={seedDraft(from, repo, projects, workspaces, carried)}
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

const seedDraft = (
  from: WorkspaceId | undefined,
  repo: ProjectId | undefined,
  projects: readonly Project[],
  workspaces: readonly WorkspaceState[],
  task: string | undefined,
): NewWorkspaceDraft => {
  const source = workspaces.find((state) => state.workspace.id === from);
  const picked = projects.some((project) => project.id === repo) ? repo : undefined;
  const empty = task === undefined ? emptyNewWorkspace : { ...emptyNewWorkspace, task };
  const withRepo = picked === undefined ? empty : toggleRepo(empty, picked, true);
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

  const [draft, setDraftState] = useState(initial);
  const draftRef = useRef(initial);
  const setDraft = (update: (current: NewWorkspaceDraft) => NewWorkspaceDraft) => {
    const next = update(draftRef.current);
    draftRef.current = next;
    setDraftState(next);
  };
  const charter = charterOf(draft, starting);
  const addedRef = useRef<readonly Project[]>([]);
  const [added, setAdded] = useState<readonly Project[]>([]);
  const known = useMemo(
    () => [...projects, ...added.filter((each) => !projects.some((p) => p.id === each.id))],
    [projects, added],
  );
  const [issue, setIssue] = useState<string>();
  const [nameIssue, setNameIssue] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{
    state: WorkspaceState;
    text: string | undefined;
  }>();
  const [pending, setPending] = useState(false);
  const onDemand = useOnDemandMachine();
  const environments = useEnvironments();
  const ownMachine = environments?.data !== undefined && draft.environment !== undefined;
  const machineWanted = !ownMachine && needsMachine(onDemand.status);
  const [waiting, setWaiting] = useState(false);
  const noun = useMachineNoun();
  const kind = useThreadsWorkspaceNoun();
  const reachesTheirs = useMachineReachesTheirs();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const openOnceUp = async (state: WorkspaceState, text: string | undefined) => {
    setWaiting(true);
    try {
      if (reachesTheirs && !isComing(onDemand.status)) await startOnDemand([]);
      for (;;) {
        const status = await queryClient.fetchQuery({
          queryKey: ON_DEMAND_QUERY_KEY,
          queryFn: () => fetchOnDemandStatus(),
          staleTime: 0,
        });
        if (!alive.current) return;
        if (!needsMachine(status)) break;
        if (status?.progress?.phase === "failed") return setWaiting(false);
        await sleep(MACHINE_POLL_MS);
      }
    } catch (e) {
      setWaiting(false);
      return setIssue(errorMessage(e) || `Couldn't start your ${noun}.`);
    }
    setWaiting(false);
    await open(state, text);
  };
  const [adding, setAdding] = useState(initial.projectIds.length === 0);
  const repositoryRef = useRef<AddRepositoryHandle>(null);
  const discovered = useRef(false);
  const [reads, setSurvey] = useState(read);
  const taskId = useId();
  const nameId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
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

  const open = async (state: WorkspaceState, text: string | undefined) => {
    setBusy(true);
    setIssue(undefined);
    try {
      const thread =
        text === undefined
          ? await api.openOrchestrator({ workspaceId: state.workspace.id })
          : await api.startTask({
              target: { workspaceId: state.workspace.id },
              input: { text },
            });
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

  const create = async (): Promise<
    { state: WorkspaceState; text: string | undefined } | undefined
  > => {
    if (created !== undefined) return created;
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
      if (result.field === "name") {
        setNameIssue(result.error);
        focusIfConnected(nameRef.current);
        return undefined;
      }
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
      {/* What it is on the left, how it runs on the right; one column where they don't fit. */}
      <fieldset
        disabled={created !== undefined}
        data-testid="new-workspace-fields"
        className="flex min-w-0 flex-wrap gap-x-7 gap-y-5"
      >
        <div className="flex min-w-0 flex-[1_1_20rem] flex-col gap-5">
          <Field
            label="Name"
            htmlFor={nameId}
            hint={
              nameIssue !== undefined ? (
                <span role="alert" className="text-destructive">
                  {nameIssue}
                </span>
              ) : draft.name.trim() === "" && created === undefined ? (
                <span className="text-meta text-muted-foreground">
                  Optional. Left empty, it is named after the first repository.
                </span>
              ) : undefined
            }
          >
            <Input
              ref={nameRef}
              id={nameId}
              data-testid="new-workspace-name"
              className="max-w-none"
              autoComplete="off"
              value={created === undefined ? draft.name : created.state.workspace.name}
              invalid={nameIssue !== undefined}
              placeholder={
                draft.homeProjectId === undefined
                  ? "The first repository's name"
                  : workspaceNameFor(draft, known, workspaces)
              }
              onChange={(event) => {
                const name = event.target.value;
                setNameIssue(undefined);
                setDraft((current) => ({ ...current, name }));
              }}
            />
          </Field>
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
          <Field label="What should it work on?" htmlFor={taskId}>
            <Textarea
              ref={focusTask}
              id={taskId}
              data-testid="new-workspace-task"
              rows={5}
              className="min-h-28"
              value={draft.task}
              placeholder="Optional"
              onChange={(event) => {
                const task = event.target.value;
                setDraft((current) => ({ ...current, task }));
              }}
            />
          </Field>
        </div>
        <div className="flex min-w-0 flex-[1_1_20rem] flex-col gap-5">
          <AutonomyChoice
            testId="autonomy"
            value={autonomyOf(charter)}
            onChange={(autonomy) =>
              setDraft((current) => ({
                ...current,
                charter: withAutonomy(charterOf(current, starting), autonomy),
              }))
            }
          />
          <EnvironmentField
            testId="new-workspace-environment"
            value={draft.environment}
            disabled={busy || waiting || created !== undefined}
            onChange={(environment) => setDraft((current) => ({ ...current, environment }))}
          />
          <RepositoryAccess projectIds={draft.projectIds} />
          <WorkspaceModels
            charter={charter}
            disabled={busy || waiting || created !== undefined}
            onChange={(next) => setDraft((current) => ({ ...current, charter: next }))}
          />
          <Checkbox
            data-testid="new-workspace-discover"
            label="Read the repositories first"
            description="The orchestrator surveys them before the first task. A few minutes of model use."
            checked={reads}
            disabled={created !== undefined}
            onCheckedChange={setSurvey}
          />
          <StartSteps
            machine={
              machineWanted || (ownMachine && onDemand.status !== undefined) ? noun : undefined
            }
            environment={environmentLabel(environments?.data, draft.environment)}
            reads={reads}
            task={firstMessageOf(draft) !== undefined}
          />
        </div>
      </fieldset>
      <div
        data-testid="new-workspace-actions"
        className="sticky bottom-0 z-10 -mx-5 -mb-5 flex flex-col gap-3 rounded-b-lg border-t border-edge bg-card px-5 pt-4 pb-5"
      >
        {issue !== undefined &&
          (created === undefined ? (
            <FormError message={issue} />
          ) : (
            <SavedNotOpened name={created.state.workspace.name} reason={issue} />
          ))}
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
          <Button
            type="button"
            variant="outline"
            data-testid="new-workspace-save"
            disabled={busy || waiting}
            onClick={() => void saveOnly()}
          >
            {created === undefined ? "Save without starting" : "Leave it saved"}
          </Button>
          {created === undefined && (
            <Button type="button" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          )}
          {source !== undefined && (
            <span
              data-testid="new-workspace-from"
              className="ml-auto text-meta text-muted-foreground"
            >
              Setup from {source.workspace.name}
            </span>
          )}
        </div>
      </div>
    </form>
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
  const [ticking, setTicking] = useState(false);
  const [typing, setTyping] = useState(false);
  useEffect(() => onPendingChange(ticking || typing), [ticking, typing, onPendingChange]);
  const anyRoot = projects.find((project) => project.id === draft.homeProjectId)?.root;
  return (
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
