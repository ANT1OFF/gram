import {
  DEFAULT_CHARTER,
  autonomyOf,
  sendKeyOf,
  type DraftId,
  type ModelRef,
  type StartTaskInput,
  type WorkspaceId,
} from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";

import { useApi } from "@/api/context";
import { HarnessPreflightNote, useHarnessPreflight } from "@/agents/feature-preflight";
import { HarnessSupportDetails } from "@/agents/support-details";
import { agentLabel } from "@/agents/agent-display";
import { errorMessage } from "@/api/errors";
import { RunsOnStop } from "./runs-on-chip";
import { needsMachine, StartMachineCard, useOnDemandMachine } from "./start-machine-card";
import { Button } from "@/components/ui/button";
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
  settledTaskTarget,
  startingTaskTarget,
  taskRepos,
  taskTargetKey,
  type TaskTarget,
} from "@/orchestration/task-model";
import { TaskTargetPicker } from "@/orchestration/task-target-picker";
import { useOrchestratorLedger, useWorkspacesQuery } from "@/orchestration/use-orchestration";
import { useServerSettings } from "@/settings-sync/store";
import { cn } from "@/lib/utils";
import { AuthorityExplainer } from "@/new-thread/authority-explainer";
import { TaskAuthorityLine } from "@/new-thread/authority-line";
import { AutonomyChoice } from "@/new-thread/autonomy-choice";
import { ControlDetails } from "@/new-thread/control-details";
import { useWorkspaceMergeApproval } from "@/new-thread/merge-approval";
import { useNewForm, useThreadsWorkspaceNoun } from "@/embed/store";
import { NewFormHeader, WhereStop, type Who } from "@/new-thread/who-does-it";
import { WorkspaceAutonomy } from "@/new-thread/workspace-autonomy";
import { readCameFrom, type CameFrom } from "@/shell/came-from";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import type { AgentChoice } from "./agent-fields";
import { AttachmentChips } from "./attachment-chips";
import { choiceFromModel } from "./default-choice";
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
import { useModelNames, useModelsSettled } from "./models";
import { SLAB, SLAB_TEXTAREA } from "./styles";

const labelCls = "text-meta font-medium text-muted-foreground";

/** What Start says while an agent's readiness is checked: the agent by name, once it is known. */
const checkingAgent = (model: { agent: string } | undefined): string =>
  model === undefined ? "Checking agents…" : `Checking ${agentLabel(model.agent)}…`;

/**
 * The New form for the orchestrator (⌘N's `/new-task`): what needs doing, and the workspace whose
 * orchestrator it goes to, which decides how to run it. A repo with no workspace gets one on send,
 * at the autonomy picked above the goal. A single agent chat, the one-off thread, is the other
 * draft behind the same header.
 */
const TaskOrchestratorFields = lazy(() => import("./task-orchestrator-fields"));

/** The `ModelRef` an orchestrator pick starts on, as `choiceModel` makes it. */
const orchestratorRef = (choice: AgentChoice): ModelRef => ({
  agent: choice.agent,
  model: choice.model,
  ...(choice.profileId === undefined ? {} : { profileId: choice.profileId }),
  ...(choice.variant === undefined ? {} : { variant: choice.variant }),
  ...(choice.speed === undefined ? {} : { speed: choice.speed }),
});

export function NewTaskDraft({
  initialWorkspace,
}: {
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
  // Where the draft was opened from: the thread or workspace page the window was on, else, opened
  // straight onto the form, the thread in the focused pane, which ⌘N leaves there.
  const [from] = useState((): CameFrom => {
    const place = readCameFrom();
    if (place !== undefined) return place;
    const { grid } = useLayoutStore.getState();
    const threadId = grid.panes[grid.focused] ?? undefined;
    return threadId === undefined ? { kind: "nowhere" } : { kind: "thread", threadId };
  });
  const currentId = from.kind === "thread" ? from.threadId : undefined;
  const current = useThreadsStore((s) =>
    currentId === undefined ? undefined : s.byId[currentId]?.thread,
  );
  const last = useTaskDraftStore((s) => s.last);
  const pickedAutonomy = useTaskDraftStore((s) => s.autonomy);
  const sendKey = useServerSettings((s) => (s.settings ? sendKeyOf(s.settings) : undefined));

  const newForm = useNewForm();
  // A pick in the "in" chip holds until a shortcut or the palette names another workspace.
  // Switching who does it keeps the workspace in the route, and so the pick.
  const [picked, setPicked] = useRoutePick<TaskTarget>(initialWorkspace ?? "", pendingTaskTarget);
  useEffect(dropTaskTarget, []);
  const named: TaskTarget | undefined =
    initialWorkspace !== undefined &&
    (!settled || workspaces.some((state) => state.workspace.id === initialWorkspace))
      ? { kind: "workspace", workspaceId: initialWorkspace }
      : undefined;
  const starting = startingTaskTarget({
    current,
    here: from.kind === "workspace" ? from.workspaceId : undefined,
    workspaces,
    projects,
    last,
  });
  const target = settledTaskTarget(picked ?? named ?? starting?.target, workspaces);
  // Kept from the last task rather than read off where the draft was opened: said beside Start.
  const remembered = picked === undefined && named === undefined && starting?.from === "last";
  // The window is on the workspace the task goes to while it is drafted, so the title bar and the
  // overview name the one the form does.
  const showing = target?.kind === "workspace" ? target.workspaceId : undefined;
  useEffect(() => {
    useTaskDraftStore.getState().show(showing);
    return () => useTaskDraftStore.getState().show(undefined);
  }, [showing]);
  const repos = target === undefined ? [] : taskRepos(target, workspaces, projects);
  const workspace =
    target?.kind === "workspace"
      ? workspaces.find((state) => state.workspace.id === target.workspaceId)
      : undefined;
  const makesOne = target?.kind === "repo";
  const kind = useThreadsWorkspaceNoun();
  const name = workspace?.workspace.name ?? repos[0]?.name ?? "";
  const { data: ledger } = useOrchestratorLedger(workspace?.workspace.id);
  const agents = useServerSettings((s) => s.settings?.agents);
  // The orchestrator picked on this draft, for the target it was picked for: a running one moves
  // to it as the task starts, a new one opens on it. Unpicked, the workspace's own.
  const [pickedOrchestrator, setPickedOrchestrator] = useState<{
    target: string;
    choice: AgentChoice;
  }>();
  const orchestratorPick =
    target !== undefined &&
    pickedOrchestrator !== undefined &&
    pickedOrchestrator.target === taskTargetKey(target) &&
    pickedOrchestrator.choice.model !== ""
      ? orchestratorRef(pickedOrchestrator.choice)
      : undefined;
  const taskOptions: Pick<StartTaskInput, "target" | "autonomy" | "orchestrator"> | undefined =
    target === undefined
      ? undefined
      : {
          target:
            target.kind === "workspace"
              ? { workspaceId: target.workspaceId }
              : { projectId: target.projectId },
          ...(makesOne && pickedAutonomy !== undefined ? { autonomy: pickedAutonomy } : {}),
          ...(orchestratorPick === undefined ? {} : { orchestrator: orchestratorPick }),
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
  // What the orchestrator chips show: the pick while its model is still being chosen, else what
  // the preview says it runs on.
  const shownOrchestrator: AgentChoice | undefined =
    pickedOrchestrator !== undefined &&
    target !== undefined &&
    pickedOrchestrator.target === taskTargetKey(target)
      ? pickedOrchestrator.choice
      : orchestratorModel === undefined
        ? undefined
        : choiceFromModel(orchestratorModel);
  const onDemand = useOnDemandMachine();
  const startMachine = needsMachine(onDemand.status);
  const machineOnline = onDemand.status?.machine?.online === true;
  // Once their machine is up, the check that failed for want of one is asked again.
  const recheck = selection.refetch;
  useEffect(() => {
    if (machineOnline) void recheck();
  }, [machineOnline, recheck]);
  const preflight = useHarnessPreflight(
    orchestratorModel,
    "orchestrator",
    selection.data?.orchestratorThreadId === undefined
      ? {}
      : { threadId: selection.data.orchestratorThreadId },
  );
  // Models by the names the composer gives them, not their ids.
  const nameOf = useModelNames([orchestratorModel, selection.data?.orchestratorFrom]);
  const inputModel = orchestratorModel;
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
  const mentionRoot = repos[0]?.root;
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
  const [controlsOpen, setControlsOpen] = useState(false);

  // A repeat start: the target is the one the last task went to and no new workspace is made, so
  // who does it and where it runs fold away, said by the line beside Start until its Change.
  const [expanded, setExpanded] = useState(false);
  const repeat =
    settled &&
    last !== undefined &&
    target !== undefined &&
    target.kind === "workspace" &&
    taskTargetKey(last) === taskTargetKey(target);
  const folded = repeat && !expanded;
  // Where it runs, changed from beside Start in one click or ⌘⇧L: a folded form unfolds, and the
  // workspace's menu opens.
  const [whereOpen, setWhereOpen] = useState(false);
  const changeWhere = () => {
    if (attachments.uploading) return;
    setExpanded(true);
    requestAnimationFrame(() => setWhereOpen(true));
  };
  useShortcut({
    id: "draft.where",
    keys: "mod+shift+l",
    label: "Change where a new task runs",
    group: "Composer",
    run: changeWhere,
  });
  const whereHint = useShortcutHint("draft.where");

  // Arriving here (⌘N, New task, the New menu) starts where typing does: the brief. Focus already
  // in a field (a carried draft's, say) stays.
  useEffect(() => {
    if (!focusLost() && document.activeElement?.closest("input, textarea, [contenteditable]"))
      return;
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
    // An agent picked for the orchestrator whose models aren't listed yet has nothing to start on.
    (shownOrchestrator === undefined || shownOrchestrator.model !== "") &&
    (!hasImages || !imagePreflight.blocked) &&
    // The line beside Start names the workspace's autonomy: never start on a level not yet read.
    (target.kind !== "workspace" || workspace !== undefined);

  const send = async () => {
    // A final still on its way would land after the draft is gone: stop, keeping what was heard,
    // and leave sending to the user once it is in.
    if (dictation.active) return dictation.stop();
    if (!valid || sending || selection.data === undefined) return;
    setSending(true);
    setError(undefined);
    const { orchestratorNote: _note, orchestratorFrom: _from, ...shown } = selection.data;
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
        selection: shown,
        ...(attachments.ready.length > 0 ? { draftId } : {}),
        ...(makesOne && pickedAutonomy !== undefined ? { autonomy: pickedAutonomy } : {}),
        ...(orchestratorPick === undefined ? {} : { orchestrator: orchestratorPick }),
      });
      useTaskDraftStore.getState().remember(target);
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

  // The orchestrator is this draft; Chat is the other, which what was typed goes along to.
  const pickWho = (who: Who) => {
    if (who === "me") toOneOff();
  };

  const submitLabel = makesOne
    ? "Start workspace and send"
    : (newForm?.team?.start ?? "Send to team");
  // What Start waits on while a check runs, in its own words on the button: the task's selection,
  // then each agent's readiness, then the workspace's autonomy the summary beside it names.
  const checking: string | undefined =
    target === undefined || sending
      ? undefined
      : selection.isError
        ? undefined
        : selection.data === undefined || selection.isFetching
          ? "Checking agents…"
          : preflight.checking
            ? checkingAgent(orchestratorModel)
            : hasImages && imagePreflight.checking
              ? checkingAgent(inputModel)
              : target.kind === "workspace" && workspace === undefined
                ? "Checking the workspace…"
                : undefined;
  const budget = ledger?.budget;
  // The level the line beside Start names: the new workspace's pick, else the workspace's own.
  // Undefined while a named workspace hasn't loaded: the line waits rather than show the default.
  const autonomy = makesOne
    ? (pickedAutonomy ?? autonomyOf(DEFAULT_CHARTER))
    : workspace === undefined
      ? undefined
      : autonomyOf(workspace.charter);
  const mergeApproval = useWorkspaceMergeApproval(
    workspace,
    autonomy ?? autonomyOf(DEFAULT_CHARTER),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <form
        ref={formRef}
        className="flex w-full thread-column flex-col gap-5 p-6"
        aria-label="New task"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <NewFormHeader
          who="orchestrator"
          onWho={pickWho}
          disabled={attachments.uploading}
          goal={
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
                {dictation.partial !== "" &&
                  (!caretAtEnd || (partialInline && partialOverflows)) && (
                    <DictationStrip partial={dictation.partial} />
                  )}
                <DictationError state={dictation.state} />
                {(dictation.available || shownOrchestrator !== undefined) && (
                  <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
                    {shownOrchestrator !== undefined && (
                      <div
                        role="group"
                        aria-label="Orchestrator"
                        data-testid="task-orchestrator-fields"
                        className="contents"
                      >
                        <span aria-hidden className="pl-1.5 text-meta text-muted-foreground">
                          Orchestrator
                        </span>
                        <Suspense fallback={null}>
                          <TaskOrchestratorFields
                            value={shownOrchestrator}
                            onChange={(choice) => {
                              if (target !== undefined)
                                setPickedOrchestrator({ target: taskTargetKey(target), choice });
                            }}
                          />
                        </Suspense>
                      </div>
                    )}
                    <span
                      aria-live="polite"
                      data-testid="draft-dictation-status"
                      className="min-w-0 flex-1 truncate px-1 text-meta text-muted-foreground"
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
          }
          folded={folded}
          where={
            <>
              <WhereStop label={makesOne ? `New ${kind.toLowerCase()} for` : kind}>
                <TaskTargetPicker
                  value={target}
                  open={whereOpen}
                  onOpenChange={setWhereOpen}
                  disabled={attachments.uploading}
                  workspaces={workspaces}
                  projects={projects}
                  onPick={(next) => {
                    if (next.kind === "newWorkspace") return toNewWorkspace();
                    setPicked(next);
                  }}
                />
              </WhereStop>
              <RunsOnStop />
            </>
          }
          line={
            target === undefined && settled
              ? "Gram doesn't know a repository to start a workspace in yet. Pick Chat to open one, or add one under Settings → Workspaces & merging."
              : undefined
          }
        />

        {makesOne && (
          <AutonomyChoice
            label="Autonomy of the new workspace"
            value={pickedAutonomy ?? autonomyOf(DEFAULT_CHARTER)}
            onChange={(next) => useTaskDraftStore.getState().rememberAutonomy(next)}
          />
        )}

        {error && (
          <p role="alert" className="text-reading text-destructive">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-3">
          {/* While the check runs, Start says so itself (`checking`); no line here. */}
          {orchestratorModel !== undefined && (
            <p data-testid="task-orchestrator-line" className="text-meta text-muted-foreground">
              {selection.data?.orchestratorFrom === undefined
                ? `Orchestrator: ${agentLabel(orchestratorModel.agent)} · ${nameOf(orchestratorModel)}`
                : `The orchestrator moves from ${agentLabel(selection.data.orchestratorFrom.agent)} · ${nameOf(selection.data.orchestratorFrom)} to ${agentLabel(orchestratorModel.agent)} · ${nameOf(orchestratorModel)} as the task starts.`}
            </p>
          )}
          {/* Its slot follows a tier nothing here fills: why, beside what stands in. */}
          {selection.data?.orchestratorNote !== undefined && (
            <p
              role="status"
              data-testid="task-orchestrator-note"
              className="flex items-start gap-1.5 text-meta text-warning"
            >
              <TriangleAlert aria-hidden className="mt-px size-icon-row shrink-0" />
              <span>{selection.data.orchestratorNote}</span>
            </p>
          )}
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
          {/* Where the deployment starts machines on demand, the person's own, in place of the error. */}
          {startMachine && <StartMachineCard />}
          {selection.isError && !startMachine && (
            <p role="alert" className="text-meta text-destructive">
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
          {hasImages && (
            <HarnessPreflightNote
              result={imagePreflight.result}
              checking={imagePreflight.checking}
              model={inputModel}
              onRetry={imagePreflight.recheck}
            />
          )}
          <div className="flex flex-wrap items-center gap-3">
            <PressScale>
              <Button
                type="submit"
                disabled={!valid || sending}
                data-testid="task-submit"
                data-checking={checking === undefined ? undefined : ""}
                // Its action stays its name while the check runs; the words say why it waits.
                aria-label={checking === undefined ? undefined : `${submitLabel}, ${checking}`}
                title={
                  checking === undefined && !sending && prompt.trim() === ""
                    ? "Say what needs doing first"
                    : undefined
                }
              >
                {(sending || checking !== undefined) && <Spinner aria-hidden />}
                {checking === undefined ? submitLabel : <span>{checking}</span>}
                {checking === undefined && <ShortcutKbd id="draft.create" cap />}
              </Button>
            </PressScale>
            {target !== undefined && (
              // Beside Start, wrapping in its own column rather than under the button: who acts
              // and what still needs you, whatever is folded below. At the Task/Team/Chat
              // choice's own size, since it says what that choice commits to.
              <span className="flex min-w-0 flex-1 basis-64 flex-wrap items-center gap-1.5 text-reading text-muted-foreground">
                {autonomy === undefined ? (
                  <span data-testid="task-authority-pending">
                    Reading this workspace's autonomy…
                  </span>
                ) : (
                  <TaskAuthorityLine
                    workspace={name}
                    makesOne={makesOne}
                    // While a pick saves, the line says the level it is saving.
                    autonomy={makesOne ? autonomy : mergeApproval.autonomy}
                    remembered={remembered}
                    onChangeWhere={attachments.uploading ? undefined : changeWhere}
                    changeWhereHint={whereHint || undefined}
                    // A new workspace's level is the Autonomy choice above; an existing one's
                    // merge approval is picked here.
                    approval={
                      makesOne
                        ? undefined
                        : {
                            label: mergeApproval.label,
                            onPick: mergeApproval.pick,
                            disabled: !mergeApproval.ready || mergeApproval.busy || sending,
                          }
                    }
                  />
                )}
                {!makesOne && mergeApproval.below !== undefined && (
                  <span className="basis-full pl-5.5">{mergeApproval.below}</span>
                )}
                {budget !== undefined && (
                  <span
                    data-testid="task-workers"
                    className="rounded-sm border border-border px-1 text-meta tabular-nums"
                  >
                    {budget.liveWorkers} of {budget.maxConcurrentWorkers} workers
                  </span>
                )}
              </span>
            )}
          </div>
          <ControlDetails open={controlsOpen} onOpenChange={setControlsOpen}>
            {target !== undefined && !makesOne && (
              <div className="flex flex-col gap-1">
                <span className={labelCls}>Workspace autonomy</span>
                <WorkspaceAutonomy
                  state={workspace}
                  autonomy={autonomy ?? autonomyOf(DEFAULT_CHARTER)}
                />
              </div>
            )}
            <AuthorityExplainer />
            <HarnessSupportDetails
              observation={preflight.observation}
              imageInput={imagePreflight.result.support}
              threadId={selection.data?.orchestratorThreadId}
            />
          </ControlDetails>
        </div>
      </form>
    </div>
  );
}
