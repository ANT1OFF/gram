import {
  DEFAULT_CHARTER,
  autonomyOf,
  sendKeyOf,
  type Autonomy,
  type DraftId,
  type ProjectId,
  type StartTaskInput,
} from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { FolderGit2 } from "lucide-react";
import { createElement, useEffect, useId, useRef, useState } from "react";

import { useApi } from "@/api/context";
import { HarnessPreflightNote, useHarnessPreflight } from "@/agents/feature-preflight";
import { HarnessSupportDetails } from "@/agents/support-details";
import { agentLabel } from "@/agents/agent-display";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
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
import { PressScale, SegmentSlab, Spinner } from "@/motion";
import { AUTONOMY_ICON, AutonomyChip } from "@/orchestration/autonomy-chip";
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
import { AUTONOMY_LEVELS, autonomyLevel } from "@/settings/workspace-settings-model";
import { cn } from "@/lib/utils";
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
  useTaskWayPrefill,
} from "./draft-prefill";
import { inOpenFence } from "./mention";
import { MentionMenu } from "./mention-menu";
import { enterSends } from "./send-key";
import { useAttachments } from "./use-attachments";
import { useMentions } from "./use-mentions";
import { useModelsSettled } from "./models";
import { shownWorkerChoice, workerChoiceKey } from "./worker-choice";
import { WorkerFields } from "./worker-fields";

const labelCls = "text-xs font-medium text-muted-foreground";

const WAYS: readonly { value: TaskWay; label: string }[] = [
  { value: "plan", label: "Orchestrator plans it" },
  { value: "direct", label: "Straight to a worker" },
];

/**
 * ⌘N's `/new-task` draft: what needs doing, for a workspace's orchestrator to plan or for one worker
 * to start on at once. A repo with no workspace gets one on send. The one-off thread is the other
 * draft, one pick of the target away.
 */
export function NewTaskDraft({ initialWay }: { initialWay?: TaskWay | undefined } = {}) {
  const api = useApi();
  const waySlab = useId();
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
  const ways = useTaskDraftStore((s) => s.ways);
  const pickedAutonomy = useTaskDraftStore((s) => s.autonomy);
  const rememberedWorkers = useTaskDraftStore((s) => s.workers);
  const sendKey = useServerSettings((s) => (s.settings ? sendKeyOf(s.settings) : undefined));

  const [picked, setPicked] = useState<TaskTarget | undefined>(pendingTaskTarget);
  useEffect(dropTaskTarget, []);
  const target = settledTaskTarget(
    picked ?? defaultTaskTarget({ current, workspaces, projects, last }),
    workspaces,
  );
  const [pickedWay, setWay] = useTaskWayPrefill(initialWay);
  const way =
    pickedWay ?? (target === undefined ? undefined : ways[taskTargetKey(target)]) ?? "plan";
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
              },
            }
          : {}),
        ...(makesOne && pickedAutonomy !== undefined ? { autonomy: pickedAutonomy } : {}),
      });
      useTaskDraftStore
        .getState()
        .remember(
          target,
          way,
          chosenWorker === undefined ? undefined : workerChoiceKey(chosenWorker),
        );
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
    void navigate({ to: "/new" });
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
        <h1 className="font-heading text-base font-medium">New task</h1>

        <TaskTargetPicker
          value={target}
          disabled={attachments.uploading}
          workspaces={workspaces}
          projects={projects}
          onPick={(next) => {
            if (next.kind === "oneOff") return toOneOff();
            if (next.kind === "newWorkspace") return toNewWorkspace();
            setPicked(next);
            setWay(initialWay);
            setRepoId(undefined);
          }}
        />

        {target === undefined && settled ? (
          <p className="text-sm text-muted-foreground">
            Gram doesn't know a repository to start a workspace in yet. Open one in a one-off thread
            first, or add one under Settings → Workspaces.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <div
              role="radiogroup"
              aria-label="Who picks it up"
              className="isolate flex w-fit gap-1 rounded-md border border-border p-0.5 text-xs"
            >
              {WAYS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={way === option.value}
                  onClick={() => setWay(option.value)}
                  className="relative rounded-sm px-2.5 py-1 text-muted-foreground transition-colors duration-(--dur-fast) outline-none focus-visible:ring-3 focus-visible:ring-ring/50 aria-checked:text-foreground"
                >
                  {way === option.value && <SegmentSlab group={waySlab} className="bg-accent" />}
                  {option.label}
                </button>
              ))}
            </div>
            {way === "direct" && repo !== undefined && (
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                in
                {repos.length > 1 ? (
                  <Select
                    value={repo.id}
                    items={repos.map((each) => ({ value: each.id, label: each.name }))}
                    onValueChange={(value) => {
                      if (value !== null) setRepoId(value as ProjectId);
                    }}
                  >
                    <SelectTrigger size="sm" aria-label="Repo">
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
                ) : (
                  <span className="flex h-7 items-center gap-1 rounded-md border border-border bg-card px-2 text-sm text-foreground">
                    <FolderGit2 aria-hidden className="size-3.5" />
                    {repo.name}
                  </span>
                )}
                on a new branch, with its own worktree
              </div>
            )}
            <p data-testid="task-way-note" className="text-xs text-muted-foreground">
              {way === "plan"
                ? `${makesOne ? `Makes a workspace for ${name}. Its` : `${name}'s`} orchestrator reads this, cuts it into features, briefs workers into their own worktrees and follows their pull requests to merged.`
                : `Starts one worker now, with your words as its brief, in a new worktree of ${repo?.name ?? name}. ${makesOne ? "The workspace made for it" : "The orchestrator"} hears about it in its next digest and follows it like its own.`}
            </p>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <span className={labelCls}>What needs doing</span>
          <div
            className="relative rounded-lg border border-input bg-card focus-within:border-ring"
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
                  className="px-3 py-2"
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
                rows={5}
                className="relative block w-full resize-y bg-transparent px-3 py-2 text-sm leading-relaxed outline-none"
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

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            {orchestratorModel === undefined
              ? "Checking the task's selected harness…"
              : `Orchestrator: ${agentLabel(orchestratorModel.agent)} · ${orchestratorModel.model}`}
          </p>
          {orchestratorModel !== undefined && (
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
            <p role="alert" className="text-xs text-status-needs">
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
          {makesOne && (
            <NewWorkspaceAutonomy
              value={pickedAutonomy ?? autonomyOf(DEFAULT_CHARTER)}
              onChange={(next) => useTaskDraftStore.getState().rememberAutonomy(next)}
            />
          )}
          <div className="flex flex-wrap items-center gap-3">
            <PressScale>
              <Button type="submit" disabled={!valid || sending}>
                {sending && <Spinner aria-hidden />}
                {submitLabel}
                <ShortcutKbd id="draft.create" className="opacity-70" />
              </Button>
            </PressScale>
            {target !== undefined && !makesOne && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <AutonomyChip autonomy={autonomyOf(workspace?.charter ?? DEFAULT_CHARTER)} />
                {budget !== undefined && (
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
          <p className="text-xs text-muted-foreground">
            A quick question, or something to try by hand? A{" "}
            <button
              type="button"
              className="text-foreground underline-offset-2 hover:underline"
              onClick={toOneOff}
            >
              one-off thread
            </button>{" "}
            <ShortcutKbd id="thread.newInProject" /> is one agent in one folder, with no
            orchestrator turn to pay for.
          </p>
        </div>
      </form>
    </div>
  );
}

/**
 * The autonomy of the workspace this draft makes, said in full beside the button that makes it, as
 * the new-workspace sheet does: the default may be the least supervised level, and sending is the only
 * other step on this path. Picking another is remembered for the next workspace a draft makes.
 */
function NewWorkspaceAutonomy({
  value,
  onChange,
}: {
  value: Autonomy;
  onChange: (autonomy: Autonomy) => void;
}) {
  const level = autonomyLevel(value);
  return (
    <div
      data-testid="task-autonomy"
      className={cn(
        "flex flex-wrap items-start gap-2 rounded-md border px-3 py-2 text-xs",
        level.warn
          ? "border-status-needs/50 text-foreground"
          : "border-border text-muted-foreground",
      )}
    >
      {createElement(AUTONOMY_ICON[value], {
        "aria-hidden": true,
        className: cn(
          "mt-0.5 size-4 shrink-0",
          level.warn ? "text-status-needs" : "text-muted-foreground",
        ),
      })}
      <span className="min-w-0 flex-[1_1_16rem]">
        <span className="font-medium">The new workspace runs at {level.label} autonomy.</span>{" "}
        {level.description}
      </span>
      <Select
        value={value}
        items={AUTONOMY_LEVELS.map((each) => ({ value: each.value, label: each.label }))}
        onValueChange={(next) => {
          if (next !== null) onChange(next as Autonomy);
        }}
      >
        <SelectTrigger size="sm" aria-label="Autonomy of the new workspace">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {AUTONOMY_LEVELS.map((each) => (
            <SelectItem key={each.value} value={each.value}>
              {each.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
