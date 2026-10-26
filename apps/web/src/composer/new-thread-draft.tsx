import {
  DEFAULT_SETTINGS,
  sendKeyOf,
  type CheckoutRequest,
  type DraftId,
  type PermissionMode,
} from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUp, History, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useApi } from "@/api/context";
import { HarnessPreflightNote, useHarnessPreflight } from "@/agents/feature-preflight";
import { HarnessSupportDetails } from "@/agents/support-details";
import { checkoutInUsePath } from "@/api/errors";
import { Hint } from "@/components/hint";
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
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
import { focusIfConnected, focusLost } from "@/lib/use-return-focus";
import { cn } from "@/lib/utils";
import { PressScale, Spinner } from "@/motion";
import { CheckoutInUseNotice, useCheckoutUsers } from "@/new-thread/checkout-in-use";
import { ExistingWorktrees } from "@/new-thread/existing-worktrees";
import { folderProblem } from "@/new-thread/fs-errors";
import { ProjectPicker } from "@/new-thread/project-picker";
import { useFolderStatus, useIsGitRepo } from "@/new-thread/use-folder";
import { FolderPicker, WhereChips } from "@/new-thread/where-chips";
import { TaskTargetPicker } from "@/orchestration/task-target-picker";
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
import { modeWarning } from "@/thread/mode-warning";

import { inOpenFence } from "./mention";
import { enterSends } from "./send-key";
import { AgentFields, choiceModel, gatewayReady } from "./agent-fields";
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
import { MODE_ICONS, MODE_OPTIONS } from "./options";
import { useSlabHandoff } from "./slab-handoff";
import { GHOST_TRIGGER, ROUND, SEND_FILL, SLAB, SLAB_TEXTAREA } from "./styles";
import { useAttachments } from "./use-attachments";
import { useMentions } from "./use-mentions";
import {
  CurrentCheckoutFreshness,
  initialWorktreeChoice,
  worktreeCheckout,
  WorktreeFields,
} from "./worktree-fields";

type CheckoutKind = CheckoutRequest["kind"];

const CHECKOUTS: { value: CheckoutKind; label: string }[] = [
  { value: "current", label: "Current checkout" },
  { value: "newWorktree", label: "New worktree" },
  { value: "existingWorktree", label: "Existing worktree" },
];

const SETUP_STAGES: Record<CheckoutKind, string[]> = {
  current: ["Start agent"],
  newWorktree: ["Fetch", "Create worktree", "Copy includes", "Seed permissions", "Start agent"],
  existingWorktree: ["Start agent"],
};

const labelCls = "text-xs font-medium text-muted-foreground";

/**
 * The inline `/new` draft: where the thread runs, on what, and the first prompt. While workspaces
 * are on it is the one-off thread (⌘T), one pick of the target away from New task.
 */
export function NewThreadDraft() {
  const ready = useServerSettings((s) => s.settings !== undefined);
  return ready ? <ConfiguredNewThreadDraft /> : <p role="status">Loading agent preferences…</p>;
}

function ConfiguredNewThreadDraft() {
  const api = useApi();
  const navigate = useNavigate();
  const workspaces = useWorkspaces();
  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
  const recents = projects.toSorted(
    (a, b) =>
      Number(b.bookmarked) - Number(a.bookmarked) || (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0),
  );

  const [typedRoot, setTypedRoot] = useDraftProjectRoot();
  const defaultFolder = useServerSettings((s) => s.settings?.agents.defaultFolder);
  // Unknown until settings load; see `Composer`.
  const sendKey = useServerSettings((s) => (s.settings ? sendKeyOf(s.settings) : undefined));
  const formRef = useRef<HTMLFormElement>(null);
  const startsWithProject = useRef(typedRoot !== undefined || defaultFolder !== undefined);

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
  const checkout: CheckoutKind = notRepo ? "current" : pickedCheckout;
  const [worktree, setWorktree] = useState(initialWorktreeChoice);
  const [existingPath, setExistingPath] = useState("");
  // Capture Settings → Agents once, after settings load; later edits don't replace this draft.
  const savedDefaultModel = useServerSettings((s) => s.settings?.agents.defaultModel);
  const { choice, setChoice, discovering } = useDraftAgentChoice(savedDefaultModel);
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
  const mentionFolder = (checkout === "existingWorktree" ? existingPath.trim() : "") || projectRoot;
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
  const createHint = useShortcutHint("draft.create");
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
        return worktreeCheckout(worktree);
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
    projectRoot !== "" &&
    ready &&
    !preflight.blocked &&
    (!hasImages || !imagePreflight.blocked) &&
    (checkout !== "newWorktree" || worktree.name.trim() !== "") &&
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
        projectRoot,
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

  const browse = () =>
    focusIfConnected(formRef.current?.querySelector('[aria-label="Project path"]'));

  useShortcut({
    id: "draft.create",
    keys: "mod+enter",
    label: "Create thread",
    group: "Composer",
    run: () => void create(),
  });

  const createLabel = stage === "failed" ? "Retry" : "Create thread";
  const ModeIcon = MODE_ICONS[mode];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <form
        ref={formRef}
        className="mx-auto flex w-full max-w-(--thread-max-width) flex-col gap-8 px-6 pb-10"
        aria-label="New thread"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        {/* The hero: the question, and a prompt box shaped like the composer it becomes. */}
        <section className="flex min-h-[min(34rem,72vh)] flex-col justify-center gap-4 pt-8">
          <div className="flex justify-center">
            <TaskTargetPicker
              value={{ kind: "oneOff" }}
              disabled={attachments.uploading}
              workspaces={workspaces}
              projects={projects}
              onPick={(target) => {
                if (target.kind === "oneOff") return;
                carryDraft({ text: prompt, draftId, attachments: attachments.ready });
                if (target.kind === "newWorkspace") return void navigate({ to: "/new-workspace" });
                prefillTaskTarget(target);
                void navigate({ to: "/new-task" });
              }}
            />
          </div>

          <h1 className="text-center font-heading text-2xl font-normal tracking-tight text-balance sm:text-3xl">
            What should we build in{" "}
            <FolderPicker
              inline
              folder={projectRoot}
              projects={recents}
              onPickFolder={setTypedRoot}
              onBrowse={browse}
            />
            ?
          </h1>

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
                    : "Describe the task. @ mentions a file, and pasted or dropped files attach. Leave it empty to open a warm draft."
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
            {dictation.partial !== "" && (!caretAtEnd || (partialInline && partialOverflows)) && (
              <DictationStrip partial={dictation.partial} />
            )}
            <DictationError state={dictation.state} />
            <fieldset className="flex flex-wrap items-center gap-1 px-2 pb-2">
              <legend className="sr-only">Agent</legend>
              {discovering ? (
                <span role="status" className="px-2 text-xs text-muted-foreground">
                  Discovering local agents…
                </span>
              ) : (
                <AgentFields ghost value={choice} onChange={setChoice} />
              )}
              <Select
                value={mode}
                items={MODE_OPTIONS}
                onValueChange={(value) => {
                  if (value !== null) setMode(value as PermissionMode);
                }}
              >
                <SelectTrigger
                  size="sm"
                  aria-label="Mode"
                  data-warning={modeWarning(mode) ? "true" : undefined}
                  title={modeWarning(mode)}
                  className={cn(
                    GHOST_TRIGGER,
                    modeWarning(mode) && "text-status-needs hover:text-status-needs",
                  )}
                >
                  <ModeIcon aria-hidden className="size-3.5" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
              <PressScale hover={valid && stage !== "creating" ? 1.05 : undefined}>
                <Hint
                  label={withHint(createLabel, createHint)}
                  render={
                    <button
                      type="submit"
                      aria-label={createLabel}
                      disabled={!valid || stage === "creating"}
                      className={cn(ROUND, SEND_FILL)}
                    />
                  }
                >
                  {stage === "creating" ? (
                    <Spinner aria-hidden className="size-4" />
                  ) : stage === "failed" ? (
                    <RotateCw aria-hidden className="size-4" />
                  ) : (
                    <ArrowUp aria-hidden className="size-4" strokeWidth={2.25} />
                  )}
                </Hint>
              </PressScale>
            </fieldset>
          </div>

          <HarnessPreflightNote
            result={preflight.result}
            checking={preflight.checking}
            model={selectedModel}
            onRetry={preflight.recheck}
          />
          <HarnessSupportDetails
            observation={preflight.observation}
            imageInput={imagePreflight.result.support}
          />
          {hasImages && (
            <HarnessPreflightNote
              result={imagePreflight.result}
              checking={imagePreflight.checking}
              model={selectedModel}
              onRetry={imagePreflight.recheck}
            />
          )}
          {/* Where it runs, hung under the box: the branch it starts from and the worktree. */}
          <div className="px-3">
            <WhereChips
              showFolder={false}
              folder={projectRoot}
              projects={recents}
              onPickFolder={setTypedRoot}
              onBrowse={browse}
              repoPath={notRepo ? "" : repoPath}
              worktree={checkout !== "current"}
              onWorktree={(next) => setCheckout(next ? "newWorktree" : "current")}
              base={checkout === "newWorktree" ? worktree.base : undefined}
              onBase={(base) => setWorktree((current) => ({ ...current, base }))}
            />
          </div>

          {stage !== "draft" && (
            <ol aria-label="Setup progress" className="flex flex-wrap items-center gap-2 text-xs">
              {SETUP_STAGES[checkout].map((step) => (
                <li
                  key={step}
                  className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-muted-foreground"
                >
                  {stage === "creating" && <Spinner aria-hidden className="size-3" />}
                  {step}
                </li>
              ))}
            </ol>
          )}
          {error && (
            <p ref={errorRef} role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </section>

        <section
          aria-label="More options"
          className="flex flex-col gap-5 border-t border-border pt-6"
        >
          <ProjectPicker
            value={pathValue}
            onChange={setTypedRoot}
            status={folderStatus}
            projects={projects}
          />

          {folder && (
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
              {resuming && <ResumeSessions projectRoot={projectRoot} model={choiceModel(choice)} />}
            </div>
          )}

          <fieldset className="flex flex-col gap-2">
            <legend className={labelCls}>Checkout</legend>
            <div role="radiogroup" aria-label="Checkout" className="flex gap-1">
              {CHECKOUTS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={checkout === option.value}
                  disabled={notRepo && option.value !== "current"}
                  onClick={() => setCheckout(option.value)}
                  className="rounded-md border border-border px-2 py-1 text-sm aria-checked:border-ring aria-checked:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {option.label}
                </button>
              ))}
            </div>
            {notRepo && (
              <p data-testid="checkout-note" className="text-xs text-muted-foreground">
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
        </section>
      </form>
    </div>
  );
}
