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
import { Plus, X } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { useModelsSettled } from "@/composer/models";
import { useShortcut } from "@/keyboard/registry";
import { ShortcutKbd } from "@/keyboard/use-shortcut-hint";
import { focusIfConnected } from "@/lib/use-return-focus";
import { Expand, PressScale, Spinner } from "@/motion";
import { AddRepository, type AddRepositoryHandle } from "@/new-thread/add-repository";
import { AutonomyField } from "@/settings/autonomy-field";
import { Field, inputCls } from "@/settings/fields";
import { useSaveSettings } from "@/settings/use-save-settings";
import { projectNameOf, withAutonomy } from "@/settings/workspace-settings-model";
import { useServerSettings } from "@/settings-sync/store";
import { useLayoutStore } from "@/stores/layout";
import { useWelcome } from "@/welcome/welcome";

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
import { useWorkspacesQuery } from "./use-orchestration";
import { parentFolder } from "./workspace-repos";

/** Where a key press belongs to an open menu, list or dialog rather than to the sheet. */
const inPopup = (target: EventTarget) =>
  target instanceof Element &&
  target.closest('[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]') !== null;

/**
 * New workspace, on one sheet: its repositories, what it should work on, and how far it goes
 * alone. Start makes the workspace and opens its orchestrator, with "What should it work on?" as
 * its first message when filled in. The name comes from the home repository; models and stages
 * start from the defaults, or from `from`'s charter, and wait for the workspace's settings.
 * ⌘Enter starts, Esc leaves.
 */
export function NewWorkspaceSheet({
  from,
  repo,
}: {
  from?: WorkspaceId | undefined;
  repo?: ProjectId | undefined;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
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
      <div className="flex min-h-full items-center justify-center p-6">
        <div
          data-testid="new-workspace"
          className="flex w-full max-w-lg flex-col gap-5 rounded-lg border border-border bg-card p-5 text-sm text-card-foreground"
        >
          <h1 className="font-heading text-base font-medium">New workspace</h1>
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
                Try again
              </Button>
            </div>
          ) : !shown || settings === undefined ? (
            <p role="status" className="flex items-center gap-2 text-muted-foreground">
              <Spinner aria-hidden className="size-3.5" />
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
}: {
  initial: NewWorkspaceDraft;
  starting: OrchestratorCharter;
  projects: readonly Project[];
  workspaces: readonly WorkspaceState[];
  welcomeSeen: boolean;
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
  // With nothing picked yet, adding a repository is the first thing to do.
  const [adding, setAdding] = useState(initial.projectIds.length === 0);
  const repositoryRef = useRef<AddRepositoryHandle>(null);
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
      useLayoutStore.getState().openThread(thread.id);
      await navigate({ to: "/t/$threadId", params: { threadId: thread.id } });
    } catch (e) {
      setBusy(false);
      setIssue(errorMessage(e) || "Couldn't open the orchestrator.");
    }
  };

  const start = async () => {
    if (busy) return;
    if (created !== undefined) return void open(created.state, created.text);
    // A repository typed but not added yet is added first, as Enter would.
    const typed = repositoryRef.current?.submit();
    if (typed !== undefined) {
      if (!(await typed)) return;
    } else if (pending) {
      return setIssue("Wait for the repository to finish adding.");
    }
    const current = draftRef.current;
    const result = createInput(current, starting, [...projects, ...addedRef.current], workspaces);
    if ("error" in result) {
      setAdding(true);
      return setIssue(result.error);
    }
    setBusy(true);
    setIssue(undefined);
    let state: WorkspaceState;
    try {
      state = await api.saveWorkspace(result.input);
    } catch (e) {
      setBusy(false);
      setIssue(errorMessage(e) || "Couldn't create the workspace.");
      return;
    }
    const text = firstMessageOf(current);
    setCreated({ state, text });
    await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    // The first run is done once there is a workspace, not when the sheet opens: leaving it by
    // Esc keeps the first-run screen for next time.
    if (!welcomeSeen) {
      useWelcome.setState({ open: false });
      save({ onboarding: { welcomeSeen: true } }).catch((e: unknown) =>
        console.error("new workspace: welcome", e),
      );
    }
    await open(state, text);
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
      aria-label="New workspace"
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
      <Field label="What should it work on?" htmlFor={taskId}>
        <textarea
          ref={focusTask}
          id={taskId}
          data-testid="new-workspace-task"
          rows={3}
          className={`${inputCls} h-auto min-h-18 resize-y py-1.5`}
          value={draft.task}
          placeholder="Optional"
          onChange={(event) => {
            const task = event.target.value;
            setDraft((current) => ({ ...current, task }));
          }}
        />
      </Field>
      <AutonomyField
        value={autonomyOf(charter)}
        disabled={false}
        error={undefined}
        onChange={(autonomy) =>
          setDraft((current) => ({
            ...current,
            charter: withAutonomy(charterOf(current, starting), autonomy),
          }))
        }
      />
      {issue !== undefined && (
        <p role="alert" className="text-destructive">
          {issue}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <PressScale>
          <Button type="submit" data-testid="new-workspace-start" disabled={busy}>
            {busy && <Spinner aria-hidden />}
            {created === undefined ? "Start" : "Open orchestrator"}
            <ShortcutKbd id="draft.create" className="opacity-70" />
          </Button>
        </PressScale>
        <Button type="button" variant="ghost" onClick={cancel}>
          Cancel
        </Button>
        {source !== undefined && (
          <span data-testid="new-workspace-from" className="ml-auto text-xs text-muted-foreground">
            Setup from {source.workspace.name}
          </span>
        )}
      </div>
    </form>
  );
}

/**
 * The workspace's repositories as chips, removed with ×; Add opens the known and found
 * repositories to tick, and a field for a folder or a GitHub repo to clone. The first is home.
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
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 font-medium">Repositories</legend>
      <div className="flex flex-wrap items-center gap-1.5" data-testid="new-workspace-repos">
        {draft.projectIds.map((projectId) => {
          const name = projectNameOf(projects, projectId);
          return (
            <span
              key={projectId}
              data-testid="new-workspace-repo"
              className="flex items-center gap-1 rounded-full border border-border py-0.5 ps-2.5 pe-1 text-xs"
            >
              {name}
              <button
                type="button"
                aria-label={`Remove ${name}`}
                className="flex size-4 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                onClick={() => onChange((current) => toggleRepo(current, projectId, false))}
              >
                <X aria-hidden className="size-3" />
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
          <Plus data-icon="inline-start" />
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
