import {
  DEFAULT_CHARTER,
  autonomyOf,
  sendKeyOf,
  type DraftId,
  type ProjectId,
  type StartTaskInput,
  type WorkspaceId,
} from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { FolderGit2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { useApi } from "@/api/context";
import { HarnessPreflightNote, useHarnessPreflight } from "@/agents/feature-preflight";
import { HarnessSupportDetails } from "@/agents/support-details";
import { agentLabel } from "@/agents/agent-display";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { shortcutPressed } from "@/keyboard/bindings";
import { useShortcut } from "@/keyboard/registry";
import { ShortcutKbd, useShortcutHint } from "@/keyboard/use-shortcut-hint";
import {
  DictationMirror,
  DictationStrip,
  dictationStatus,
  DictationError,
  useCaretAtEnd,
  useComposerDictation,
  useMirrorFit,
} from "@/dictation/composer-dictation";
import { DictationButton } from "@/dictation/dictation-button";
import { focusIfConnected, focusLost } from "@/lib/use-return-focus";
import { PressScale, Spinner } from "@/motion";
import { useTaskDraftStore } from "@/orchestration/task-draft-store";
import {
  defaultTaskTarget,
  settledTaskTarget,
  taskRepos,
  taskTargetKey,
  type TaskTarget,
  type TaskWay,
} from "@/orchestration/task-model";
import { TaskTargetPicker } from "@/orchestration/task-target-picker";
import { useOrchestratorLedger, useWorkspacesQuery } from "@/orchestration/use-orchestration";
import { useServerSettings } from "@/settings-sync/store";
import { cn } from "@/lib/utils";
import { AutonomyChoice } from "@/new-thread/autonomy-choice";
import { NewFormHeader, WHO_ENTRY, type Who } from "@/new-thread/who-does-it";
import { WorkspaceAutonomy } from "@/new-thread/workspace-autonomy";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import { AttachmentChips } from "./attachment-chips";
import {
  carriedDraft,
  carryDraft,
  dropCarriedDraft,
  prefillDraftProject,
  dropTaskTarget,
  pendingTaskTarget,
  useRoutePick,
} from "./draft-prefill";
import { inOpenFence } from "./mention";
import { MentionMenu } from "./mention-menu";
import { enterSends } from "./send-key";
import { useAttachments } from "./use-attachments";
import { useMentions } from "./use-mentions";
import { useModelsSettled } from "./models";
import { SLAB, SLAB_TEXTAREA } from "./styles";
import { shownWorkerChoice, workerChoiceKey } from "./worker-choice";
import { WorkerFields } from "./worker-fields";

const labelCls = "text-xs font-medium text-muted-foreground";

/**
 * The New form for the orchestrator (⌘N's `/new-task`) or, with `initialWay` "direct" (⌥⌘N), for
 * one worker to start on at once: what needs doing, and the workspace it goes to. A repo with no
 * workspace gets one on send, at the autonomy picked above the goal. A single agent chat, the
 * one-off thread, is the other draft behind the same header.
 */
export function NewTaskDraft({
  initialWay,
  initialWorkspace,
}: {
  initialWay?: TaskWay | undefined;
  initialWorkspace?: WorkspaceId | undefined;
} = {}) {
  const api = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
  const { workspaces, settled } = useWorkspacesQuery();
  // The thread in the focused pane when the draft opened, which ⌘N leaves there.
  const [currentId] = useState(() => {
    const { grid } = useLayoutStore.getState();
    return grid.panes[grid.focused] ?? undefined;
  });
  const current = useThreadsStore((s) =>
    currentId === undefined ? undefined : s.byId[currentId]?.thread,
  );
  const last = useTaskDraftStore((s) => s.last);
  const pickedAutonomy = useTaskDraftStore((s) => s.autonomy);
  const rememberedWorkers = useTaskDraftStore((s) => s.workers);
  const sendKey = useServerSettings((s) => (s.settings ? sendKeyOf(s.settings) : undefined));

  const way: TaskWay = initialWay ?? "plan";
  // A pick in the "in" chip holds until a shortcut or the palette names another workspace.
  // Switching who does it keeps the workspace in the route, and so the pick.
  const [picked, setPicked] = useRoutePick<TaskTarget>(initialWorkspace ?? "", pendingTaskTarget);
  useEffect(dropTaskTarget, []);
  const named: TaskTarget | undefined =
    initialWorkspace !== undefined &&
    (!settled || workspaces.some((state) => state.workspace.id === initialWorkspace))
      ? { kind: "workspace", workspaceId: initialWorkspace }
      : undefined;
  const target = settledTaskTarget(
    picked ?? named ?? defaultTaskTarget({ current, workspaces, projects, last }),
    workspaces,
  );
  const repos = target === undefined ? [] : taskRepos(target, workspaces, projects);
  const [repoId, setRepoId] = useState<ProjectId>();
  const repo = repos.find((each) => each.id === repoId) ?? repos[0];
  const workspace =
    target?.kind === "workspace"
      ? workspaces.find((state) => state.workspace.id === target.workspaceId)
      : undefined;
  const makesOne = target?.kind === "repo";
  const name = workspace?.workspace.name ?? repos[0]?.name ?? "";
  const { data: ledger } = useOrchestratorLedger(workspace?.workspace.id);
  const agents = useServerSettings((s) => s.settings?.agents);
  const taskOptions: Pick<StartTaskInput, "target" | "direct" | "autonomy"> | undefined =
    target === undefined
      ? undefined
      : {
          target:
            target.kind === "workspace"
              ? { workspaceId: target.workspaceId }
              : { projectId: target.projectId },
          ...(way === "direct" && repo !== undefined ? { direct: { projectId: repo.id } } : {}),
          ...(makesOne && pickedAutonomy !== undefined ? { autonomy: pickedAutonomy } : {}),
        };
  const selection = useQuery({
    queryKey: [
      "task-preflight",
      taskOptions ?? null,
      workspace?.charter ?? null,
      workspace?.workspace.orchestratorThreadId ?? null,
      agents ?? null,
    ],
    queryFn: () => api.taskPreflight(taskOptions!),
    enabled: taskOptions !== undefined,
    retry: false,
    staleTime: 30_000,
  });
  const orchestratorModel = selection.data?.orchestrator;
  const preflight = useHarnessPreflight(
    orchestratorModel,
    "orchestrator",
    selection.data?.orchestratorThreadId === undefined
      ? {}
      : { threadId: selection.data.orchestratorThreadId },
  );
  // The roster the preview offers a direct worker; this draft's pick, else the target's last one.
  const workerChoices = way === "direct" ? (selection.data?.workerChoices ?? []) : [];
  const [pickedWorker, setPickedWorker] = useState<{ target: string; key: string }>();
  const targetKey = target === undefined ? undefined : taskTargetKey(target);
  const workerKey =
    pickedWorker !== undefined && pickedWorker.target === targetKey
      ? pickedWorker.key
      : targetKey === undefined
        ? undefined
        : rememberedWorkers[targetKey];
  const shownWorker =
    workerChoices.length === 0 ? undefined : shownWorkerChoice(workerChoices, workerKey);
  const workerModel =
    shownWorker === undefined
      ? selection.data?.worker
      : shownWorker.unavailable === undefined
        ? shownWorker.model
        : undefined;
  const workerPreflight = useHarnessPreflight(workerModel, "worker");
  const inputModel = way === "direct" ? workerModel : orchestratorModel;
  const inputModels = useModelsSettled(
    inputModel?.agent ?? "claude",
    inputModel !== undefined,
    inputModel?.profileId,
  );
  const imagePreflight = useHarnessPreflight(
    inputModel,
    "imageInput",
    inputModels.models === undefined ? {} : { models: inputModels.models },
  );

  const [carried] = useState(carriedDraft);
  useEffect(dropCarriedDraft, []);
  const [prompt, setPrompt] = useState(carried?.text ?? "");
  const [draftId] = useState(() => carried?.draftId ?? (crypto.randomUUID() as DraftId));
  const attachments = useAttachments({ draftId }, carried?.attachments);
  const hasImages = attachments.ready.some((attachment) =>
    attachment.mediaType?.startsWith("image/"),
  );
  const mentionRoot = (way === "direct" ? repo : repos[0])?.root;
  const mentions = useMentions({
    id: "mention-menu-new-task",
    text: prompt,
    setText: setPrompt,
    source:
      mentionRoot === undefined
        ? undefined
        : { key: ["path", mentionRoot], load: () => api.fsFiles({ path: mentionRoot }) },
  });
  const fieldRef = mentions.textareaProps.ref;
  const mirrorRef = useRef<HTMLDivElement>(null);
  const inserting = useRef(false);
  const [caretAtEnd, trackCaret] = useCaretAtEnd();
  const dictation = useComposerDictation({
    fieldRef,
    text: prompt,
    setText: setPrompt,
    insertingRef: inserting,
    enabled: true,
  });
  const dictateHint = useShortcutHint("composer.dictate");
  const partialInline = dictation.partial !== "" && caretAtEnd;
  const partialOverflows = useMirrorFit(
    fieldRef,
    mirrorRef,
    partialInline ? dictation.partial : undefined,
    prompt,
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  // "Start under my control": off unless asked for, so a worker started here is its orchestrator's.
  const [hold, setHold] = useState(false);
  const holdId = useId();
  const formRef = useRef<HTMLFormElement>(null);

  // Arriving here (⌘N, New task) leaves focus on the page it came from: go where typing starts.
  useEffect(() => {
    if (!focusLost()) return;
    focusIfConnected(formRef.current?.querySelector('textarea[aria-label="What needs doing"]'));
  }, []);

  const valid =
    target !== undefined &&
    prompt.trim() !== "" &&
    !attachments.uploading &&
    selection.data !== undefined &&
    !selection.isFetching &&
    !selection.isError &&
    !preflight.blocked &&
    (way !== "direct" || (workerModel !== undefined && !workerPreflight.blocked)) &&
    (!hasImages || !imagePreflight.blocked) &&
    (way === "plan" || repo !== undefined);

  const send = async () => {
    // A final still on its way would land after the draft is gone: stop, keeping what was heard,
    // and leave sending to the user once it is in.
    if (dictation.active) return dictation.stop();
    if (!valid || sending || selection.data === undefined) return;
    setSending(true);
    setError(undefined);
    // The worker picked from the roster is the one the server checks and starts.
    const chosenWorker = way === "direct" && shownWorker !== undefined ? workerModel : undefined;
    const { workerChoices: _choices, ...shown } = selection.data;
    try {
      const thread = await api.startTask({
        target:
          target.kind === "workspace"
            ? { workspaceId: target.workspaceId }
            : { projectId: target.projectId },
        input: {
          text: prompt.trim(),
          ...(attachments.ready.length > 0 ? { attachments: attachments.ready } : {}),
        },
        selection: chosenWorker === undefined ? shown : { ...shown, worker: chosenWorker },
        ...(attachments.ready.length > 0 ? { draftId } : {}),
        ...(way === "direct" && repo !== undefined
          ? {
              direct: {
                projectId: repo.id,
                ...(chosenWorker === undefined ? {} : { worker: chosenWorker }),
                ...(hold ? { hold: true } : {}),
              },
            }
          : {}),
        ...(makesOne && pickedAutonomy !== undefined ? { autonomy: pickedAutonomy } : {}),
      });
      useTaskDraftStore
        .getState()
        .remember(target, chosenWorker === undefined ? undefined : workerChoiceKey(chosenWorker));
      void navigate({ to: "/t/$threadId", params: { threadId: thread.id } });
    } catch (e) {
      setSending(false);
      setError(errorMessage(e) || "Couldn't start the task.");
      // A workspace made meanwhile is the target now, which only a fresh list shows.
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    }
  };

  useShortcut({
    id: "draft.create",
    keys: "mod+enter",
    label: "Start the task",
    group: "Composer",
    run: () => void send(),
  });

  // New workspace is a page of its own; what was typed comes back to the draft Esc returns to.
  const toNewWorkspace = () => {
    carryDraft({ text: prompt, draftId, attachments: attachments.ready });
    void navigate({ to: "/new-workspace" });
  };

  const toOneOff = () => {
    if (attachments.uploading) return;
    carryDraft({ text: prompt, draftId, attachments: attachments.ready });
    prefillDraftProject(repos[0]?.root);
    useTaskDraftStore.getState().rememberEntry("oneOff");
    void navigate({ to: "/new" });
  };

  // The orchestrator and a worker are this draft on another way; the workspace and what was typed stay.
  const pickWho = (who: Who) => {
    if (who === "me") return toOneOff();
    useTaskDraftStore.getState().rememberEntry(WHO_ENTRY[who]);
    void navigate({
      to: "/new-task",
      search: {
        ...(who === "worker" ? { way: "direct" as const } : {}),
        ...(initialWorkspace === undefined ? {} : { workspace: initialWorkspace }),
      },
    });
  };

  const submitLabel =
    way === "plan"
      ? makesOne
        ? "Start workspace and send"
        : "Send to orchestrator"
      : makesOne
        ? "Start workspace and worker"
        : "Start worker";
  const budget = ledger?.budget;
  const repoName = repo?.name ?? name;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <form
        ref={formRef}
        className="mx-auto flex w-full max-w-(--thread-max-width) flex-col gap-5 p-6"
        aria-label="New task"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <NewFormHeader
          who={way === "direct" ? "worker" : "orchestrator"}
          onWho={pickWho}
          disabled={attachments.uploading}
          where={
            <>
              <TaskTargetPicker
                value={target}
                disabled={attachments.uploading}
                workspaces={workspaces}
                projects={projects}
                onPick={(next) => {
                  if (next.kind === "newWorkspace") return toNewWorkspace();
                  setPicked(next);
                  setRepoId(undefined);
                }}
              />
              {way === "direct" && repo !== undefined && repos.length > 1 && (
                <Select
                  value={repo.id}
                  items={repos.map((each) => ({ value: each.id, label: each.name }))}
                  onValueChange={(value) => {
                    if (value !== null) setRepoId(value as ProjectId);
                  }}
                >
                  <SelectTrigger size="sm" aria-label="Repo" className="h-7 text-xs">
                    <FolderGit2 aria-hidden />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {repos.map((each) => (
                      <SelectItem key={each.id} value={each.id}>
                        {each.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </>
          }
          line={
            target === undefined && settled
              ? "Gram doesn't know a repository to start a workspace in yet. Pick Single agent chat to open one, or add one under Settings → Workspaces."
              : way === "plan"
                ? `${makesOne ? `Makes a workspace for ${name}. Its` : `${name}'s`} orchestrator plans it, briefs workers into their own worktrees and follows their pull requests to merged.`
                : hold
                  ? `One worker starts now on a new branch of ${repoName}, in its own worktree, under your control: you direct it, and ${makesOne ? "the orchestrator of the workspace made for it" : "the orchestrator"} only follows its pull request until you hand it back.`
                  : `One worker starts now on a new branch of ${repoName}, in its own worktree, with your words as its brief. ${makesOne ? "The workspace made for it" : "The orchestrator"} directs it like its own.`
          }
        />

        {makesOne && (
          <AutonomyChoice
            label="Autonomy of the new workspace"
            value={pickedAutonomy ?? autonomyOf(DEFAULT_CHARTER)}
            onChange={(next) => useTaskDraftStore.getState().rememberAutonomy(next)}
          />
        )}

        <div className="flex flex-col gap-2">
          <span className={labelCls}>What needs doing</span>
          <div
            className={SLAB}
            onKeyDownCapture={dictation.onKeyDownCapture}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              attachments.add(event.dataTransfer.files);
            }}
          >
            {mentions.open && (
              <MentionMenu
                id={mentions.id}
                entries={mentions.entries}
                activeIndex={mentions.activeIndex}
                onChoose={mentions.choose}
              />
            )}
            <AttachmentChips
              items={attachments.items}
              onRemove={attachments.remove}
              className="px-2 pt-2"
            />
            <div className="relative">
              {partialInline && (
                <DictationMirror
                  ref={mirrorRef}
                  text={prompt}
                  partial={dictation.partial}
                  className="px-4 pt-3 pb-1"
                />
              )}
              <textarea
                {...mentions.textareaProps}
                aria-label="What needs doing"
                role="combobox"
                aria-expanded={mentions.open}
                aria-controls={mentions.open ? mentions.id : undefined}
                aria-activedescendant={
                  mentions.open ? `${mentions.id}-${mentions.activeIndex}` : undefined
                }
                aria-autocomplete="list"
                rows={4}
                className={cn(SLAB_TEXTAREA, "relative min-h-28")}
                // Cleared from the start of dictation, so the first words don't land on it.
                placeholder={
                  dictation.active
                    ? ""
                    : "Describe the change, the goal, or a bug. Type @ to mention a file, or paste or drop files to attach them."
                }
                value={prompt}
                onFocus={(event) => {
                  mentions.textareaProps.onFocus();
                  trackCaret(event.currentTarget);
                  dictation.prewarm();
                }}
                onSelect={(event) => {
                  mentions.textareaProps.onSelect(event);
                  trackCaret(event.currentTarget);
                }}
                onScroll={(event) => {
                  if (mirrorRef.current)
                    mirrorRef.current.scrollTop = event.currentTarget.scrollTop;
                }}
                onChange={(event) => {
                  setPrompt(event.target.value);
                  dictation.typed();
                  trackCaret(event.target);
                  mentions.onChange(event.target.value, event.target.selectionStart);
                }}
                onKeyDown={(event) => {
                  if (mentions.onKeyDown(event)) return;
                  const { value, selectionStart } = event.currentTarget;
                  if (
                    (!inOpenFence(value.slice(0, selectionStart)) &&
                      enterSends(event.nativeEvent, sendKey)) ||
                    shortcutPressed("draft.create", event.nativeEvent)
                  ) {
                    event.preventDefault();
                    void send();
                  }
                }}
                onPaste={(event) => {
                  if (attachments.add(event.clipboardData.files)) event.preventDefault();
                  else mentions.onPaste();
                }}
              />
            </div>
            {dictation.partial !== "" && (!caretAtEnd || (partialInline && partialOverflows)) && (
              <DictationStrip partial={dictation.partial} />
            )}
            <DictationError state={dictation.state} />
            {(dictation.available || shownWorker !== undefined) && (
              <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
                {shownWorker !== undefined && (
                  <div role="group" aria-label="Worker" className="contents">
                    <span aria-hidden className="pl-1.5 text-xs text-muted-foreground">
                      Worker
                    </span>
                    <WorkerFields
                      choices={workerChoices}
                      shown={shownWorker}
                      disabled={sending}
                      onPick={(key) => {
                        if (targetKey !== undefined) setPickedWorker({ target: targetKey, key });
                      }}
                    />
                  </div>
                )}
                <span
                  aria-live="polite"
                  data-testid="draft-dictation-status"
                  className="min-w-0 flex-1 truncate px-1 text-xs text-muted-foreground"
                >
                  {dictation.active ? dictationStatus(dictation.state) : undefined}
                </span>
                {dictation.available && (
                  <DictationButton
                    state={dictation.state}
                    hint={dictateHint}
                    level={dictation.level}
                    onToggle={dictation.toggle}
                  />
                )}
              </div>
            )}
          </div>
        </div>

        {way === "direct" && (
          <div data-testid="task-hold" className="flex items-start gap-2">
            <Switch
              id={holdId}
              aria-describedby={`${holdId}-line`}
              checked={hold}
              disabled={sending}
              onCheckedChange={setHold}
              className="mt-0.5"
            />
            <div className="flex min-w-0 flex-col gap-0.5 text-xs">
              <label htmlFor={holdId} className="font-medium text-foreground">
                Start under my control
              </label>
              <span id={`${holdId}-line`} className="text-muted-foreground">
                You direct it yourself, and the orchestrator can't message it until you hand it
                back.
              </span>
            </div>
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-3">
          {orchestratorModel === undefined ? (
            <p className="text-xs text-muted-foreground">Checking the task's selected harness…</p>
          ) : (
            way === "plan" && (
              <p className="text-xs text-muted-foreground">
                {`Orchestrator: ${agentLabel(orchestratorModel.agent)} · ${orchestratorModel.model}`}
              </p>
            )
          )}
          {/* A direct worker's workspace still opens its orchestrator, so one that can't run
              blocks starting: shown then, and only then. */}
          {orchestratorModel !== undefined && (way === "plan" || preflight.blocked) && (
            <HarnessPreflightNote
              result={preflight.result}
              checking={preflight.checking}
              model={orchestratorModel}
              onRetry={async () => {
                await preflight.recheck();
                await selection.refetch();
              }}
            />
          )}
          {selection.isError && (
            <p role="alert" className="text-xs text-destructive">
              {errorMessage(selection.error)}{" "}
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => void selection.refetch()}
              >
                Retry task check
              </Button>
            </p>
          )}
          {shownWorker?.unavailable !== undefined && (
            <p role="alert" className="text-xs text-destructive">
              {agentLabel(shownWorker.model.agent)} {shownWorker.model.model} can't run here:{" "}
              {shownWorker.unavailable}. Pick another worker model.
            </p>
          )}
          {way === "direct" && workerModel !== undefined && (
            <>
              {shownWorker === undefined && (
                <p className="text-xs text-muted-foreground">
                  Worker: {agentLabel(workerModel.agent)} · {workerModel.model}
                </p>
              )}
              <HarnessPreflightNote
                result={workerPreflight.result}
                checking={workerPreflight.checking}
                model={workerModel}
                onRetry={async () => {
                  await workerPreflight.recheck();
                  await selection.refetch();
                }}
              />
            </>
          )}
          {hasImages && (
            <HarnessPreflightNote
              result={imagePreflight.result}
              checking={imagePreflight.checking}
              model={inputModel}
              onRetry={imagePreflight.recheck}
            />
          )}
          <HarnessSupportDetails
            observation={way === "direct" ? workerPreflight.observation : preflight.observation}
            imageInput={imagePreflight.result.support}
            threadId={way === "direct" ? undefined : selection.data?.orchestratorThreadId}
          />
          <div className="flex flex-wrap items-center gap-3">
            <PressScale>
              <Button type="submit" disabled={!valid || sending}>
                {sending && <Spinner aria-hidden />}
                {submitLabel}
                <ShortcutKbd id="draft.create" className="opacity-70" />
              </Button>
            </PressScale>
            {target !== undefined && !makesOne && (
              <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <WorkspaceAutonomy
                  state={workspace}
                  autonomy={autonomyOf(workspace?.charter ?? DEFAULT_CHARTER)}
                />
                {way === "plan" && budget !== undefined && (
                  <span
                    data-testid="task-workers"
                    className="rounded-sm border border-border px-1 tabular-nums"
                  >
                    {budget.liveWorkers} of {budget.maxConcurrentWorkers} workers
                  </span>
                )}
              </span>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
