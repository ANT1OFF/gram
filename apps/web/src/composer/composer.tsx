import {
  modelSpeeds,
  type SpeedMode,
  effectiveCheckout,
  helperOn,
  sendKeyOf,
  type DraftStash,
  type PermissionMode,
  StashId,
  type SuggestEvent,
  type ThreadId,
  type ThreadStatus,
  type UserInput,
} from "@gram/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Menu } from "@base-ui/react/menu";
import {
  ArrowUp,
  ChevronDown,
  ListPlus,
  Send,
  Square,
  SquareArrowRight,
  SquarePen,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type RefObject,
} from "react";

import { AgentIcon, agentLabel } from "@/agents/agent-display";
import { RECONNECT_WAIT_MS, whenReconnected } from "@/api/connection";
import { useApi } from "@/api/context";
import { hostedSiteGrant } from "@/desktop/hosted-site-grant";
import { useWindowAttended } from "@/desktop/use-window-attended";
import { errorMessage } from "@/api/errors";
import { Hint } from "@/components/hint";
import { worktreeMissing } from "@/components/worktree-missing";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { shortcutPressed } from "@/keyboard/bindings";
import { runShortcut, useShortcut } from "@/keyboard/registry";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
import { useLatest, useMountEffect, useSubscription } from "@/lib/effects";
import { listIndexForKey } from "@/lib/list-keys";
import { usePhone } from "@/lib/use-phone";
import { cn } from "@/lib/utils";
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
import { PressScale, RingSpinner, RunningEdge, SharedSlab, Swap } from "@/motion";
import { useServerSettings } from "@/settings-sync/store";
import { activityLine, backgroundWorking } from "@/sidebar/status";
import { useDiffComments, useDiffCommentsStore, withDiffComments } from "@/stores/diff-comments";
import { usePagePicks, usePagePicksStore, withPagePicks } from "@/stores/page-picks";
import { useDraftStore } from "@/stores/drafts";
import { useSuggestionsStore } from "@/stores/suggestions";
import { useThreadsStore } from "@/stores/threads";
import { WAIT_WORDS } from "@/thread/awaiting-machine-model";
import { SWITCH_PREFIX, switchGroupHead } from "@/thread/agent-switch-model";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";
import { useSwitchOffer } from "@/thread/use-switch-offer";

import { AttachmentChips } from "./attachment-chips";
import { ContextRing } from "./context-ring";
import { aboveComposer } from "./above-composer";
import { onModelPickerAsked } from "./model-picker-request";
import { PendingRestart } from "./pending-restart";
import { DiffCommentChips } from "./diff-comment-chips";
import { PagePickChips } from "./page-pick-chips";
import { ghostOf, nextWord, stepped, typeIntoField, type Ghost } from "./ghost";
import { usePromptHistory } from "./history";
import { useAttachments } from "./use-attachments";

import { MentionMenu } from "./mention-menu";
import { useIsFavourite, useModelFavourites } from "./model-favourites";
import {
  accountModelWarning,
  effortAfterSwitch,
  effortOptions,
  gatewayModelWarning,
  modelOptions,
  ModelsAllowedBy,
  pickerModelId,
  unlistedWarning,
  useModels,
  useModelsSettled,
  useProviderLabel,
  useRefreshModels,
} from "./models";
import { effortSection, modelSection, modeSection, speedSection } from "./choice-sections";
import { ComposerChoices, type ChoiceSection } from "./choices";
import { DEFAULT_EFFORT, DEFAULT_EFFORT_OPTION, MODE_OPTIONS, pickedVariant } from "./options";
import type { PickerOption } from "./picker";
import { chipSwitchAgent, switchChoices } from "./switch-choices";
import { inOpenFence } from "./mention";
import { sendAction, type SendAction } from "./send-action";
import { enterSends, imeComposing } from "./send-key";
import { prefillDraftProject } from "./draft-prefill";
import { filterCommands, slashQuery } from "./slash";
import { SlashMenu, SlashNote } from "./slash-menu";
import {
  menuCommands,
  resolveTyped,
  gramLast,
  type MenuCommand,
  type NativeAction,
} from "./slash-native";
import { useSlabHandoff } from "./slab-handoff";
import { useOrchestratorVerbs, VerbMenu } from "./verb-menu";
import { filterVerbs, gridIndexForKey, VERB_COLUMNS, type Verb } from "./verbs";
import {
  GHOST_MIRROR,
  PHONE_HIT,
  ROUND,
  SEND_FILL,
  SLAB,
  SLAB_TEXTAREA,
  STOP_FILL,
  STOP_QUIET,
} from "./styles";
import { StashMenu, stashesQueryKey } from "./stash-menu";
import { useMentions } from "./use-mentions";
import { clickDelivery, useHeldDelivery } from "./use-mod-held";
import { useTypingPresence } from "./typing-presence";
import { stopTurn } from "@/thread/stop-store";

const RUNNING: ReadonlySet<ThreadStatus> = new Set(["starting", "running"]);
const BUSY: ReadonlySet<ThreadStatus> = new Set([
  "starting",
  "running",
  "needsApproval",
  "needsInput",
]);
const WAITING_ON_YOU: ReadonlySet<ThreadStatus> = new Set(["needsApproval", "needsInput"]);
const HINT_MS = 2500;
const waitingThreads = new Set<string>();
const RECONNECT_HINT = "Waiting for the connection — sends once it's back";

type ComposerProps = {
  threadId: ThreadId;
  focused: boolean;
  placeholder?: string | undefined;
  toWorker?: boolean;
};

/** A thread's prompt box, whose model lists offer only what the thread's profile lets it run. */
export function Composer(props: ComposerProps) {
  const profile = useThreadsStore((s) => s.byId[props.threadId]?.thread.profile);
  return (
    <ModelsAllowedBy profile={profile}>
      <ThreadComposer {...props} />
    </ModelsAllowedBy>
  );
}

function ThreadComposer({ threadId, focused, placeholder, toWorker = false }: ComposerProps) {
  const api = useApi();
  const typing = useTypingPresence();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const handoff = useSlabHandoff((s) => (s.threadId === threadId ? s.from : undefined));
  const summary = useThreadsStore((s) => s.byId[threadId]);
  const identity = useThreadsStore((s) => s.byId[threadId]?.identity);

  const text = useDraftStore((s) => s.text[threadId] ?? "");
  const editing = useDraftStore((s) => s.edits[threadId]);
  const setText = (value: string) => useDraftStore.getState().setText(threadId, value);
  const attachments = useAttachments({ threadId });
  const diffComments = useDiffComments(threadId);
  const pagePicks = usePagePicks(threadId);
  const [hint, setHint] = useState<string | undefined>();
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hintMounted = useRef(false);
  useEffect(() => {
    hintMounted.current = true;
    return () => {
      hintMounted.current = false;
      clearTimeout(hintTimer.current);
    };
  }, []);
  const [dragging, setDragging] = useState(false);
  const phone = usePhone();
  const dragDepth = useRef(0);
  const sendHint = useShortcutHint("composer.send");
  const newDraftHint = useShortcutHint("composer.sendNewDraft");
  const stopHint = useShortcutHint("composer.stop");
  const queueHint = useShortcutHint("composer.queue");

  const history = usePromptHistory(threadId);
  const status = summary?.status ?? "cold";
  const running = RUNNING.has(status);
  const busy = BUSY.has(status);
  const sendKey = useServerSettings((s) => (s.settings ? sendKeyOf(s.settings) : undefined));
  const background = useThreadsStore((s) =>
    backgroundWorking(status, activityLine(status, s.statusDetail[threadId], summary?.activity)),
  );
  const waitingOnYou = WAITING_ON_YOU.has(status) && !background;
  const atCard = WAITING_ON_YOU.has(status);
  const folderGone = worktreeMissing(summary?.git);
  const steerable = busy && summary?.capabilities?.steer === true && !folderGone;
  const interruptible = steerable && (atCard || summary?.capabilities?.steerInterrupt === true);
  const steerRefusal =
    !busy || steerable
      ? undefined
      : folderGone
        ? "This thread's folder is gone, so its turn takes nothing more"
        : "This agent can't take a message mid-turn, so it waits for the turn to end";
  const [picked, setPicked] = useState<Delivery>("steer");
  useEffect(() => {
    if (!steerable) setPicked("steer");
  }, [steerable]);
  const agent = summary?.thread.model?.agent ?? "claude";
  const canFork = summary?.capabilities?.fork === true;
  const reported = identity?.commands;
  const available = useMemo(
    () => menuCommands(agent, reported ?? [], canFork),
    [agent, reported, canFork],
  );
  const query = slashDismissed ? undefined : slashQuery(text);
  const orchestrator = useOrchestratorVerbs(threadId);
  const verbs =
    query === undefined || orchestrator === undefined ? [] : filterVerbs(orchestrator.verbs, query);
  const commands =
    query === undefined || verbs.length > 0 ? [] : filterCommands(available, query, gramLast);
  const optionCount = verbs.length > 0 ? verbs.length : commands.length;
  const menuOpen = optionCount > 0;
  const typedCommand = resolveTyped(agent, text, reported ?? [], canFork);
  const slashNote =
    typedCommand.kind === "unavailable" && !menuOpen ? typedCommand.note : undefined;
  const activeIndex = Math.min(slashIndex, optionCount - 1);
  const menuId = `slash-menu-${threadId}`;
  const canSend =
    !attachments.uploading &&
    (text.trim() !== "" ||
      attachments.ready.length > 0 ||
      diffComments.length > 0 ||
      pagePicks.length > 0);

  const root = summary === undefined ? undefined : effectiveCheckout(summary.thread).path;
  const mentions = useMentions({
    id: `mention-menu-${threadId}`,
    text,
    setText,
    source:
      root === undefined
        ? undefined
        : { key: [threadId, root], load: () => api.fsFiles({ threadId }) },
    disabled: menuOpen,
  });
  const listOpen = menuOpen || mentions.open;
  const listId = menuOpen ? menuId : mentions.id;
  const listActiveIndex = menuOpen ? activeIndex : mentions.activeIndex;

  const fieldRef = mentions.textareaProps.ref;
  const mirrorRef = useRef<HTMLDivElement>(null);
  const suggestOn = useServerSettings(
    (s) => s.settings !== undefined && helperOn(s.settings, "suggest"),
  );
  const suggestions = useSuggestionsStore((s) => (suggestOn ? s.byThread[threadId] : undefined));
  const attended = useWindowAttended();
  const [fieldFocused, setFieldFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [caretAtEnd, trackCaret] = useCaretAtEnd();
  const inserting = useRef(false);

  const dictation = useComposerDictation({
    fieldRef,
    text,
    setText,
    insertingRef: inserting,
    enabled: focused,
    threadId,
  });
  const dictateHint = useShortcutHint("composer.dictate");
  const ghost = ghostOf({
    text,
    entry: suggestions,
    caretAtEnd,
    blocked:
      listOpen ||
      composing ||
      history.navigating ||
      !fieldFocused ||
      busy ||
      background ||
      editing !== undefined ||
      dictation.active,
  });
  const accepted = useRef<{ turnId: string; text: string } | undefined>(undefined);
  const record = (event: SuggestEvent) =>
    void api
      .recordHelperEvent({ kind: "suggest", event })
      .catch((error: unknown) => console.warn("suggestions", error));

  const shown = ghost !== undefined;
  const partialInline = ghost === undefined && dictation.partial !== "" && caretAtEnd;
  const ghostRest = ghost?.rest ?? (partialInline ? dictation.partial : undefined);
  const ghostPosition = ghost?.position;
  const hintPinned = useMirrorFit(fieldRef, mirrorRef, ghostRest, ghostPosition, text);
  useEffect(() => {
    if (shown && useSuggestionsStore.getState().count(threadId)) record("shown");
    // oxlint-disable-next-line react/exhaustive-deps -- `record` is recreated every render and only reads `api`
  }, [shown, threadId]);

  const turns = useRef(0);
  useSubscription(
    () =>
      useThreadsStore.subscribe((s, previous) => {
        const now = s.byId[threadId]?.status;
        const before = previous.byId[threadId]?.status;
        if (now !== undefined && RUNNING.has(now) && (before === undefined || !RUNNING.has(before)))
          turns.current += 1;
      }),
    [threadId],
  );

  const looking = focused && attended;
  const lastActivityAt = summary?.thread.lastActivityAt;
  const askedFor = useRef<string | undefined>(undefined);
  const generation = useSuggestionsStore((s) => s.generation);
  useEffect(() => {
    const key = `${threadId}:${lastActivityAt}:${generation}:${suggestions?.takenBack ?? 0}`;
    const held = suggestions !== undefined && !suggestions.stale;
    if (!suggestOn || !looking || busy || held || askedFor.current === key) {
      return;
    }
    if ((useDraftStore.getState().text[threadId] ?? "") !== "") return;
    askedFor.current = key;
    const turnsAtAsk = turns.current;
    api
      .threadSuggestions(threadId)
      .then((next) => {
        if (next !== null && turns.current === turnsAtAsk) {
          useSuggestionsStore.getState().offer(next);
        }
      })
      .catch((error: unknown) => console.warn("suggestions", error));
  }, [api, busy, generation, looking, lastActivityAt, suggestOn, suggestions, threadId]);

  const acceptSuggestion = (current: Ghost, insert: string, whole: boolean) => {
    const field = fieldRef.current;
    if (field === null || suggestions === undefined) return;
    useSuggestionsStore.getState().choose(threadId, current.suggestion);
    inserting.current = true;
    try {
      if (!typeIntoField(field, insert)) setText(text + insert);
    } finally {
      inserting.current = false;
    }
    if (useSuggestionsStore.getState().take(threadId)) record("taken");
    if (whole) {
      accepted.current = {
        turnId: suggestions.turnId,
        text: current.suggestion,
      };
      record("accepted");
    } else {
      record("wordAccepted");
    }
  };

  const flash = (message: string) => {
    if (!hintMounted.current) return;
    clearTimeout(hintTimer.current);
    setHint(message);
    hintTimer.current = setTimeout(() => setHint(undefined), HINT_MS);
  };

  const take = ():
    | {
        input: UserInput;
        giveBack: () => void;
        release: () => void;
        active: () => boolean;
      }
    | undefined => {
    if (!canSend) return undefined;
    const files = attachments.capture();
    const typed = (useDraftStore.getState().text[threadId] ?? "").trim();
    if (
      !files.active ||
      files.uploading ||
      (typed === "" &&
        files.ready.length === 0 &&
        (useDiffCommentsStore.getState().byThread[threadId]?.length ?? 0) === 0 &&
        (usePagePicksStore.getState().byThread[threadId]?.length ?? 0) === 0)
    ) {
      files.release();
      return undefined;
    }
    if (accepted.current !== undefined) {
      if (
        accepted.current.turnId === suggestions?.turnId &&
        typed !== accepted.current.text.trim()
      ) {
        record("editedAfter");
      }
      accepted.current = undefined;
    }
    const reviewed = useDiffCommentsStore.getState().take(threadId);
    const pickedOnPage = usePagePicksStore.getState().take(threadId);
    const input: UserInput = {
      text: withPagePicks(pickedOnPage, withDiffComments(reviewed, typed)),
      ...(files.ready.length > 0 ? { attachments: files.ready } : {}),
    };
    history.push(typed);
    setText("");
    useSuggestionsStore.getState().dismiss(threadId);
    attachments.clear();
    setSlashDismissed(false);
    mentions.reset();
    const giveBack = () => {
      if (!files.restore()) return;
      const since = (useDraftStore.getState().text[threadId] ?? "").trim();
      setText([typed, since].filter(Boolean).join("\n\n"));
      useDiffCommentsStore.getState().restore(threadId, reviewed);
      usePagePicksStore.getState().restore(threadId, pickedOnPage);
    };
    return {
      input,
      giveBack,
      release: files.release,
      active: () => files.active,
    };
  };

  const waitAborts = useRef(new Set<AbortController>());
  useMountEffect(() => {
    const aborts = waitAborts.current;
    return () => {
      for (const abort of aborts) abort.abort();
    };
  });
  const latestDraft = useLatest({ text, items: attachments.items });
  const connected = async (): Promise<boolean> => {
    if (!attachments.active) return false;
    if (api.connection.get().status !== "reconnecting") return true;
    if (waitingThreads.has(threadId)) {
      clearTimeout(hintTimer.current);
      setHint(RECONNECT_HINT);
      return false;
    }
    waitingThreads.add(threadId);
    const abort = new AbortController();
    waitAborts.current.add(abort);
    clearTimeout(hintTimer.current);
    setHint(RECONNECT_HINT);
    try {
      const back = await whenReconnected(api.connection, RECONNECT_WAIT_MS, abort.signal);
      if (abort.signal.aborted || !attachments.active) return false;
      if (!back) {
        flash("Couldn't send: not connected to the server. Your message is still here.");
        return false;
      }
      const now = latestDraft.current;
      const same =
        now.text === text &&
        now.items.length === attachments.items.length &&
        now.items.every(
          (each, i) =>
            each.key === attachments.items[i]?.key && each.status === attachments.items[i]?.status,
        );
      if (!same) {
        flash("Connected again: send your message when it's ready");
        return false;
      }
      setHint((current) => (current === RECONNECT_HINT ? undefined : current));
      return true;
    } finally {
      waitAborts.current.delete(abort);
      waitingThreads.delete(threadId);
    }
  };

  const send = async (newDraft = false) => {
    if (intercept()) return;
    const granting = hostedSiteGrant(threadId);
    if (!(await connected())) return;
    const taken = take();
    if (!taken) return;
    const { input, giveBack, release, active } = taken;
    try {
      const deviceGrant = await granting;
      if (editing) {
        await api.rewind(threadId, editing.messageId, editing.files);
        if (!active()) return;
        useDraftStore.getState().cancelEdit(threadId);
      }
      const result = await (deviceGrant === undefined
        ? api.send(threadId, input)
        : api.send(threadId, input, { deviceGrant }));
      if (!active()) return;
      if (result.queued) {
        const waits =
          useThreadsStore.getState().byId[threadId]?.thread.awaitingMachine !== undefined;
        flash(waits ? WAIT_WORDS.queued : "Queued — sends when the turn ends");
      }
    } catch (error) {
      giveBack();
      if (active()) flash(`Couldn't send: ${errorMessage(error)}`);
      return;
    } finally {
      release();
    }
    if (newDraft && attachments.active) void navigate({ to: "/new" });
  };

  const steer = async (interrupt = false) => {
    if (intercept()) return;
    if (!(await connected())) return;
    const taken = take();
    if (!taken) return;
    const { input, giveBack, release, active } = taken;
    const stops = interrupt && interruptible;
    try {
      await (stops ? api.steer(threadId, input, { interrupt: true }) : api.steer(threadId, input));
      if (active()) {
        flash(
          stops
            ? atCard
              ? "Stopping the turn, then sending…"
              : "Interrupting…"
            : interrupt
              ? "This agent can't be interrupted for a message, so it was steered in"
              : atCard
                ? "Steered: the agent reads it once the card is answered"
                : "Steering…",
        );
      }
    } catch (error) {
      giveBack();
      if (active()) flash(`Couldn't steer: ${errorMessage(error)}`);
    } finally {
      release();
    }
  };

  const deliver = (action: Exclude<SendAction, "stop">) => {
    setPicked("steer");
    switch (action) {
      case "send":
      case "queue":
        return void send();
      case "steer":
        return void steer();
      case "interrupt":
        return void steer(true);
    }
  };
  const sendNow = () => {
    const action = sendAction({
      hasDraft: true,
      busy,
      background,
      steerable,
      held: undefined,
      picked,
    });
    if (action !== "stop") deliver(action);
  };

  useShortcut(
    {
      id: "composer.send",
      keys: "mod+enter",
      label: "Send (steers while running)",
      group: "Composer",
      run: sendNow,
    },
    focused,
  );
  useShortcut(
    {
      id: "composer.queue",
      keys: "alt+enter",
      label: "Queue for after the turn",
      group: "Composer",
      run: () => void send(),
    },
    focused,
  );
  useShortcut(
    {
      id: "composer.sendNewDraft",
      keys: "mod+alt+enter",
      label: "Send and start a new draft",
      group: "Composer",
      run: () => void send(true),
    },
    focused,
  );

  const refreshStashes = () =>
    void queryClient.invalidateQueries({ queryKey: stashesQueryKey(threadId) });

  const stash = async (): Promise<boolean> => {
    const files = attachments.claim("stash");
    if (files === undefined) return false;
    const currentText = useDraftStore.getState().text[threadId] ?? "";
    if (
      !files.active ||
      files.uploading ||
      (currentText.trim() === "" && files.ready.length === 0)
    ) {
      files.release();
      return false;
    }
    const draft = {
      id: StashId.make(crypto.randomUUID()),
      text: currentText,
      attachments: files.ready,
    };
    setText("");
    files.consume();
    setSlashDismissed(false);
    try {
      await api.stashDraft(threadId, draft);
      refreshStashes();
      return files.active;
    } catch (error) {
      if (files.restore()) {
        const since = useDraftStore.getState().text[threadId] ?? "";
        setText([draft.text, since].filter((value) => value !== "").join("\n\n"));
      }
      if (files.active) flash(`Couldn't stash the draft: ${errorMessage(error)}`);
      return false;
    } finally {
      files.release();
    }
  };

  const restore = async (saved: DraftStash) => {
    const files = attachments.claim("restore");
    if (files === undefined) return;
    if (!files.active) {
      files.release();
      return;
    }
    const replacing = text.trim() !== "" || attachments.items.length > 0;
    try {
      if (replacing && !(await stash())) return;
      if (!files.active) return;
      const taken = await api.takeStash(threadId, saved.id);
      if (!files.active) return;
      const since = useDraftStore.getState().text[threadId] ?? "";
      setText([taken.text, since].filter((value) => value !== "").join("\n\n"));
      attachments.adopt(taken.attachments);
      if (replacing) flash("Stashed your current draft");
    } catch (error) {
      if (files.active) flash(`Couldn't restore the draft: ${errorMessage(error)}`);
    } finally {
      files.release();
      refreshStashes();
    }
  };

  useShortcut(
    {
      id: "composer.stash",
      keys: "mod+s",
      label: "Stash the draft",
      group: "Composer",
      when: () => surfaceRef.current?.contains(document.activeElement) === true,
      run: () => {
        void stash().then((stashed) => stashed && flash("Draft stashed"));
      },
    },
    focused,
  );

  const runNative = async (action: NativeAction, args: string, typedText: string) => {
    const failed = (what: string) => (error: unknown) => {
      const since = (useDraftStore.getState().text[threadId] ?? "").trim();
      setText([typedText, since].filter(Boolean).join("\n\n"));
      flash(`${what}: ${errorMessage(error)}`);
    };
    const dialogs = useThreadDialogs.getState();
    switch (action) {
      case "newThread": {
        const checkout = summary?.thread.checkout;
        prefillDraftProject(checkout ? (checkout.repoRoot ?? checkout.path) : undefined);
        return void navigate({ to: "/new" });
      }
      case "pickModel": {
        const wanted = args.toLowerCase();
        const match = modelChoices.find(
          (o) =>
            wanted !== "" && (o.value.toLowerCase() === wanted || o.label.toLowerCase() === wanted),
        );
        if (match !== undefined) return onModel(match.value);
        if (wanted !== "") flash(`No model called ${args} here`);
        return void runShortcut("composer.model");
      }
      case "pickEffort":
        return void runShortcut("composer.effort");
      case "pickMode":
        return void runShortcut("composer.mode");
      case "rename":
        if (args === "") return dialogs.open({ kind: "rename", threadId });
        return api
          .rename(threadId, args)
          .then(() => flash("Renamed the thread"), failed("Couldn't rename the thread"));
      case "fork":
        return dialogs.open({ kind: "fork", threadId });
      case "findThread":
        return void runShortcut("palette.open");
      case "addDirectory":
        return api
          .addDirectory(threadId, args)
          .then((folder) => flash(`The agent can use ${folder} now`), failed("Couldn't add it"));
      case "closeThread":
        return dialogs.open({ kind: "close", threadId });
      case "connectors":
        return void navigate({ to: "/settings/connectors" });
      case "agentSettings":
        return void navigate({ to: "/settings/agents" });
      case "help":
        return void navigate({ to: "/settings/help" });
    }
  };

  const intercept = (): boolean => {
    const typedText = text.trim();
    const resolved = resolveTyped(agent, typedText, reported ?? [], canFork);
    if (resolved.kind === "agent") return false;
    if (resolved.kind === "unavailable") return true;
    if (resolved.action === "addDirectory" && resolved.args === "") {
      flash("Name the folder after it: /add-dir ~/code/other");
      return true;
    }
    history.push(typedText);
    setText("");
    setSlashDismissed(false);
    void runNative(resolved.action, resolved.args, typedText);
    return true;
  };

  const choose = (command: MenuCommand) => {
    setText(`/${command.name} `);
    setSlashIndex(0);
  };

  const chooseVerb = (verb: Verb) => {
    setText("");
    setSlashIndex(0);
    setSlashDismissed(false);
    orchestrator?.run(verb.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !imeComposing(event);
    if (menuOpen && plain) {
      const next =
        verbs.length > 0
          ? gridIndexForKey(event.key, activeIndex, verbs.length, VERB_COLUMNS)
          : listIndexForKey(event.key, activeIndex, commands.length);
      if (next !== undefined) {
        event.preventDefault();
        return setSlashIndex(next);
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        return verbs.length > 0 ? chooseVerb(verbs[activeIndex]!) : choose(commands[activeIndex]!);
      }
      if (event.key === "Escape") {
        event.preventDefault();
        return setSlashDismissed(true);
      }
    }
    if (mentions.onKeyDown(event)) return;
    if (ghost !== undefined) {
      const native = event.nativeEvent;
      const step = shortcutPressed("composer.nextSuggestion", native)
        ? 1
        : shortcutPressed("composer.previousSuggestion", native)
          ? -1
          : 0;
      if (shortcutPressed("composer.acceptSuggestion", native)) {
        event.preventDefault();
        return acceptSuggestion(ghost, ghost.rest, true);
      }
      if (shortcutPressed("composer.acceptSuggestionWord", native)) {
        event.preventDefault();
        const word = nextWord(ghost.rest);
        return acceptSuggestion(ghost, word, word === ghost.rest);
      }
      if (step !== 0 && ghost.count > 1) {
        event.preventDefault();
        return useSuggestionsStore.getState().choose(threadId, stepped(ghost, step));
      }
      if (event.key === "Escape" && plain) {
        event.preventDefault();
        useSuggestionsStore.getState().dismiss(threadId);
        return record("dismissed");
      }
    }
    const caret = event.currentTarget.selectionStart;
    const fenced = inOpenFence(event.currentTarget.value.slice(0, caret));
    if (
      (!fenced && enterSends(event.nativeEvent, sendKey)) ||
      shortcutPressed("composer.send", event.nativeEvent)
    ) {
      event.preventDefault();
      return sendNow();
    }
    if (shortcutPressed("composer.queue", event.nativeEvent)) {
      event.preventDefault();
      return void send();
    }
    if (steerable && hasDraft && shortcutPressed("composer.stop", event.nativeEvent)) {
      event.preventDefault();
      return deliver("interrupt");
    }
    if (!plain || event.shiftKey) return;
    const { selectionStart, selectionEnd, value } = event.currentTarget;
    if (event.key === "ArrowUp" && selectionStart === 0 && selectionEnd === 0) {
      if (value !== "" && !history.navigating) return;
      const previous = history.previous(value);
      if (previous !== undefined) {
        event.preventDefault();
        setText(previous);
        mentions.quiet(previous, previous.length);
      }
    } else if (event.key === "ArrowDown" && history.navigating && selectionStart === value.length) {
      const next = history.next();
      if (next !== undefined) {
        event.preventDefault();
        setText(next);
        mentions.quiet(next, next.length);
      }
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (attachments.add(event.clipboardData.files)) event.preventDefault();
    else mentions.onPaste();
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    attachments.add(event.dataTransfer.files);
  };
  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragLeave = () => {
    if (dragDepth.current === 0) return;
    dragDepth.current -= 1;
    if (dragDepth.current === 0) setDragging(false);
  };

  const model = summary?.thread.model;
  const models = useModels(model?.agent ?? "claude", model?.profileId);
  const refreshModels = useRefreshModels(model?.agent ?? "claude", model?.profileId);
  const onModelAsked = useCallback(
    (open: () => void) => onModelPickerAsked(threadId, open),
    [threadId],
  );
  const provider = useProviderLabel(model?.agent ?? "claude", model?.profileId);
  const pickedModel = pickerModelId(models, model?.model);
  const modelChoices = modelOptions(
    models,
    pickedModel ?? summary?.identity?.model,
    model && model.agent !== "claude" ? [] : undefined,
    unlistedWarning(model?.agent ?? "claude", model?.profileId),
    provider,
  );
  const efforts = effortOptions(models, pickedModel);
  const effortChoices = efforts.length > 0 ? [DEFAULT_EFFORT_OPTION, ...efforts] : [];
  const modelWarning =
    model?.profileId !== undefined
      ? gatewayModelWarning(models, model.model)
      : model?.agent === "claude"
        ? accountModelWarning(models, model.model)
        : undefined;
  const isFavourite = useIsFavourite(model?.agent ?? "claude");
  const offer = useSwitchOffer(threadId);
  const otherAgent = chipSwitchAgent(offer);
  const otherModels = useModelsSettled(otherAgent ?? "codex", otherAgent !== undefined).models;
  const otherChoices = switchChoices({
    offer,
    models: otherModels,
    group: agentLabel(otherAgent ?? "codex"),
    icon: <AgentIcon agent={otherAgent ?? "codex"} className="size-icon-row" />,
  });
  const heads =
    model === undefined || otherAgent === undefined || otherChoices.length === 0
      ? undefined
      : {
          [provider]: {
            mark: <AgentIcon agent={model.agent} className="size-icon-chip" />,
            hint: provider,
            words: provider,
          },
          [agentLabel(otherAgent)]: {
            mark: <AgentIcon agent={otherAgent} className="size-icon-chip" />,
            ...switchGroupHead(offer),
          },
        };

  const hasDraft = canSend || attachments.uploading;
  const stopLabel = background ? "Stop the background agents" : "Stop";
  const held = useHeldDelivery(steerable && hasDraft);
  const action = sendAction({ hasDraft, busy, background, steerable, held, picked });
  const way: Delivery = steerable ? (held ?? picked) : "queue";
  const sendKeyHint = sendKey === "enter" ? "↵" : sendHint;
  const deliveryKeys: Record<Delivery, string> = {
    steer: sendKeyHint ?? "",
    queue: (steerable ? queueHint : sendKeyHint) ?? "⌥↵",
    interrupt: stopHint ?? "",
  };
  const deliveryLines: Record<Delivery, string> = {
    steer:
      steerRefusal ??
      (atCard
        ? "After you answer the card, cancelling nothing"
        : "After the current tool call, cancelling nothing"),
    queue: "After the turn ends",
    interrupt:
      steerRefusal ??
      (!interruptible
        ? "This agent can't stop for a message, so it steers in"
        : atCard
          ? "Stops the turn, withdrawing the card, then sends"
          : "Stops the turn now, cutting off tool calls"),
  };
  const deliveryHint = (delivery: Delivery) =>
    withHint(
      `${DELIVERY_WORDS[delivery]}: ${lowerFirst(deliveryLines[delivery])}`,
      deliveryKeys[delivery],
    );
  const actionLabels = {
    send: {
      aria: "Send",
      hint: withHint("Send", sendKeyHint),
    },
    queue: { aria: "Queue", hint: deliveryHint("queue") },
    steer: { aria: "Steer", hint: deliveryHint("steer") },
    interrupt: { aria: "Interrupt", hint: deliveryHint("interrupt") },
    stop: {
      aria: "Stop",
      hint: withHint(waitingOnYou ? "Stop the turn instead of answering" : stopLabel, stopHint),
    },
  } as const;
  useShortcut(
    {
      id: "composer.stop",
      keys: "mod+.",
      label: "Stop the turn (with a draft: interrupt with it)",
      group: "Composer",
      run: () => (hasDraft && steerable ? deliver("interrupt") : void stopTurn(api, threadId)),
    },
    focused && (busy || background),
  );
  const roundAction: "send" | "stop" = busy || action === "stop" ? "stop" : "send";
  const runAction = (event: MouseEvent<HTMLButtonElement>) => {
    const clicked = sendAction({
      hasDraft,
      busy,
      background,
      steerable,
      held: clickDelivery(event),
      picked,
    });
    if (clicked !== "stop") return deliver(clicked);
    if (event.detail > 1) return;
    return void stopTurn(api, threadId);
  };
  const runDelivery = (event: MouseEvent<HTMLButtonElement>) => {
    if (!hasDraft) return void fieldRef.current?.focus();
    return runAction(event);
  };
  const withSendMenu = (trigger: ReactElement) => (
    <ContextMenu>
      <ContextMenuTrigger data-testid="send-menu-trigger" render={<span className="inline-flex" />}>
        {trigger}
      </ContextMenuTrigger>
      <ContextMenuContent data-testid="send-menu" className="[&_svg]:size-icon-row">
        {busy ? (
          DELIVERIES.map((delivery) => (
            <ContextMenuItem
              key={delivery}
              disabled={!canSend || (delivery !== "queue" && !steerable)}
              onClick={() => deliver(delivery)}
            >
              <DeliveryGlyph action={delivery} />
              {DELIVERY_WORDS[delivery]}
              <kbd className="ml-auto pl-3 font-mono text-caption text-muted-foreground">
                {deliveryKeys[delivery]}
              </kbd>
            </ContextMenuItem>
          ))
        ) : (
          <ContextMenuItem disabled={!canSend} onClick={() => void send()}>
            <ArrowUp aria-hidden />
            Send
            <kbd className="ml-auto pl-3 font-mono text-caption text-muted-foreground">
              {sendKeyHint}
            </kbd>
          </ContextMenuItem>
        )}
        <ContextMenuItem disabled={!canSend} onClick={() => void send(true)}>
          <SquarePen aria-hidden />
          Send and start a new draft
          <kbd className="ml-auto pl-3 font-mono text-caption text-muted-foreground">
            {newDraftHint}
          </kbd>
        </ContextMenuItem>
        {(busy || background) && (
          <ContextMenuItem onClick={() => void stopTurn(api, threadId)}>
            <Square aria-hidden className="fill-current" />
            {stopLabel}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );

  const onModel = (value: string) => {
    if (!model) return;
    if (value.startsWith(SWITCH_PREFIX)) {
      const chosen = value.slice(SWITCH_PREFIX.length);
      useThreadDialogs
        .getState()
        .open({ kind: "continueIn", threadId, ...(chosen === "" ? {} : { model: chosen }) });
      return;
    }
    const { variant: current, ...rest } = model;
    const variant = effortAfterSwitch(models, value, current);
    void api
      .setModel(threadId, {
        ...rest,
        model: value,
        ...(variant === undefined ? {} : { variant }),
        ...(model.speed === "fast" && !modelSpeeds(models, value).includes("fast")
          ? { speed: "standard" as const }
          : {}),
      })
      .catch((error: unknown) => flash(errorMessage(error)));
  };
  const confirmPick = (label: string, options: readonly PickerOption<string>[], value: string) => {
    const option = options.find((o) => o.value === value);
    flash(`${label} set to ${option?.short ?? option?.label ?? value}`);
  };
  const onEffort = (next: string) => {
    if (!model || next === (model.variant ?? DEFAULT_EFFORT)) return;
    const { variant: _variant, ...rest } = model;
    const variant = pickedVariant(next);
    void api
      .setModel(threadId, variant === undefined ? rest : { ...rest, variant })
      .then(() => confirmPick("Effort", effortChoices, next))
      .catch((error: unknown) => flash(errorMessage(error)));
  };
  const onSpeed = (speed: SpeedMode) => {
    if (!model || speed === model.speed) return;
    void api
      .setModel(threadId, { ...model, speed })
      .then(() => flash(`Speed set to ${speed === "fast" ? "Fast" : "Standard"}`))
      .catch((error: unknown) => flash(errorMessage(error)));
  };
  const onMode = (mode: PermissionMode) => {
    if (mode === summary?.thread.mode) return;
    void api
      .setMode(threadId, mode)
      .then(() => confirmPick("Mode", MODE_OPTIONS, mode))
      .catch((error: unknown) => flash(`Couldn't switch mode: ${errorMessage(error)}`));
  };
  const choices: ChoiceSection[] = [
    modelSection({
      value: pickedModel,
      options: otherChoices.length === 0 ? modelChoices : [...modelChoices, ...otherChoices],
      onChange: onModel,
      warning: modelWarning,
      shortcut: { id: "composer.model", keys: "mod+shift+m" },
      search: model && {
        rowIcon: <AgentIcon agent={model.agent} className="size-icon-row" />,
        favourite: isFavourite,
        onToggleFavourite: (value) => useModelFavourites.getState().toggle(model.agent, value),
        heads,
      },
    }),
    effortSection({
      efforts,
      value: model?.variant,
      onChange: onEffort,
      shortcut: { id: "composer.effort", keys: "mod+shift+e" },
    }),
    modeSection({
      value: summary?.thread.mode,
      onChange: onMode,
      shortcut: { id: "composer.mode", keys: "mod+shift+a" },
    }),
    speedSection({
      agent: model?.agent ?? "claude",
      models,
      model: model?.model ?? "",
      value: model?.speed,
      state: summary?.thread.speedState ?? { speed: "unknown" },
      onChange: onSpeed,
    }),
  ];

  return (
    <div
      className="shrink-0 bg-thread px-3 pt-1 pb-3"
      onKeyDownCapture={dictation.onKeyDownCapture}
    >
      <SharedSlab
        ref={surfaceRef}
        from={handoff}
        onArrived={() => useSlabHandoff.getState().done()}
        data-surface="composer"
        data-dragging={dragging ? "true" : undefined}
        className={cn(SLAB, "group/composer @container/composer thread-column")}
        onDragOver={(event) => event.preventDefault()}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {(running || background) && <RunningEdge moving={focused} />}
        {menuOpen &&
          (verbs.length > 0 ? (
            <VerbMenu id={menuId} verbs={verbs} activeIndex={activeIndex} onChoose={chooseVerb} />
          ) : (
            <SlashMenu
              id={menuId}
              commands={commands}
              activeIndex={activeIndex}
              onChoose={choose}
            />
          ))}
        {slashNote !== undefined && !mentions.open && <SlashNote note={slashNote} />}
        {mentions.open && (
          <MentionMenu
            id={mentions.id}
            entries={mentions.entries}
            activeIndex={mentions.activeIndex}
            onChoose={mentions.choose}
          />
        )}
        <DiffCommentChips threadId={threadId} className="px-3 pt-3" />
        <PagePickChips threadId={threadId} className="px-3 pt-3" />
        <AttachmentChips
          items={attachments.items}
          onRemove={attachments.remove}
          className="px-3 pt-3"
        />
        <div className="relative">
          {partialInline && (
            <DictationMirror ref={mirrorRef} text={text} partial={dictation.partial} />
          )}
          {ghost !== undefined && (
            <div ref={mirrorRef} aria-hidden data-composer-mirror className={GHOST_MIRROR}>
              <span data-testid="composer-ghost">
                <span className="text-transparent">{text}</span>
                <span className="text-subtle">{ghost.rest}</span>
              </span>
              <GhostHint position={ghost.position} count={ghost.count} hidden={hintPinned} />
            </div>
          )}
          {ghost !== undefined && hintPinned && (
            <div className="pointer-events-none absolute right-2 bottom-1 rounded-sm bg-card px-1">
              <GhostHint position={ghost.position} count={ghost.count} />
            </div>
          )}
          {ghost !== undefined && (
            <span id={`suggestion-${threadId}`} className="sr-only">
              Suggested reply: {ghost.suggestion}. Right Arrow accepts.
            </span>
          )}
          <textarea
            {...mentions.textareaProps}
            aria-label="Message"
            aria-describedby={ghost === undefined ? undefined : `suggestion-${threadId}`}
            role="combobox"
            aria-expanded={listOpen}
            aria-controls={listOpen ? listId : undefined}
            aria-activedescendant={listOpen ? `${listId}-${listActiveIndex}` : undefined}
            aria-autocomplete="list"
            value={text}
            placeholder={
              ghost !== undefined || dictation.active
                ? ""
                : (placeholder ??
                  `${placeholderLead({ toWorker, busy, steerable, picked })}…${
                    phone ? "" : " (/ for commands, @ for files)"
                  }`)
            }
            className={cn(SLAB_TEXTAREA, "relative")}
            onFocus={(event) => {
              mentions.textareaProps.onFocus();
              setFieldFocused(true);
              trackCaret(event.currentTarget);
              dictation.prewarm();
            }}
            onBlur={() => {
              mentions.textareaProps.onBlur();
              setFieldFocused(false);
            }}
            onSelect={(event) => {
              mentions.textareaProps.onSelect(event);
              trackCaret(event.currentTarget);
            }}
            onScroll={(event) => {
              if (mirrorRef.current) mirrorRef.current.scrollTop = event.currentTarget.scrollTop;
            }}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onChange={(event) => {
              setText(event.target.value);
              typing();
              dictation.typed();
              trackCaret(event.target);
              if (!inserting.current && suggestions?.chosen !== undefined) {
                useSuggestionsStore.getState().choose(threadId, undefined);
              }
              history.reset();
              setSlashIndex(0);
              if (event.target.value === "") setSlashDismissed(false);
              mentions.onChange(event.target.value, event.target.selectionStart);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
        </div>
        {dictation.partial !== "" && (!caretAtEnd || (partialInline && hintPinned)) && (
          <DictationStrip partial={dictation.partial} />
        )}
        <DictationError state={dictation.state} />
        <div
          data-testid="composer-toolbar"
          className="flex flex-nowrap items-center gap-1 px-2 pb-2"
        >
          <ComposerChoices
            sections={choices}
            mark={model && <AgentIcon agent={model.agent} className="size-icon-bar" />}
            agentLabel={model && agentLabel(model.agent)}
            focused={focused}
            onOpen={refreshModels}
            onAsked={onModelAsked}
          />
          <div className="flex shrink-0 empty:hidden">
            <StashMenu
              threadId={threadId}
              onRestore={(saved) => void restore(saved)}
              onError={flash}
              keep={attachments.keep}
            />
          </div>
          <span
            aria-live="polite"
            className="min-w-0 flex-1 truncate px-1 text-meta text-muted-foreground"
          >
            {hint ?? (dictation.active ? dictationStatus(dictation.state) : undefined)}
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            {dictation.available && (
              <DictationButton
                state={dictation.state}
                hint={dictateHint}
                level={dictation.level}
                onToggle={dictation.toggle}
              />
            )}
            <PendingRestart threadId={threadId} />
            <ContextRing threadId={threadId} countUp={focused} />
            {busy &&
              withSendMenu(
                <DeliveryButton
                  mode={way}
                  hasDraft={hasDraft}
                  canSend={canSend}
                  label={actionLabels[way]}
                  steerable={steerable}
                  lines={deliveryLines}
                  keys={deliveryKeys}
                  focusAfter={fieldRef}
                  onPick={setPicked}
                  onClick={runDelivery}
                />,
              )}
            {roundAction === "send" ? (
              withSendMenu(
                <PressScale hover={canSend ? 1.05 : undefined}>
                  <Hint
                    label={actionLabels[action === "stop" ? "send" : action].hint}
                    render={
                      <button
                        type="button"
                        aria-label={actionLabels[action === "stop" ? "send" : action].aria}
                        disabled={!canSend}
                        className={cn(ROUND, SEND_FILL)}
                        onClick={runAction}
                      />
                    }
                  >
                    <Swap swapKey={action}>
                      <SendGlyph action={action === "stop" ? "send" : action} />
                    </Swap>
                  </Hint>
                </PressScale>,
              )
            ) : (
              <PressScale className="phone:ml-3">
                <Hint
                  label={actionLabels.stop.hint}
                  render={
                    <button
                      type="button"
                      aria-label={actionLabels.stop.aria}
                      data-waiting={waitingOnYou ? "" : undefined}
                      className={cn(ROUND, waitingOnYou ? STOP_QUIET : STOP_FILL)}
                      onClick={(event) => {
                        if (event.detail > 1) return;
                        void stopTurn(api, threadId);
                      }}
                    />
                  }
                >
                  <span aria-hidden className="relative grid size-4 place-items-center">
                    {!waitingOnYou && (
                      <RingSpinner
                        data-testid="stop-ring"
                        className="pointer-events-none absolute inset-0 size-4"
                      />
                    )}
                    <Square className="size-2 fill-current" />
                  </span>
                </Hint>
              </PressScale>
            )}
          </div>
        </div>
      </SharedSlab>
    </div>
  );
}

function SendGlyph({ action }: { action: Exclude<SendAction, "stop"> }) {
  return action === "send" ? (
    <ArrowUp aria-hidden className="size-icon-row" />
  ) : (
    <DeliveryGlyph action={action} />
  );
}

const DELIVERIES = ["steer", "queue", "interrupt"] as const;
type Delivery = (typeof DELIVERIES)[number];

const DELIVERY_WORDS: Record<Delivery, string> = {
  steer: "Steer",
  queue: "Queue",
  interrupt: "Interrupt",
};

const lowerFirst = (line: string) => line.replace(/^./, (c) => c.toLowerCase());

function DeliveryGlyph({ action }: { action: Delivery }) {
  switch (action) {
    case "steer":
      return <Send aria-hidden className="size-icon-row" />;
    case "queue":
      return <ListPlus aria-hidden className="size-icon-row" />;
    case "interrupt":
      return <SquareArrowRight aria-hidden className="size-icon-row" />;
  }
}

const DELIVERY_ITEM =
  "flex cursor-default items-center gap-2.5 rounded-sm px-2 py-1.5 text-body outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:row-cursor phone:min-h-11";

function DeliveryButton({
  mode,
  hasDraft,
  canSend,
  label,
  steerable,
  lines,
  keys,
  focusAfter,
  onPick,
  onClick,
}: {
  mode: Delivery;
  hasDraft: boolean;
  canSend: boolean;
  label: { aria: string; hint: string };
  steerable: boolean;
  lines: Record<Delivery, string>;
  keys: Record<Delivery, string>;
  focusAfter: RefObject<HTMLTextAreaElement | null>;
  onPick: (delivery: Delivery) => void;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const word = DELIVERY_WORDS[mode];
  const filled = hasDraft && canSend;
  const chevron = useRef<HTMLButtonElement>(null);
  const part = cn(
    "inline-flex h-full items-center outline-none select-none focus-visible:focus-ring disabled:cursor-default",
    PHONE_HIT,
    filled ? "hover:bg-primary-foreground/12" : "hover:bg-accent",
  );
  return (
    <div
      data-testid="delivery-button"
      data-mode={mode}
      data-filled={filled ? "" : undefined}
      className={cn(
        "inline-flex h-8 shrink-0 items-stretch rounded-full border text-meta font-medium transition-[background-color,color,border-color] phone:h-11",
        filled
          ? "border-transparent bg-primary text-primary-foreground shadow-raised shadow-primary/24"
          : "border-edge text-foreground",
      )}
    >
      <Hint
        label={hasDraft ? label.hint : `${label.hint}. Type a message first`}
        render={
          <button
            type="button"
            aria-label={label.aria}
            disabled={hasDraft && !canSend}
            className={cn(part, "gap-1.5 rounded-l-full pr-1.5 pl-2.5 phone:min-w-11")}
            onClick={onClick}
          />
        }
      >
        <Swap swapKey={mode}>
          <DeliveryGlyph action={mode} />
        </Swap>
        <span data-testid="delivery-word" className="@max-[20rem]/composer:sr-only">
          {word}
        </span>
      </Hint>
      <span
        aria-hidden
        className={cn("my-1.5 w-px", filled ? "bg-primary-foreground/30" : "bg-edge")}
      />
      <Menu.Root>
        <Hint
          label="Steer, Queue or Interrupt"
          render={
            <Menu.Trigger
              ref={chevron}
              data-testid="delivery-menu"
              data-picked={mode}
              aria-label={`${word}. Steer, queue or interrupt`}
              className={cn(
                part,
                "rounded-r-full pr-2 pl-1 phone:min-w-11 phone:justify-center",
                !filled && "text-muted-foreground",
              )}
            />
          }
        >
          <ChevronDown aria-hidden className="size-icon-chip" />
        </Hint>
        <Menu.Portal>
          <Menu.Positioner
            side="top"
            align="end"
            sideOffset={4}
            anchor={() => aboveComposer(chevron.current)}
            className="isolate z-50 outline-none"
          >
            <Menu.Popup
              finalFocus={() => focusAfter.current ?? true}
              className="max-w-[calc(100vw-1rem)] min-w-72 rounded-md border border-edge bg-popover p-1 text-popover-foreground shadow-overlay outline-none"
            >
              <Menu.RadioGroup
                value={mode}
                onValueChange={(value) => {
                  const picked = DELIVERIES.find((delivery) => delivery === value);
                  if (picked !== undefined) onPick(picked);
                }}
              >
                {DELIVERIES.map((delivery) => (
                  <Menu.RadioItem
                    key={delivery}
                    value={delivery}
                    closeOnClick
                    disabled={delivery !== "queue" && !steerable}
                    data-testid={`delivery-${delivery}`}
                    className={cn(DELIVERY_ITEM, "data-[checked]:bg-accent")}
                  >
                    <DeliveryGlyph action={delivery} />
                    <span className="min-w-0 flex-1">
                      <span className="block">{DELIVERY_WORDS[delivery]}</span>
                      <span className="block text-meta text-muted-foreground">
                        {lines[delivery]}
                      </span>
                    </span>
                    {(delivery === "queue" || steerable) && (
                      <kbd className="pl-3 font-mono text-caption text-muted-foreground phone:hidden">
                        {keys[delivery]}
                      </kbd>
                    )}
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}

function placeholderLead({
  toWorker,
  busy,
  steerable,
  picked,
}: {
  toWorker: boolean;
  busy: boolean;
  steerable: boolean;
  picked: Delivery;
}): string {
  const worker = toWorker ? " this worker" : "";
  if (steerable) {
    switch (picked) {
      case "steer":
        return toWorker ? "Steer this worker" : "Steer the agent";
      case "queue":
        return `Queue a message for${worker || " after this turn"}`;
      case "interrupt":
        return toWorker ? "Interrupt this worker" : "Interrupt with a message";
    }
  }
  if (busy) return toWorker ? "Queue a message for this worker" : "Queue a message";
  return toWorker ? "Message this worker" : "Message";
}

function GhostHint({
  position,
  count,
  hidden = false,
}: {
  position: number;
  count: number;
  hidden?: boolean;
}) {
  const accept = useShortcutHint("composer.acceptSuggestion");
  const next = useShortcutHint("composer.nextSuggestion");
  return (
    <span
      aria-hidden
      data-testid={hidden ? undefined : "suggestion-hint"}
      className={cn(
        "text-caption text-muted-foreground *:ms-2 *:inline-block *:whitespace-nowrap",
        hidden && "invisible",
      )}
    >
      {accept && (
        <span>
          <kbd className={KBD}>{accept}</kbd> accept
        </span>
      )}
      {count > 1 && (
        <span className="tabular-nums">
          {next && <kbd className={KBD}>{next}</kbd>} {position + 1}/{count}
        </span>
      )}
      <kbd className={KBD}>esc</kbd>
    </span>
  );
}

const KBD = "rounded-sm border border-border px-1 font-mono text-caption";
