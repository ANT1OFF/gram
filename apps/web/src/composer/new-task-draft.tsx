import {
  DEFAULT_CHARTER,
  autonomyOf,
  sendKeyOf,
  type DraftId,
  type ModelRef,
  type ProjectId,
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
import {
  checkSend,
  machineLine,
  refusedForMachine,
  type SendTarget,
  SendWorkError,
  sendCheckRows,
  sendStartsMachine,
  sendTargetKey,
  sendTask,
  startSendMachine,
  useSendTargets,
} from "./send-target";
import { SendChecks, SendTargetPicker } from "./send-target-stop";
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
/** A wait between asking again, while a send starts the person's machine there. */
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const offered = settledTaskTarget(picked ?? named ?? starting?.target, workspaces);
  // A task goes to a workspace that exists: a repository without one is set up in New workspace,
  // which picking it under Where it runs opens. One asked for (handed over, or the thread's) is
  // named beside the picker instead; a default that is one gives way to a workspace.
  const askedRepo =
    offered?.kind === "repo" && (picked !== undefined || starting?.from === "thread")
      ? (projects.find((project) => project.id === offered.projectId) ?? null)
      : undefined;
  const target: Extract<TaskTarget, { kind: "workspace" }> | undefined =
    offered?.kind === "workspace"
      ? offered
      : askedRepo !== undefined || workspaces[0] === undefined
        ? undefined
        : { kind: "workspace", workspaceId: workspaces[0].workspace.id };
  // Kept from the last task rather than read off where the draft was opened: said beside Start.
  const remembered =
    picked === undefined && named === undefined && starting?.from === "last" && target === offered;
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
  const kind = useThreadsWorkspaceNoun();
  // Sent to a hosted workspace instead, once a server signed in to runs work sent to it: the
  // workspace's orchestrator's worker there, after the three checks (board 1 of
  // docs/design/mocks/hosted-send-and-move).
  const sendTargets = useSendTargets();
  const [sendPick, setSendPick] = useState<SendTarget>();
  const sendTo =
    sendPick === undefined
      ? undefined
      : sendTargets.find((each) => sendTargetKey(each) === sendTargetKey(sendPick));
  const mac = window.gram?.platform === "darwin";
  const here = mac ? "This Mac" : "This computer";
  const hereInLine = mac ? "this Mac" : "this computer";
  const sendProject = repos[0]?.id;
  const sendCheck = useQuery({
    queryKey: [
      "send-check",
      target?.workspaceId ?? null,
      sendProject ?? null,
      sendTo === undefined ? null : sendTargetKey(sendTo),
    ],
    queryFn: () =>
      checkSend({ workspaceId: target!.workspaceId, projectId: sendProject!, target: sendTo! }),
    enabled: sendTo !== undefined && target !== undefined && sendProject !== undefined,
    retry: false,
    staleTime: 15_000,
  });
  const sendRows =
    sendTo === undefined || sendCheck.data === undefined
      ? undefined
      : sendCheckRows(sendCheck.data, sendTo, hereInLine);
  const sendBlocked = sendRows === undefined || sendRows.some((row) => row.state === "block");
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
          target: { workspaceId: target.workspaceId },
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
  /** While a send starts the person's machine there first: what it is on now. */
  const [machineStep, setMachineStep] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
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

  const sendValid =
    sendTo !== undefined &&
    target !== undefined &&
    sendProject !== undefined &&
    prompt.trim() !== "" &&
    !attachments.uploading &&
    // A server is sent the brief alone: files attached here don't go.
    attachments.ready.length === 0 &&
    !sendCheck.isFetching &&
    !sendBlocked;
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
    if (sendTo !== undefined) {
      if (!sendValid || sending || target === undefined || sendProject === undefined) return;
      setSending(true);
      setError(undefined);
      // The person's own machine there, started first where the server offers it and it isn't
      // up: asked again until it runs, saying each step (`/threads/send-machine`).
      const machineRuns = async (): Promise<boolean> => {
        for (;;) {
          const progress = await startSendMachine(sendTo);
          if (progress.state === "unoffered") return false;
          if (progress.state === "failed") throw new SendWorkError(progress.why);
          if (progress.state === "ready") return true;
          if (!mounted.current) throw new SendWorkError("New task was closed.");
          setMachineStep(machineLine(progress, sendTo));
          await pause(2_000);
        }
      };
      const sendIt = () =>
        sendTask({
          workspaceId: target.workspaceId,
          projectId: sendProject,
          target: sendTo,
          text: prompt.trim(),
          clientRequestId: draftId,
        });
      try {
        const started = sendStartsMachine(sendCheck.data) && (await machineRuns());
        setMachineStep(started ? `Sending to ${sendTo.workspace}…` : undefined);
        let sent: Awaited<ReturnType<typeof sendIt>> | undefined;
        // A machine that just came up may not have joined there yet: the same send, a few times.
        for (let attempt = 0; sent === undefined; attempt += 1) {
          try {
            sent = await sendIt();
          } catch (e) {
            if (!started || attempt >= 5 || !refusedForMachine(e) || !mounted.current) throw e;
            setMachineStep(`Waiting for your machine on ${sendTo.host} to join…`);
            await pause(5_000);
          }
        }
        useTaskDraftStore.getState().remember(target);
        void navigate({ to: "/t/$threadId", params: { threadId: sent.threadId } });
      } catch (e) {
        if (!mounted.current) return;
        setSending(false);
        setMachineStep(undefined);
        setError(errorMessage(e) || "The task couldn't be sent.");
      }
      return;
    }
    if (!valid || sending || selection.data === undefined) return;
    setSending(true);
    setError(undefined);
    const {
      orchestratorNote: _note,
      orchestratorFrom: _from,
      orchestratorFresh: _fresh,
      ...shown
    } = selection.data;
    try {
      const thread = await api.startTask({
        target: { workspaceId: target.workspaceId },
        input: {
          text: prompt.trim(),
          ...(attachments.ready.length > 0 ? { attachments: attachments.ready } : {}),
        },
        selection: shown,
        ...(attachments.ready.length > 0 ? { draftId } : {}),
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

  // Making a workspace is New workspace's: what was typed goes along as its first task, with the
  // repository picked here, and comes back to the draft Esc returns to. The form has no place for
  // files, so while any are attached the hand-off waits, saying why.
  const handOffBlocked =
    attachments.uploading || attachments.ready.length > 0
      ? "New workspace can't take attachments: remove them to set one up from here"
      : undefined;
  const toNewWorkspace = (repo?: ProjectId) => {
    if (handOffBlocked !== undefined) return;
    carryDraft({ text: prompt, draftId, attachments: [] });
    void navigate({ to: "/new-workspace", search: repo === undefined ? {} : { repo } });
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

  const submitLabel =
    sendTo === undefined ? (newForm?.team?.start ?? "Send to team") : `Send to ${sendTo.workspace}`;
  // What Start waits on while a check runs, in its own words on the button: the task's selection,
  // then each agent's readiness, then the workspace's autonomy the summary beside it names.
  const checking: string | undefined =
    sendTo !== undefined
      ? sendCheck.isFetching && !sending
        ? `Checking with ${sendTo.server}…`
        : undefined
      : target === undefined || sending
        ? undefined
        : selection.isError
          ? undefined
          : selection.data === undefined || selection.isFetching
            ? "Checking agents…"
            : preflight.checking
              ? checkingAgent(orchestratorModel)
              : hasImages && imagePreflight.checking
                ? checkingAgent(inputModel)
                : workspace === undefined
                  ? "Checking the workspace…"
                  : undefined;
  const budget = ledger?.budget;
  // The level the line beside Start names, the workspace's own. Undefined while the workspace
  // hasn't loaded: the line waits rather than show the default.
  const autonomy = workspace === undefined ? undefined : autonomyOf(workspace.charter);
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
              <WhereStop label={kind}>
                <TaskTargetPicker
                  value={target}
                  open={whereOpen}
                  onOpenChange={setWhereOpen}
                  disabled={attachments.uploading}
                  workspaces={workspaces}
                  projects={projects}
                  handOffBlocked={handOffBlocked}
                  onPick={(next) => {
                    if (next.kind === "newWorkspace") return toNewWorkspace();
                    if (next.kind === "repo") return toNewWorkspace(next.projectId);
                    setPicked(next);
                  }}
                />
              </WhereStop>
              <RunsOnStop />
              {sendTargets.length > 0 && (
                <WhereStop label="Machine">
                  <SendTargetPicker
                    targets={sendTargets}
                    value={sendTo}
                    onChange={setSendPick}
                    here={here}
                    disabled={attachments.uploading || sending}
                  />
                </WhereStop>
              )}
            </>
          }
          line={
            target === undefined && settled
              ? askedRepo
                ? `${askedRepo.name} has no ${kind.toLowerCase()} yet. Pick it under Where it runs to set one up.`
                : `No ${kind.toLowerCase()} yet. Pick ${projects.length === 0 ? `New ${kind.toLowerCase()}` : "a repository"} under Where it runs to set one up.`
              : undefined
          }
        />

        {sendTo !== undefined && (
          <SendChecks
            target={sendTo}
            here={hereInLine}
            rows={
              sendRows === undefined || attachments.ready.length === 0
                ? sendRows
                : [
                    ...sendRows,
                    {
                      id: "attachments",
                      state: "block",
                      title: "Attached files don't go to a server",
                      detail: "Remove them, or keep the task on this computer.",
                    },
                  ]
            }
            model={sendCheck.data?.model}
            error={sendCheck.isError ? errorMessage(sendCheck.error) : undefined}
            checking={sendCheck.isFetching}
            onRecheck={() => void sendCheck.refetch()}
          />
        )}

        {machineStep !== undefined && (
          <p
            role="status"
            data-testid="send-machine"
            className="flex items-center gap-2 text-reading text-muted-foreground"
          >
            <Spinner aria-hidden className="size-3" /> {machineStep}
          </p>
        )}

        {error && (
          <p role="alert" className="text-reading text-destructive">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-3">
          {/* While the check runs, Start says so itself (`checking`); no line here. The model
              itself is the Orchestrator picker's, and a new workspace's line beside Start: a line
              of its own says only a move. */}
          {orchestratorModel !== undefined && selection.data?.orchestratorFrom !== undefined && (
            <p data-testid="task-orchestrator-line" className="text-meta text-muted-foreground">
              {selection.data.orchestratorFresh === true
                ? `The orchestrator starts fresh on ${agentLabel(orchestratorModel.agent)} · ${nameOf(orchestratorModel)} as this task starts. It saves to memory first; its conversation stays above a divider, and ${nameOf(selection.data.orchestratorFrom)}'s tool output and cache are left behind.`
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
                disabled={(sendTo === undefined ? !valid : !sendValid) || sending}
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
            {sendTo !== undefined && sendRows !== undefined && sendBlocked && (
              <Button
                type="button"
                variant="ghost"
                disabled={sendCheck.isFetching}
                onClick={() => void sendCheck.refetch()}
              >
                Check again
              </Button>
            )}
            {sendTo !== undefined && (
              <span data-testid="send-signed-in" className="text-meta text-muted-foreground">
                Signed in to {sendTo.server} · {sendTo.organisation}
              </span>
            )}
            {target !== undefined && sendTo === undefined && (
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
                    // While a pick saves, the line says the level it is saving.
                    autonomy={mergeApproval.autonomy}
                    remembered={remembered}
                    onChangeWhere={attachments.uploading ? undefined : changeWhere}
                    changeWhereHint={whereHint || undefined}
                    // The workspace's merge approval is picked here.
                    approval={{
                      label: mergeApproval.label,
                      onPick: mergeApproval.pick,
                      disabled: !mergeApproval.ready || mergeApproval.busy || sending,
                    }}
                  />
                )}
                {mergeApproval.below !== undefined && (
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
            {target !== undefined && (
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
