import { useSoloWord } from "@/embed/store";
import {
  DEFAULT_SETTINGS,
  HostId,
  isFolderProject,
  sendKeyOf,
  type CheckoutRequest,
  type DraftId,
  type PermissionMode,
  type Project,
  type WorkspaceState,
  defaultSlotOf,
} from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRight, History, RotateCw, TriangleAlert } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { useApi } from "@/api/context";
import { HarnessPreflightNote, useHarnessPreflight } from "@/agents/feature-preflight";
import { checkoutInUsePath } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { shortcutPressed } from "@/keyboard/bindings";
import { useShortcut } from "@/keyboard/registry";
import { ShortcutKbd, useShortcutHint } from "@/keyboard/use-shortcut-hint";
import { focusIfConnected, focusLost } from "@/lib/use-return-focus";
import { cn } from "@/lib/utils";
import { PressScale, Spinner } from "@/motion";
import { CheckoutInUseNotice, useCheckoutUsers } from "@/new-thread/checkout-in-use";
import { ExistingWorktrees } from "@/new-thread/existing-worktrees";
import { folderProblem } from "@/new-thread/fs-errors";
import {
  MachineNote,
  MachinePicker,
  machineBlocker,
  useJoinedMachines,
} from "@/new-thread/machine-picker";
import {
  MachineFolderChip,
  MachineFolderField,
  machineFolderLine,
} from "@/new-thread/machine-folder";
import { ProjectPicker } from "@/new-thread/project-picker";
import { useFolderStatus, useIsGitRepo, useMachineFolderStatus } from "@/new-thread/use-folder";
import { FolderPicker } from "@/new-thread/where-chips";
import { ChatAuthorityLine } from "@/new-thread/authority-line";
import { NewFormHeader, WHO_ENTRY, WhereStop, type Who } from "@/new-thread/who-does-it";
import { useTaskDraftStore } from "@/orchestration/task-draft-store";
import type { TaskTarget } from "@/orchestration/task-model";
import { useWorkspaces } from "@/orchestration/use-orchestration";
import { ContinueLatest, ResumeSessions } from "@/resume/resume-sessions";
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
import { useServerSettings } from "@/settings-sync/store";

import { inOpenFence } from "./mention";
import { enterSends } from "./send-key";
import { AgentFields, choiceModel, gatewayReady, type AgentChoice } from "./agent-fields";
import { agentLabel } from "@/agents/agent-display";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { modeSection } from "./choice-sections";
import { ComposerChoices } from "./choices";
import { useModels } from "./models";
import { AttachmentChips } from "./attachment-chips";
import { randomBranchName } from "./branch-name";
import { useDraftAgentChoice } from "./use-default-choice";
import {
  carriedDraft,
  carryDraft,
  dropCarriedDraft,
  prefillDraftProject,
  prefillTaskTarget,
  useDraftProjectRoot,
} from "./draft-prefill";
import { MentionMenu } from "./mention-menu";
import { useSlabHandoff } from "./slab-handoff";
import { needsMachine, StartMachineCard, useOnDemandMachine } from "./start-machine-card";
import { SLAB, SLAB_TEXTAREA } from "./styles";
import { useAttachments } from "./use-attachments";
import { useMentions } from "./use-mentions";
import {
  CurrentCheckoutFreshness,
  initialWorktreeChoice,
  worktreeCheckout,
  WorktreeFields,
} from "./worktree-fields";

type CheckoutKind = CheckoutRequest["kind"];

/** How long a pick's words stay beside the chip, as long as a thread composer's note. */
const PICKED_MS = 2500;

/**
 * Where the task draft goes from this folder: its own one-repo workspace, else one it is part of,
 * else the repo, to make a workspace for. Nothing for a folder Gram doesn't know yet.
 */
export function folderTarget(
  project: Project | undefined,
  workspaces: readonly WorkspaceState[],
): TaskTarget | undefined {
  if (project === undefined) return undefined;
  const having = workspaces.filter((state) => state.workspace.projectIds.includes(project.id));
  const mine =
    having.find((state) => state.workspace.projectIds.length === 1) ??
    having.find((state) => state.workspace.homeProjectId === project.id) ??
    having[0];
  return mine === undefined
    ? { kind: "repo", projectId: project.id }
    : { kind: "workspace", workspaceId: mine.workspace.id };
}

const CHECKOUTS: { value: CheckoutKind; label: string }[] = [
  { value: "current", label: "Current checkout" },
  { value: "newWorktree", label: "New worktree" },
  { value: "existingWorktree", label: "Existing worktree" },
];

const SETUP_STAGES: Record<CheckoutKind, string[]> = {
  current: ["Start agent"],
  machineFolder: ["Check folder", "Start agent"],
  newWorktree: ["Fetch", "Create worktree", "Copy includes", "Seed permissions", "Start agent"],
  existingWorktree: ["Start agent"],
};

const labelCls = "text-meta font-medium text-muted-foreground";

/**
 * The inline `/new` draft: where the thread runs, on what, and the first prompt. While workspaces
 * are on it is the one-off thread (⌘T), one pick of the target away from New task.
 */
/**
 * The composer row's warning when the saved default follows a tier nothing here fills: a glyph,
 * its words on hover, naming why and what this chat uses instead.
 */
function DefaultUnavailable({ why, choice }: { why: string; choice: AgentChoice }) {
  const words = `Your default model can't run here: ${why}. This chat uses ${agentLabel(choice.agent)} ${choice.model}.`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            tabIndex={0}
            aria-label={words}
            data-testid="draft-default-unavailable"
            className="flex size-8 items-center justify-center rounded-md text-warning outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        <TriangleAlert aria-hidden className="size-icon-row" />
      </TooltipTrigger>
      <TooltipContent role="tooltip" className="max-w-sm">
        {words}
      </TooltipContent>
    </Tooltip>
  );
}

export function NewThreadDraft() {
  const ready = useServerSettings((s) => s.settings !== undefined);
  return ready ? <ConfiguredNewThreadDraft /> : <p role="status">Loading agent preferences…</p>;
}

function ConfiguredNewThreadDraft() {
  const startMachine = needsMachine(useOnDemandMachine().status);
  const api = useApi();
  const navigate = useNavigate();
  const workspaces = useWorkspaces();
  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
  // This Mac's folders: a joined machine's one-off threads have a project of their own that is
  // no folder here (`machineProjectRoot`), and its folders are its Folder chip's.
  const recents = projects
    .filter(isFolderProject)
    .toSorted(
      (a, b) =>
        Number(b.bookmarked) - Number(a.bookmarked) ||
        (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0),
    );

  const [typedRoot, setTypedRoot] = useDraftProjectRoot();
  const defaultFolder = useServerSettings((s) => s.settings?.agents.defaultFolder);
  // Unknown until settings load; see `Composer`.
  const sendKey = useServerSettings((s) => (s.settings ? sendKeyOf(s.settings) : undefined));
  const formRef = useRef<HTMLFormElement>(null);
  // A folder to start in: one typed or carried here, the default, or the one used last, which
  // the Folder chip shows already. Then typing starts in the prompt.
  const startsWithProject = useRef(
    typedRoot !== undefined || defaultFolder !== undefined || recents.length > 0,
  );

  // Arriving here (⌘T, New thread) leaves focus on the page it came from: go where typing starts.
  useEffect(() => {
    if (!focusLost()) return;
    focusIfConnected(
      formRef.current?.querySelector(
        // Without a folder to start in, the Folder chip: focusing the path field, which sits below
        // the prompt, would scroll the prompt and chips out of view.
        startsWithProject.current
          ? 'textarea[aria-label="First prompt"]'
          : '[data-testid="where-folder"]',
      ),
    );
  }, []);
  const pathValue = typedRoot ?? defaultFolder ?? recents[0]?.root ?? "";
  const folderStatus = useFolderStatus(pathValue);
  const folder = folderStatus.state === "valid" ? folderStatus.folder : undefined;
  const projectRoot = folder?.path ?? "";
  const project = projects.find((p) => p.root === projectRoot);
  const isGitRepo = useIsGitRepo(folder);
  const repoPath = project?.repoRoot ?? (isGitRepo ? projectRoot : "");
  // Without git there are no worktrees, so the thread runs in the folder itself.
  const notRepo = folder !== undefined && project?.repoRoot === undefined && isGitRepo === false;

  const [pickedCheckout, setCheckout] = useState<CheckoutKind>("newWorktree");
  const [worktree, setWorktree] = useState(initialWorktreeChoice);
  // A joined machine runs the thread in a folder there, its home unless another is picked, or in
  // a new worktree of its own clone of a repository of this Mac picked from its Folder menu.
  const joined = useJoinedMachines();
  const pickedMachine = joined?.find((m) => m.id === worktree.machine);
  /** The folder on the picked machine; `undefined` while a repository of this Mac is picked. */
  const [machinePath, setMachinePath] = useState<string>();
  const onMachine = pickedMachine !== undefined && machinePath !== undefined;
  const machineStatus = useMachineFolderStatus(
    onMachine ? HostId.make(pickedMachine.id) : undefined,
    machinePath ?? "",
  );
  const checkedOnMachine = machineStatus.state === "valid" ? machineStatus.folder : undefined;
  /** The machine a new worktree is made on, from a repository of this Mac. */
  const worktreeMachine = onMachine ? undefined : pickedMachine;
  const machine = onMachine ? pickedMachine : notRepo ? undefined : worktreeMachine;
  const checkout: CheckoutKind = onMachine
    ? "machineFolder"
    : notRepo
      ? "current"
      : machine !== undefined
        ? "newWorktree"
        : pickedCheckout;
  const pickMachine = (next: string | undefined) => {
    setWorktree((current) => ({ ...current, machine: next }));
    setMachinePath(next === undefined ? undefined : "~");
  };
  const [existingPath, setExistingPath] = useState("");
  // Capture Settings → Agents once, after settings load; later edits don't replace this draft.
  // A default that follows a tier is resolved by the draft once both harnesses have listed.
  // With the recommended setup on and nothing saved, Lead at low (`defaultSlotOf`).
  const savedDefaultModel = useServerSettings((s) =>
    s.settings === undefined ? undefined : defaultSlotOf(s.settings),
  );
  const { choice, setChoice, discovering, unavailable } = useDraftAgentChoice(savedDefaultModel);
  const [mode, setMode] = useState<PermissionMode>(
    () =>
      useServerSettings.getState().settings?.agents.defaultMode ??
      DEFAULT_SETTINGS.agents.defaultMode,
  );
  const [carried] = useState(carriedDraft);
  useEffect(dropCarriedDraft, []);
  const [prompt, setPrompt] = useState(carried?.text ?? "");
  // Files attached before the thread exists are staged under this id; `createThread` adopts them.
  const [draftId] = useState(() => carried?.draftId ?? (crypto.randomUUID() as DraftId));
  const attachments = useAttachments({ draftId }, carried?.attachments);
  // A chosen existing worktree is where the agent will run; a new one starts from the project.
  // A folder on another machine offers no mentions: its files are listed there, for its threads.
  const mentionFolder = onMachine
    ? ""
    : (checkout === "existingWorktree" ? existingPath.trim() : "") || projectRoot;
  const mentions = useMentions({
    id: "mention-menu-new-thread",
    text: prompt,
    setText: setPrompt,
    source:
      mentionFolder === ""
        ? undefined
        : { key: ["path", mentionFolder], load: () => api.fsFiles({ path: mentionFolder }) },
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
  const [stage, setStage] = useState<"draft" | "creating" | "failed">("draft");
  const [error, setError] = useState<string | undefined>();
  const [resuming, setResuming] = useState(false);
  const [dragging, setDragging] = useState(false);
  const slabRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [error]);

  const checkoutRequest = (): CheckoutRequest => {
    switch (checkout) {
      case "current":
        return { kind: "current" };
      case "existingWorktree":
        return { kind: "existingWorktree", path: existingPath.trim() };
      case "newWorktree":
        return worktreeCheckout({ ...worktree, machine: machine?.id });
      case "machineFolder":
        return {
          kind: "machineFolder",
          hostId: HostId.make(pickedMachine?.id ?? ""),
          path: checkedOnMachine?.path ?? machinePath?.trim() ?? "",
        };
    }
  };

  const { data: profiles = [] } = useQuery({
    queryKey: ["profiles"],
    queryFn: () => api.listProfiles(),
  });
  const ready = choice.model !== "" && gatewayReady(choice, profiles);
  const selectedModel = choiceModel(choice);
  const preflight = useHarnessPreflight(selectedModel, "session");
  const models = useModels(choice.agent, choice.profileId);
  const imagePreflight = useHarnessPreflight(
    selectedModel,
    "imageInput",
    models === undefined ? {} : { models },
  );
  const hasImages = attachments.ready.some((attachment) =>
    attachment.mediaType?.startsWith("image/"),
  );

  // Who already uses the chosen checkout: the folder itself, an existing worktree, or the worktree a
  // refusal named once the server turned a create down (the checkout was taken after the warning).
  const requestKey = `${projectRoot}\n${JSON.stringify(checkoutRequest())}`;
  const [refusal, setRefusal] = useState<{ key: string; path: string }>();
  const refusedPath = refusal?.key === requestKey ? refusal.path : undefined;
  const checkedPath =
    checkout === "current"
      ? projectRoot
      : checkout === "existingWorktree"
        ? existingPath.trim()
        : "";
  const users = useCheckoutUsers(refusedPath ?? (checkedPath || undefined));
  const refused =
    users.length > 0 && (refusedPath !== undefined || checkout === "existingWorktree");
  const [acknowledged, setAcknowledged] = useState<string>();
  const unacknowledged = users.length > 0 && !refused && acknowledged !== requestKey;

  const valid =
    (onMachine ? checkedOnMachine !== undefined : projectRoot !== "") &&
    // A new worktree on a machine is made from a repository here.
    (worktreeMachine === undefined || !notRepo) &&
    ready &&
    !preflight.blocked &&
    (!hasImages || !imagePreflight.blocked) &&
    (checkout !== "newWorktree" || worktree.name.trim() !== "") &&
    (machine === undefined || machineBlocker(machine) === undefined) &&
    (checkout !== "existingWorktree" || existingPath.trim() !== "") &&
    !refused &&
    !attachments.uploading;

  const create = async (anyway = false) => {
    // A final still on its way would land after the draft is gone: stop, keeping what was heard,
    // and leave sending to the user once it is in.
    if (dictation.active) return dictation.stop();
    if (!valid || stage === "creating") return;
    if (unacknowledged && !anyway) {
      noticeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      return;
    }
    setStage("creating");
    setError(undefined);
    try {
      const thread = await api.createThread({
        // A folder on another machine: the server files it under that machine, never this disk.
        projectRoot: onMachine ? (checkedOnMachine?.path ?? "") : projectRoot,
        checkout: checkoutRequest(),
        model: choiceModel(choice),
        mode,
        ...(prompt.trim() || attachments.ready.length > 0
          ? {
              input: {
                text: prompt.trim(),
                ...(attachments.ready.length > 0 ? { attachments: attachments.ready } : {}),
              },
            }
          : {}),
        ...(attachments.ready.length > 0 ? { draftId } : {}),
      });
      prefillDraftProject(undefined);
      // The prompt box moves down into the new thread's composer.
      const box = slabRef.current?.getBoundingClientRect();
      if (box) useSlabHandoff.getState().hand(thread.id, { x: box.left, y: box.top });
      void navigate({ to: "/t/$threadId", params: { threadId: thread.id } });
    } catch (e) {
      const inUse = checkoutInUsePath(e);
      if (inUse !== undefined) {
        setStage("draft");
        setRefusal({ key: requestKey, path: inUse });
        return;
      }
      setStage("failed");
      setError(folderProblem(e).message || "Couldn't create the thread.");
    }
  };

  // The orchestrator and a worker are the task draft; what was typed goes along, and so does the
  // folder, as its workspace or as a repo to make one for.
  const pickWho = (who: Who) => {
    if (who === "me" || attachments.uploading) return;
    carryDraft({ text: prompt, draftId, attachments: attachments.ready });
    prefillTaskTarget(onMachine ? undefined : folderTarget(project, workspaces));
    useTaskDraftStore.getState().rememberEntry(WHO_ENTRY[who]);
    void navigate({ to: "/new-task", search: who === "worker" ? { way: "direct" } : {} });
  };

  // The folder's path field and the ways to resume are the form's rarely used half: the Folder
  // chip above picks the folder. They stay folded until asked for, or until the folder needs
  // fixing (none picked, or one that can't be used), which only the path field can do.
  const [optionsAsked, setOptionsAsked] = useState(false);
  const optionsId = useId();
  const folderNeedsFixing = onMachine
    ? machineStatus.state === "invalid" || machineStatus.state === "empty"
    : folderStatus.state === "invalid" || folderStatus.state === "empty";
  const optionsOpen = optionsAsked || folderNeedsFixing;
  /** Opens the folded options, then puts focus in `selector` once it is drawn. */
  const focusOption = (selector: string) => {
    setOptionsAsked(true);
    setTimeout(() => focusIfConnected(formRef.current?.querySelector(selector)));
  };
  const browse = () => focusOption('[aria-label="Project path"]');
  const browseMachine = () => focusOption(`[aria-label="Folder on ${pickedMachine?.name ?? ""}"]`);

  const soloWord = useSoloWord();
  useShortcut({
    id: "draft.create",
    keys: "mod+enter",
    label: "Start chat",
    group: "Composer",
    run: () => void create(),
  });

  // An embedding app with its own word for this kind of thread has a Chat of its own: the button
  // then says only what it does.
  const createLabel =
    stage === "failed" ? "Retry" : soloWord === undefined ? "Start chat" : "Start";
  const modeChoice = modeSection({ value: mode, onChange: setMode });
  // A pick is confirmed in words beside the chip for a moment, as in a thread's composer.
  const [picked, setPicked] = useState<string>();
  const pickedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(pickedTimer.current), []);
  const onPicked = (words: string) => {
    clearTimeout(pickedTimer.current);
    setPicked(words);
    pickedTimer.current = setTimeout(() => setPicked(undefined), PICKED_MS);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <form
        ref={formRef}
        className="flex w-full thread-column flex-col gap-8 p-6 pb-10"
        aria-label="New thread"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        {/* The New form's header, and a prompt box shaped like the composer it becomes. */}
        <section className="flex flex-col gap-4">
          <NewFormHeader
            who="me"
            onWho={pickWho}
            disabled={attachments.uploading}
            where={
              <>
                {/* The machine first, once one is joined: the Folder chip lists its folders. */}
                {(joined?.length ?? 0) > 0 && (
                  <WhereStop label="Machine">
                    <MachinePicker
                      machines={joined}
                      value={worktree.machine}
                      onChange={pickMachine}
                    />
                  </WhereStop>
                )}
                <WhereStop label="Folder">
                  {pickedMachine === undefined ? (
                    <FolderPicker
                      folder={projectRoot}
                      projects={recents}
                      onPickFolder={setTypedRoot}
                      onBrowse={browse}
                    />
                  ) : (
                    <MachineFolderChip
                      machine={pickedMachine}
                      folder={machinePath}
                      repo={projectRoot}
                      repos={recents.filter((p) => p.repoRoot !== undefined)}
                      onPickFolder={setMachinePath}
                      onPickRepo={(root) => {
                        setTypedRoot(root);
                        setMachinePath(undefined);
                        setCheckout("newWorktree");
                      }}
                      onBrowse={() => {
                        if (machinePath === undefined) setMachinePath("~");
                        setTimeout(browseMachine);
                      }}
                    />
                  )}
                </WhereStop>
              </>
            }
            line={
              onMachine ? (
                <MachineNote
                  machine={pickedMachine}
                  ready={machineFolderLine(pickedMachine, machineStatus)}
                />
              ) : worktreeMachine !== undefined && notRepo ? (
                `A new worktree on ${worktreeMachine.name} is made from a git repository. Pick one, or a folder on ${worktreeMachine.name}.`
              ) : machine === undefined ? undefined : (
                <MachineNote machine={machine} />
              )
            }
            goal={
              <div className="flex flex-col gap-2">
                <span className={labelCls}>What needs doing</span>
                <div
                  ref={slabRef}
                  data-surface="composer"
                  data-dragging={dragging ? "true" : undefined}
                  className={SLAB}
                  onKeyDownCapture={dictation.onKeyDownCapture}
                  onDragOver={(event) => event.preventDefault()}
                  onDragEnter={(event) => {
                    if (event.dataTransfer.types.includes("Files")) setDragging(true);
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      setDragging(false);
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragging(false);
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
                    className="px-3 pt-3"
                  />
                  <div className="relative">
                    {partialInline && (
                      <DictationMirror ref={mirrorRef} text={prompt} partial={dictation.partial} />
                    )}
                    <textarea
                      {...mentions.textareaProps}
                      aria-label="First prompt"
                      role="combobox"
                      aria-expanded={mentions.open}
                      aria-controls={mentions.open ? mentions.id : undefined}
                      aria-activedescendant={
                        mentions.open ? `${mentions.id}-${mentions.activeIndex}` : undefined
                      }
                      aria-autocomplete="list"
                      className={cn(SLAB_TEXTAREA, "relative")}
                      // Cleared from the start of dictation, so the first words don't land on it.
                      placeholder={
                        dictation.active
                          ? ""
                          : "Describe the task. Type @ to mention a file, or paste or drop files to attach them. Or leave it empty to start the agent now and write to it in the thread."
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
                        // The same key that sends a message in a thread starts this one.
                        const { value, selectionStart } = event.currentTarget;
                        if (
                          (!inOpenFence(value.slice(0, selectionStart)) &&
                            enterSends(event.nativeEvent, sendKey)) ||
                          shortcutPressed("draft.create", event.nativeEvent)
                        ) {
                          event.preventDefault();
                          void create();
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
                  <fieldset
                    data-testid="new-thread-toolbar"
                    className="flex flex-wrap items-center gap-1 px-2 pb-2"
                  >
                    <legend className="sr-only">Agent</legend>
                    {discovering ? (
                      <>
                        <span role="status" className="px-2 text-meta text-muted-foreground">
                          Discovering local agents…
                        </span>
                        <ComposerChoices sections={[modeChoice]} onPicked={onPicked} />
                      </>
                    ) : (
                      <AgentFields
                        ghost
                        value={choice}
                        onChange={setChoice}
                        mode={modeChoice}
                        onPicked={onPicked}
                      />
                    )}
                    {!discovering && unavailable !== undefined && (
                      <DefaultUnavailable why={unavailable} choice={choice} />
                    )}
                    <span
                      aria-live="polite"
                      data-testid="draft-dictation-status"
                      className="min-w-0 flex-1 truncate px-1 text-meta text-muted-foreground"
                    >
                      {dictation.active ? dictationStatus(dictation.state) : picked}
                    </span>
                    {dictation.available && (
                      <DictationButton
                        state={dictation.state}
                        hint={dictateHint}
                        level={dictation.level}
                        onToggle={dictation.toggle}
                      />
                    )}
                  </fieldset>
                </div>
              </div>
            }
          />

          <HarnessPreflightNote
            result={preflight.result}
            checking={preflight.checking}
            model={selectedModel}
            onRetry={preflight.recheck}
          />
          {hasImages && (
            <HarnessPreflightNote
              result={imagePreflight.result}
              checking={imagePreflight.checking}
              model={selectedModel}
              onRetry={imagePreflight.recheck}
            />
          )}
          {/* Where it runs: the one control for the folder itself or a worktree, and its branch. A
              folder on another machine runs as it is, as its line under the chips says. */}
          {!onMachine && (
            <fieldset className="flex flex-col gap-2">
              <legend className={labelCls}>Checkout</legend>
              <div role="radiogroup" aria-label="Checkout" className="flex gap-1">
                {CHECKOUTS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={checkout === option.value}
                    disabled={
                      (notRepo && option.value !== "current") ||
                      (machine !== undefined && option.value !== "newWorktree")
                    }
                    title={
                      machine !== undefined && option.value !== "newWorktree"
                        ? `A thread on ${machine.name} runs in a new worktree there.`
                        : undefined
                    }
                    onClick={() => setCheckout(option.value)}
                    className="rounded-md border border-border px-2 py-1 text-reading aria-checked:border-ring aria-checked:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              {notRepo && (
                <p data-testid="checkout-note" className="text-meta text-muted-foreground">
                  Not a git repository, so the thread runs in the folder itself. Run git init to use
                  worktrees.
                </p>
              )}
              {checkout === "current" && !notRepo && projectRoot !== "" && (
                <CurrentCheckoutFreshness repoPath={projectRoot} />
              )}
              {checkout === "newWorktree" && (
                <WorktreeFields repoPath={repoPath} value={worktree} onChange={setWorktree} />
              )}
              {checkout === "existingWorktree" && (
                <ExistingWorktrees
                  repoPath={repoPath}
                  value={existingPath}
                  onChange={setExistingPath}
                />
              )}
              {users.length > 0 && (
                <div ref={noticeRef}>
                  <CheckoutInUseNotice
                    users={users}
                    repo={!notRepo}
                    refused={refused}
                    {...(checkout === "newWorktree"
                      ? {
                          onUseAnotherBranch: () =>
                            setWorktree((current) => ({ ...current, name: randomBranchName() })),
                        }
                      : { onUseNewWorktree: () => setCheckout("newWorktree") })}
                    onCreateAnyway={() => {
                      setAcknowledged(requestKey);
                      void create(true);
                    }}
                  />
                </div>
              )}
            </fieldset>
          )}
          {stage !== "draft" && (
            <ol aria-label="Setup progress" className="flex flex-wrap items-center gap-2 text-meta">
              {SETUP_STAGES[checkout].map((step) => (
                <li
                  key={step}
                  className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-muted-foreground"
                >
                  {stage === "creating" && <Spinner aria-hidden className="size-icon-chip" />}
                  {step}
                </li>
              ))}
            </ol>
          )}
          {/* Where the deployment starts machines on demand, the person's own, in place of the error. */}
          {startMachine ? (
            <StartMachineCard />
          ) : (
            error && (
              <p ref={errorRef} role="alert" className="text-reading text-destructive">
                {error}
              </p>
            )
          )}
        </section>

        <section
          aria-label="More options"
          className="flex flex-col gap-5 border-t border-border pt-4"
        >
          <button
            type="button"
            aria-expanded={optionsOpen}
            aria-controls={optionsId}
            data-testid="new-more-options"
            // While the folder needs fixing it stays open: its field is the way to fix it.
            disabled={folderNeedsFixing}
            onClick={() => setOptionsAsked((open) => !open)}
            className="flex min-h-7 w-fit items-center gap-1 rounded-sm px-1 text-meta font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:hover:text-muted-foreground"
          >
            <ChevronRight
              aria-hidden
              className={cn(
                "size-icon-chip transition-transform duration-(--dur-fast)",
                optionsOpen && "rotate-90",
              )}
            />
            More options
            <span className="font-normal">· the folder&apos;s path, past sessions</span>
          </button>
          <div id={optionsId} hidden={!optionsOpen} className="flex flex-col gap-5">
            {onMachine ? (
              <MachineFolderField
                machine={pickedMachine}
                value={machinePath}
                onChange={setMachinePath}
                status={machineStatus}
              />
            ) : (
              <ProjectPicker value={pathValue} onChange={setTypedRoot} status={folderStatus} />
            )}

            {folder && !onMachine && (
              <div className="flex flex-col gap-2">
                {/* Resumed sessions run on the agent fields' choice, effort included. */}
                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-expanded={resuming}
                    onClick={() => setResuming((open) => !open)}
                  >
                    <History data-icon="inline-start" />
                    {resuming ? "Hide past sessions" : "Resume a past session…"}
                  </Button>
                  <ContinueLatest
                    projectRoot={projectRoot}
                    model={choiceModel(choice)}
                    disabled={!ready}
                  />
                </div>
                {resuming && (
                  <ResumeSessions projectRoot={projectRoot} model={choiceModel(choice)} />
                )}
              </div>
            )}
          </div>
        </section>

        {/* Last, after everything it starts with. */}
        <div className="flex flex-wrap items-center gap-3">
          <PressScale>
            <Button
              type="submit"
              aria-label={createLabel}
              disabled={!valid || stage === "creating"}
            >
              {stage === "creating" ? (
                <Spinner aria-hidden />
              ) : (
                stage === "failed" && <RotateCw aria-hidden data-icon="inline-start" />
              )}
              {createLabel}
              <ShortcutKbd id="draft.create" cap />
            </Button>
          </PressScale>
          {/* Beside Create: who acts and what the agent asks first, from the mode picked above. */}
          <span className="flex min-w-0 flex-1 basis-64">
            <ChatAuthorityLine mode={mode} />
          </span>
        </div>
      </form>
    </div>
  );
}
