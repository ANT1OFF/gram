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
import { sleep } from "@/lib/sleep";

const labelCls = "text-meta font-medium text-muted-foreground";

const checkingAgent = (model: { agent: string } | undefined): string =>
  model === undefined ? "Checking agents…" : `Checking ${agentLabel(model.agent)}…`;

const TaskOrchestratorFields = lazy(() => import("./task-orchestrator-fields"));

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
  const remembered =
    picked === undefined && named === undefined && starting?.from === "last" && target === offered;
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

  const [expanded, setExpanded] = useState(false);
  const repeat =
    settled &&
    last !== undefined &&
    target !== undefined &&
    target.kind === "workspace" &&
    taskTargetKey(last) === taskTargetKey(target);
  const folded = repeat && !expanded;
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
    (shownOrchestrator === undefined || shownOrchestrator.model !== "") &&
    (!hasImages || !imagePreflight.blocked) &&
    (target.kind !== "workspace" || workspace !== undefined);

  const send = async () => {
    if (dictation.active) return dictation.stop();
    if (sendTo !== undefined) {
      if (!sendValid || sending || target === undefined || sendProject === undefined) return;
      setSending(true);
      setError(undefined);
      const machineRuns = async (): Promise<boolean> => {
        for (;;) {
          const progress = await startSendMachine(sendTo);
          if (progress.state === "unoffered") return false;
          if (progress.state === "failed") throw new SendWorkError(progress.why);
          if (progress.state === "ready") return true;
          if (!mounted.current) throw new SendWorkError("New task was closed.");
          setMachineStep(machineLine(progress, sendTo));
          await sleep(2_000);
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
        for (let attempt = 0; sent === undefined; attempt += 1) {
          try {
            sent = await sendIt();
          } catch (e) {
            if (!started || attempt >= 5 || !refusedForMachine(e) || !mounted.current) throw e;
            setMachineStep(`Waiting for your machine on ${sendTo.host} to join…`);
            await sleep(5_000);
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

  const pickWho = (who: Who) => {
    if (who === "me") toOneOff();
  };

  const submitLabel =
    sendTo === undefined ? (newForm?.team?.start ?? "Send to team") : `Send to ${sendTo.workspace}`;
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
          {orchestratorModel !== undefined && selection.data?.orchestratorFrom !== undefined && (
            <p data-testid="task-orchestrator-line" className="text-meta text-muted-foreground">
              {selection.data.orchestratorFresh === true
                ? `The orchestrator starts fresh on ${agentLabel(orchestratorModel.agent)} · ${nameOf(orchestratorModel)} as this task starts. It saves to memory first; its conversation stays above a divider, and ${nameOf(selection.data.orchestratorFrom)}'s tool output and cache are left behind.`
                : `The orchestrator moves from ${agentLabel(selection.data.orchestratorFrom.agent)} · ${nameOf(selection.data.orchestratorFrom)} to ${agentLabel(orchestratorModel.agent)} · ${nameOf(orchestratorModel)} as the task starts.`}
            </p>
          )}
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
              <span className="flex min-w-0 flex-1 basis-64 flex-wrap items-center gap-1.5 text-reading text-muted-foreground">
                {autonomy === undefined ? (
                  <span data-testid="task-authority-pending">
                    Reading this workspace's autonomy…
                  </span>
                ) : (
                  <TaskAuthorityLine
                    workspace={name}
                    autonomy={mergeApproval.autonomy}
                    remembered={remembered}
                    onChangeWhere={attachments.uploading ? undefined : changeWhere}
                    changeWhereHint={whereHint || undefined}
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
