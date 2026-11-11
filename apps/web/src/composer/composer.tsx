import {
  modelSpeeds,
  type SpeedMode,
  effectiveCheckout,
  helperOn,
  sendKeyOf,
  type DraftStash,
  type PermissionMode,
  type ReasoningVariant,
  type StashId,
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
} from "react";

import { AgentIcon, agentLabel } from "@/agents/agent-display";
import { RECONNECT_WAIT_MS, whenReconnected } from "@/api/connection";
import { useApi } from "@/api/context";
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
import { useDraftStore } from "@/stores/drafts";
import { useSuggestionsStore } from "@/stores/suggestions";
import { useThreadsStore } from "@/stores/threads";
import { continueHint, SWITCH_PREFIX } from "@/thread/agent-switch-model";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";
import { useSwitchOffer } from "@/thread/use-switch-offer";

import { AttachmentChips } from "./attachment-chips";
import { ContextRing } from "./context-ring";
import { onModelPickerAsked } from "./model-picker-request";
import { PendingRestart } from "./pending-restart";
import { DiffCommentChips } from "./diff-comment-chips";
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
  unlistedWarning,
  useModels,
  useModelsSettled,
  useProviderLabel,
  useRefreshModels,
} from "./models";
import { effortSection, modelSection, modeSection, speedSection } from "./choice-sections";
import { ComposerChoices, type ChoiceSection } from "./choices";
import { DEFAULT_EFFORT, DEFAULT_EFFORT_OPTION, MODE_OPTIONS } from "./options";
import type { PickerOption } from "./picker";
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
/** A turn held at the user's answer: nothing runs, and the card's answer is the step to take. */
const WAITING_ON_YOU: ReadonlySet<ThreadStatus> = new Set(["needsApproval", "needsInput"]);
const HINT_MS = 2500;
/**
 * The threads with a send or steer waiting for the connection, across every composer: a thread's
 * pane is remounted when the user leaves and comes back, and a second press there must not queue a
 * second send of the same draft beside the first mount's.
 */
const waitingThreads = new Set<string>();
/**
 * What a message into a worker the orchestrator directs also does, in one plain wording: Send's
 * name and tooltip ("Send and take over from the orchestrator") and, while a draft waits, the line
 * beside Send say it; the placeholder only names where the message goes ("Message this worker…"),
 * so the field never reads as a warning.
 */
const TAKES_OVER_LINE = "Sending takes over from the orchestrator";
/** Shown while a send waits for the connection to come back. */
const RECONNECT_HINT = "Waiting for the connection — sends once it's back";

export function Composer({
  threadId,
  focused,
  placeholder,
  takesControl = false,
}: {
  threadId: ThreadId;
  focused: boolean;
  /** In place of "Message…", e.g. beside the chat, where it steers a worker. */
  placeholder?: string | undefined;
  /**
   * A message sent here takes the thread over from its orchestrator (a worker it still directs):
   * the placeholder, Send's name and the line beside it say so before the message goes.
   */
  takesControl?: boolean;
}) {
  const api = useApi();
  const typing = useTypingPresence();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const surfaceRef = useRef<HTMLDivElement>(null);
  // The thread `/new` just created: its composer moves in from where the hero's prompt box was.
  const handoff = useSlabHandoff((s) => (s.threadId === threadId ? s.from : undefined));
  const summary = useThreadsStore((s) => s.byId[threadId]);
  const identity = useThreadsStore((s) => s.byId[threadId]?.identity);

  const text = useDraftStore((s) => s.text[threadId] ?? "");
  const editing = useDraftStore((s) => s.edits[threadId]);
  const setText = (value: string) => useDraftStore.getState().setText(threadId, value);
  const attachments = useAttachments({ threadId });
  const diffComments = useDiffComments(threadId);
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
  // Unknown until settings load, and Enter doesn't send till then: assuming the default would post
  // the first line of someone who chose "Shortcut only" and started typing at once.
  const sendKey = useServerSettings((s) => (s.settings ? sendKeyOf(s.settings) : undefined));
  // The turn is over but a background subagent is still working. To the user that is the agent
  // running, so Stop stays: between turns it stops those subagents, which an interrupt can't reach.
  const background = useThreadsStore((s) =>
    backgroundWorking(status, activityLine(status, s.statusDetail[threadId], summary?.activity)),
  );
  const busy = BUSY.has(status);
  // Stop steps back while the turn only waits on an answer; a background agent still works.
  const waitingOnYou = WAITING_ON_YOU.has(status) && !background;
  // A turn whose folder is gone is being stopped: the server's steer would hand the message to an
  // agent that can't run there, while its send refuses and says why, so the send key sends.
  const steerable =
    running && summary?.capabilities?.steer === true && !worktreeMissing(summary.git);
  // Codex can't stop its turn for a message: there an interrupt goes in as a steer.
  const interruptible = steerable && summary?.capabilities?.steerInterrupt === true;
  // Some tests render a thread with no model.
  const agent = summary?.thread.model?.agent ?? "claude";
  const canFork = summary?.capabilities?.fork === true;
  const reported = identity?.commands;
  const available = useMemo(
    () => menuCommands(agent, reported ?? [], canFork),
    [agent, reported, canFork],
  );
  const query = slashDismissed ? undefined : slashQuery(text);
  // In the Orchestrator layout the orchestrator's `/` opens its verbs first; a name none of them
  // starts falls through to the agent's commands and Gram's, as everywhere else.
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
    (text.trim() !== "" || attachments.ready.length > 0 || diffComments.length > 0);

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
  // Settings → AI helpers can switch them off, which hides what's already here too.
  const suggestOn = useServerSettings(
    (s) => s.settings !== undefined && helperOn(s.settings, "suggest"),
  );
  const suggestions = useSuggestionsStore((s) => (suggestOn ? s.byThread[threadId] : undefined));
  const attended = useWindowAttended();
  const [fieldFocused, setFieldFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [caretAtEnd, trackCaret] = useCaretAtEnd();
  /** An insertion of ours, which `onChange` mustn't treat as the user editing. */
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
  /** What the last whole acceptance left in the box, to tell whether it was edited before sending. */
  const accepted = useRef<{ turnId: string; text: string } | undefined>(undefined);
  const record = (event: SuggestEvent) =>
    void api
      .recordHelperEvent({ kind: "suggest", event })
      .catch((error: unknown) => console.warn("suggestions", error));

  const shown = ghost !== undefined;
  // The reply and its keys sit in a mirror laid over the field, which sizes from the draft alone: a
  // reply longer than the empty field would hide its keys again, so the field grows to hold it, but
  // never past its own cap, which keeps the transcript's share of a short pane. A reply that still
  // doesn't fit pins the keys to the field's corner instead. Measured afresh each time, the field
  // back at its own height first, so a shorter reply shrinks it.
  // Dictated words not yet committed sit in the same mirror, and the field grows to hold them too.
  const partialInline = ghost === undefined && dictation.partial !== "" && caretAtEnd;
  const ghostRest = ghost?.rest ?? (partialInline ? dictation.partial : undefined);
  const ghostPosition = ghost?.position;
  const hintPinned = useMirrorFit(fieldRef, mirrorRef, ghostRest, ghostPosition, text);
  useEffect(() => {
    if (shown && useSuggestionsStore.getState().count(threadId)) record("shown");
    // `record` is recreated every render and only reads `api`.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, threadId]);

  // Turns started in this thread since the composer mounted: an answer asked for before the latest
  // one started belongs to a turn that's over, even if that one has ended too by now.
  const turns = useRef(0);
  useEffect(
    () =>
      useThreadsStore.subscribe((s, previous) => {
        const now = s.byId[threadId]?.status;
        const before = previous.byId[threadId]?.status;
        if (now !== undefined && RUNNING.has(now) && (before === undefined || !RUNNING.has(before)))
          turns.current += 1;
      }),
    [threadId],
  );

  // A thread opened idle without suggestions for its last turn asks for them, once per turn, and
  // only in front of the user: a pane focused in a window behind another app isn't watched.
  const looking = focused && attended;
  const lastActivityAt = summary?.thread.lastActivityAt;
  const askedFor = useRef<string | undefined>(undefined);
  // A snapshot after a reconnect drops what was held, and so asks again even with no new activity.
  const generation = useSuggestionsStore((s) => s.generation);
  useEffect(() => {
    // Taken back for an edited plan, they're asked for again, once each time.
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

  /** Types `insert` after what's there, as the user would have, so ⌘Z undoes it. Never sends. */
  const acceptSuggestion = (current: Ghost, insert: string, whole: boolean) => {
    const field = fieldRef.current;
    if (field === null || suggestions === undefined) return;
    // Taking a word keeps to the suggestion it came from, though what's typed may now fit others.
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
    // An in-flight action can finish after its composer has gone.
    if (!hintMounted.current) return;
    clearTimeout(hintTimer.current);
    setHint(message);
    hintTimer.current = setTimeout(() => setHint(undefined), HINT_MS);
  };

  /** The message to send, and how to give its draft back if it doesn't go. */
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
        (useDiffCommentsStore.getState().byThread[threadId]?.length ?? 0) === 0)
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
    const input: UserInput = {
      text: withDiffComments(reviewed, typed),
      ...(files.ready.length > 0 ? { attachments: files.ready } : {}),
    };
    history.push(typed);
    setText("");
    // Whatever was sent answered them. Only a starting turn clears them, and a queued message
    // starts none, so they came back into the emptied box and → ↵ sent the same reply again.
    useSuggestionsStore.getState().dismiss(threadId);
    attachments.clear();
    setSlashDismissed(false);
    mentions.reset();
    const giveBack = () => {
      if (!files.restore()) return;
      // Whatever was typed while the message was in flight stays, after the one given back.
      const since = (useDraftStore.getState().text[threadId] ?? "").trim();
      setText([typed, since].filter(Boolean).join("\n\n"));
      useDiffCommentsStore.getState().restore(threadId, reviewed);
    };
    return {
      input,
      giveBack,
      release: files.release,
      active: () => files.active,
    };
  };

  /** Ends that wait when the composer goes, as switching threads unmounts it. */
  const waitAborts = useRef(new Set<AbortController>());
  useEffect(() => {
    const aborts = waitAborts.current;
    return () => {
      for (const abort of aborts) abort.abort();
    };
  }, []);
  /** The draft as it is now, for a send that waited to see whether it is still the one pressed. */
  // Every chip, uploading ones too: `ready` leaves those out, and one pasted while the send waited
  // would be dropped by the send and its chip cleared.
  const latestDraft = useRef({ text, items: attachments.items });
  useEffect(() => {
    latestDraft.current = { text, items: attachments.items };
  });
  /**
   * Waits for a dropped connection, up to two minutes, with the message still in the box, so a
   * reload meanwhile keeps it; said until it is back, never a silent spin.
   * `false` when it didn't come back, the composer went, or the draft (its text or attachments)
   * changed meanwhile: the action would send what was pressed, so the user sends what is there.
   */
  const connected = async (): Promise<boolean> => {
    if (!attachments.active) return false;
    if (api.connection.get().status !== "reconnecting") return true;
    if (waitingThreads.has(threadId)) {
      // Untimed, as the first press's: the wait still under way clears it when it ends.
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
    if (!(await connected())) return;
    const taken = take();
    if (!taken) return;
    const { input, giveBack, release, active } = taken;
    try {
      if (editing) {
        await api.rewind(threadId, editing.messageId, editing.files);
        if (!active()) return;
        useDraftStore.getState().cancelEdit(threadId);
      }
      const result = await api.send(threadId, input);
      if (!active()) return;
      if (result.queued) flash("Queued — sends when the turn ends");
    } catch (error) {
      // Give the text and diff comments back rather than lose them; a failed rewind keeps the edit.
      giveBack();
      if (active()) flash(`Couldn't send: ${errorMessage(error)}`);
      return;
    } finally {
      release();
    }
    if (newDraft && attachments.active) void navigate({ to: "/new" });
  };

  /** Into the running turn: after its tool calls, or with `interrupt` stopping it now. */
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
            ? "Interrupting…"
            : interrupt
              ? "This agent can't be interrupted for a message, so it was steered in"
              : "Steering…",
        );
      }
    } catch (error) {
      // The turn can end between the click and the call, so give the message back rather than lose it.
      giveBack();
      if (active()) flash(`Couldn't steer: ${errorMessage(error)}`);
    } finally {
      release();
    }
  };

  /**
   * Sends the draft as `action` says: at rest a send, into a running turn a steer (after its tool
   * calls, cancelling nothing), a queue (after the turn) or an interrupt (stopping it now).
   */
  const deliver = (action: Exclude<SendAction, "stop">) => {
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
  /** What the send key does now: a steer while a turn takes input, else a send or a queue. */
  const sendNow = () => {
    const action = sendAction({ hasDraft: true, busy, background, steerable, held: undefined });
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

  /** Sets the draft aside and clears the composer; `false` when there was nothing to stash. */
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
    // The id travels with the request, so a retried add can't store the draft twice.
    const draft = {
      id: crypto.randomUUID() as StashId,
      text: currentText,
      attachments: files.ready,
    };
    // As a send does: consume the captured draft now, so the next one can be typed independently.
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

  /** Puts a stash back in the composer; a draft already there is stashed first, so none is lost. */
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
      // Only from this composer: not while typing in the terminal, a settings form or elsewhere.
      when: () => surfaceRef.current?.contains(document.activeElement) === true,
      run: () => {
        void stash().then((stashed) => stashed && flash("Draft stashed"));
      },
    },
    focused,
  );

  /** Does what Gram has for `action`, which the box held as `typedText`. */
  const runNative = async (action: NativeAction, args: string, typedText: string) => {
    const failed = (what: string) => (error: unknown) => {
      // As a rejected send does: whatever was typed while it was in flight stays, after it.
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

  /**
   * Answers a command Gram handles, or holds back one its note explains; `false` leaves the
   * draft to be sent as typed.
   */
  const intercept = (): boolean => {
    const typedText = text.trim();
    const resolved = resolveTyped(agent, typedText, reported ?? [], canFork);
    if (resolved.kind === "agent") return false;
    // The note above the box says why; nothing is sent.
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

  /** A verb runs as it is picked: the `/` typed for it goes, as a sent command's does. */
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
    // After the menus, which hide the suggestion while open, and before Send, which sends only what
    // is typed. Each key acts only while a suggestion shows, and the caret is then at the end, where
    // → and ⌥→ do nothing anyway.
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
    // After the slash menu and mentions, whose Enter picks an item. Inside an open code fence Enter
    // is a new line under either setting: nobody sends half a code block on purpose.
    const caret = event.currentTarget.selectionStart;
    const fenced = inOpenFence(event.currentTarget.value.slice(0, caret));
    // The Send shortcut is answered here as well as in the registry, which keeps a binding without
    // ⌘/Ctrl out of fields; here it reaches this text area and no other.
    if (
      (!fenced && enterSends(event.nativeEvent, sendKey)) ||
      shortcutPressed("composer.send", event.nativeEvent)
    ) {
      event.preventDefault();
      return sendNow();
    }
    // ⌥↵ queues for after the turn, under either send key setting; at rest it sends.
    if (shortcutPressed("composer.queue", event.nativeEvent)) {
      event.preventDefault();
      return void send();
    }
    // ⌘. with a draft for a turn that takes input stops the turn for it; bare, the registry's Stop.
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
  // Enter and leave fire for every child the pointer crosses, so the tint follows a depth count.
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
  // Claude's built-in list is no fallback for a gateway agent's models.
  const refreshModels = useRefreshModels(model?.agent ?? "claude", model?.profileId);
  // A rate-limited turn's "Try another model" opens this thread's picker, whichever pane has focus.
  const onModelAsked = useCallback(
    (open: () => void) => onModelPickerAsked(threadId, open),
    [threadId],
  );
  const provider = useProviderLabel(model?.agent ?? "claude", model?.profileId);
  const modelChoices = modelOptions(
    models,
    model?.model ?? summary?.identity?.model,
    model && model.agent !== "claude" ? [] : undefined,
    unlistedWarning(model?.agent ?? "claude", model?.profileId),
    provider,
  );
  const efforts = effortOptions(models, model?.model);
  // The model's own default heads the list, so the current effort always has its check.
  const effortChoices = efforts.length > 0 ? [DEFAULT_EFFORT_OPTION, ...efforts] : [];
  const modelWarning =
    model?.profileId !== undefined
      ? gatewayModelWarning(models, model.model)
      : model?.agent === "claude"
        ? accountModelWarning(models, model.model)
        : undefined;
  const isFavourite = useIsFavourite(model?.agent ?? "claude");
  // The other agent's models, a group of their own below this one's: a pick opens "Continue in
  // Codex" and changes nothing by itself. Only while the other CLI is installed.
  const offer = useSwitchOffer(threadId);
  const otherAgent = offer.offered ? offer.to : undefined;
  const otherModels = useModelsSettled(otherAgent ?? "codex", otherAgent !== undefined).models;
  const otherChoices: PickerOption<string>[] =
    otherAgent === undefined
      ? []
      : (otherModels ?? []).map((m) => ({
          value: `${SWITCH_PREFIX}${m.id}`,
          label: `${m.displayName}…`,
          group: agentLabel(otherAgent),
          icon: <AgentIcon agent={otherAgent} className="size-icon-row" />,
          opens: true,
          disabled: offer.offered && offer.refusal !== undefined,
        }));
  const heads =
    model === undefined || otherAgent === undefined || otherChoices.length === 0
      ? undefined
      : {
          [provider]: {
            mark: <AgentIcon agent={model.agent} className="size-icon-chip" />,
            hint: provider,
          },
          [agentLabel(otherAgent)]: {
            mark: <AgentIcon agent={otherAgent} className="size-icon-chip" />,
            hint: (offer.offered ? offer.refusal : undefined) ?? continueHint(otherAgent),
          },
        };

  // The composer holds something, even if it can't go yet: a draft waiting on an upload isn't Stop.
  const hasDraft = canSend || attachments.uploading;
  const stopLabel = background ? "Stop the background agents" : "Stop";
  const held = useHeldDelivery(steerable && hasDraft);
  const action = sendAction({ hasDraft, busy, background, steerable, held });
  const sendKeyHint = sendKey === "enter" ? "↵" : sendHint;
  const queueLabel = "Queue: sends when the turn ends";
  const deliveryKeys: Record<Delivery, string> = {
    steer: sendKeyHint ?? "",
    queue: queueHint ?? "⌥↵",
    interrupt: stopHint ?? "",
  };
  // Into a worker the orchestrator directs, the send is also a take-over: its name says so.
  const control = takesControl ? " and take over from the orchestrator" : "";
  const queueControl = takesControl ? `. ${TAKES_OVER_LINE}` : "";
  const interruptLine = interruptible
    ? DELIVERY_WORDS.interrupt.line
    : "Interrupt: this agent can't stop for a message, so it steers in";
  const actionLabels = {
    send: {
      aria: `Send${control}`,
      hint: withHint(`Send${control}`, sendKeyHint),
    },
    queue: {
      aria: `Queue${control}`,
      hint: withHint(`${queueLabel}${queueControl}`, steerable ? queueHint : sendKeyHint),
    },
    steer: {
      aria: `Steer${control}`,
      hint: withHint(`${DELIVERY_WORDS.steer.line}${queueControl}`, sendKeyHint),
    },
    interrupt: {
      aria: `Interrupt${control}`,
      hint: withHint(`${interruptLine}${queueControl}`, stopHint),
    },
    // The word and its key, "Stop (⌘.)": an icon button's tooltip names it and its shortcut.
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
      // With a draft for a turn that takes input, the turn stops for it: one step, not stop then send.
      run: () => (hasDraft && steerable ? deliver("interrupt") : void stopTurn(api, threadId)),
    },
    focused && (busy || background),
  );
  const runAction = (event: MouseEvent<HTMLButtonElement>) => {
    const clicked = sendAction({
      hasDraft,
      busy,
      background,
      steerable,
      held: clickDelivery(event),
    });
    if (clicked !== "stop") return deliver(clicked);
    // The second click of a double click on Send lands here once the composer has emptied.
    if (event.detail > 1) return;
    return void stopTurn(api, threadId);
  };

  const onModel = (value: string) => {
    if (!model) return;
    if (value.startsWith(SWITCH_PREFIX)) {
      useThreadDialogs.getState().open({
        kind: "continueIn",
        threadId,
        model: value.slice(SWITCH_PREFIX.length),
      });
      return;
    }
    const { variant: current, ...rest } = model;
    const variant = effortAfterSwitch(models, value, current);
    // The server's refusal is the whole message: for a worker it names the charter's list, and for
    // a gated Codex thread the gateway profile it lacks.
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
  /** Says a pick took, in words beside the glyph that changed: "Effort set to Extra high". */
  const confirmPick = (label: string, options: readonly PickerOption<string>[], value: string) => {
    const option = options.find((o) => o.value === value);
    flash(`${label} set to ${option?.short ?? option?.label ?? value}`);
  };
  const onEffort = (next: string) => {
    if (!model || next === (model.variant ?? DEFAULT_EFFORT)) return;
    const { variant: _variant, ...rest } = model;
    void api
      .setModel(
        threadId,
        next === DEFAULT_EFFORT ? rest : { ...rest, variant: next as ReasoningVariant },
      )
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
  // One chip in every composer, the orchestrator's chat, a solo thread's and `/new` alike, and one
  // popover with a section for each of model · effort · mode · speed. The chip says the values
  // that aren't at their defaults in short words ("Opus · High · Auto"); short of room, in
  // compact ones, then the model's alone, and only at the narrowest the agent's mark. Its name and
  // tooltip say every value and its shortcut, and a dimension that doesn't apply is greyed in its
  // section, saying why.
  const choices: ChoiceSection[] = [
    modelSection({
      value: model?.model,
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
      // Escape discards what dictation heard from anywhere in the composer, the mic button included.
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
              {/* Right after the reply rather than in the toolbar, which a narrow pane leaves no
                  room in: there the keys were cut to a sliver, and the reply read as a draft. */}
              {/* Kept in the flow while pinned, only hidden, so every measure counts its lines. */}
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
            // Dictation's partial is drawn behind the field from its first character, where the
            // placeholder sits; cleared from the start, so the first words don't land on it.
            placeholder={
              ghost !== undefined || dictation.active
                ? ""
                : (placeholder ??
                  // A phone's line holds the words alone: no keys to hint at on a touch keyboard.
                  `${
                    takesControl
                      ? running
                        ? "Queue a message for this worker"
                        : "Message this worker"
                      : running
                        ? "Queue a message"
                        : "Message"
                  }…${phone ? "" : " (/ for commands, @ for files)"}`)
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
              // What the user types picks the first suggestion it fits, not the one cycled to before.
              if (!inserting.current && suggestions?.chosen !== undefined) {
                useSuggestionsStore.getState().choose(threadId, undefined);
              }
              // Editing ends ↑/↓ navigation, so the next ↑ starts from the newest prompt again rather
              // than staying stuck past the oldest.
              history.reset();
              setSlashIndex(0);
              if (event.target.value === "") setSlashDismissed(false);
              mentions.onChange(event.target.value, event.target.selectionStart);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
        </div>
        {/* With the caret mid-draft the words can't show where they'll land, so they wait here; and
            here too once they run past the field's cap, where the mirror behind it can't scroll. */}
        {/* With the caret mid-draft the words can't show where they'll land, so they wait here; and
            here too once they run past the field's cap. */}
        {dictation.partial !== "" && (!caretAtEnd || (partialInline && hintPinned)) && (
          <DictationStrip partial={dictation.partial} />
        )}
        <DictationError state={dictation.state} />
        {/* The model by name, the rest icons with their words on hover; the name truncates first. */}
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
            {hint ??
              (dictation.active
                ? dictationStatus(dictation.state)
                : takesControl && hasDraft
                  ? TAKES_OVER_LINE
                  : undefined)}
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
            {/* Into a turn that takes input, the chevron opens the three ways in: steer, queue,
                interrupt. The round button steers. */}
            {steerable && hasDraft && (
              <DeliveryMenu
                disabled={!canSend}
                keys={deliveryKeys}
                interruptLine={interruptLine}
                onPick={deliver}
              />
            )}
            {/* One button for what the composer can do now, its word on hover. Right-click for the
                rest: Stop stays reachable there while a draft has the button. */}
            <ContextMenu>
              <ContextMenuTrigger
                data-testid="send-menu-trigger"
                render={<span className="inline-flex" />}
              >
                <PressScale hover={canSend ? 1.05 : undefined}>
                  <Hint
                    label={actionLabels[action].hint}
                    render={
                      <button
                        type="button"
                        aria-label={actionLabels[action].aria}
                        disabled={action !== "stop" && !canSend}
                        data-waiting={action === "stop" && waitingOnYou ? "" : undefined}
                        className={cn(
                          ROUND,
                          action !== "stop" ? SEND_FILL : waitingOnYou ? STOP_QUIET : STOP_FILL,
                        )}
                        onClick={runAction}
                      />
                    }
                  >
                    {action === "stop" ? (
                      // While it runs, the ring turns round the square: the button says the agent
                      // is at work, not only how to end it. Still under Reduced and Off. Its word
                      // and key are in its tooltip, as every icon button's are.
                      <span aria-hidden className="relative grid size-4 place-items-center">
                        {!waitingOnYou && (
                          <RingSpinner
                            data-testid="stop-ring"
                            className="pointer-events-none absolute inset-0 size-4"
                          />
                        )}
                        <Square className="size-2 fill-current" />
                      </span>
                    ) : (
                      <Swap swapKey={action}>
                        <SendGlyph action={action} />
                      </Swap>
                    )}
                  </Hint>
                </PressScale>
              </ContextMenuTrigger>
              <ContextMenuContent data-testid="send-menu" className="[&_svg]:size-icon-row">
                {steerable ? (
                  DELIVERIES.map((delivery) => (
                    <ContextMenuItem
                      key={delivery}
                      disabled={!canSend}
                      onClick={() => deliver(delivery)}
                    >
                      <DeliveryGlyph action={delivery} />
                      {DELIVERY_WORDS[delivery].label}
                      <kbd className="ml-auto pl-3 font-mono text-caption text-muted-foreground">
                        {deliveryKeys[delivery]}
                      </kbd>
                    </ContextMenuItem>
                  ))
                ) : (
                  <ContextMenuItem disabled={!canSend} onClick={() => void send()}>
                    {busy ? <ListPlus aria-hidden /> : <ArrowUp aria-hidden />}
                    {busy ? "Queue" : "Send"}
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
          </div>
        </div>
      </SharedSlab>
    </div>
  );
}

/** Send, Queue, Steer and Interrupt's glyph; the button's own label says it in words, on hover. */
function SendGlyph({ action }: { action: Exclude<SendAction, "stop"> }) {
  return action === "send" ? (
    <ArrowUp aria-hidden className="size-icon-row" />
  ) : (
    <DeliveryGlyph action={action} />
  );
}

/** The three ways into a running turn, in the order the delivery menu lists them. */
const DELIVERIES = ["steer", "queue", "interrupt"] as const;
type Delivery = (typeof DELIVERIES)[number];

/** Each way's word and what it does, as the delivery menu and the button's hint say them. */
const DELIVERY_WORDS: Record<Delivery, { label: string; line: string }> = {
  steer: { label: "Steer", line: "Steer: after the current tool call, cancelling nothing" },
  queue: { label: "Queue", line: "Queue: after the turn ends" },
  interrupt: { label: "Interrupt", line: "Interrupt: stops the turn now, cutting off tool calls" },
};

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

/**
 * The chevron before the round button while a turn takes input: Steer, Queue and Interrupt, each
 * with its key and what it does. Its own 44 px target on a phone, where no key is held.
 */
function DeliveryMenu({
  disabled,
  keys,
  interruptLine,
  onPick,
}: {
  disabled: boolean;
  keys: Record<Delivery, string>;
  interruptLine: string;
  onPick: (delivery: Delivery) => void;
}) {
  const lines: Record<Delivery, string> = {
    steer: "After the current tool call",
    queue: "After the turn ends",
    interrupt: interruptLine.replace(/^Interrupt: /, "").replace(/^./, (c) => c.toUpperCase()),
  };
  return (
    <Menu.Root>
      <Hint
        label="Steer, queue or interrupt"
        render={
          <Menu.Trigger
            data-testid="delivery-menu"
            aria-label="Steer, queue or interrupt"
            disabled={disabled}
            className={cn(
              "grid h-8 w-5 shrink-0 place-items-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:focus-ring disabled:opacity-50 data-[popup-open]:text-foreground phone:size-11",
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
          sideOffset={6}
          className="isolate z-50 outline-none"
        >
          <Menu.Popup className="min-w-64 max-w-[calc(100vw-1rem)] rounded-md border border-edge bg-popover p-1 text-popover-foreground shadow-overlay outline-none">
            {DELIVERIES.map((delivery) => (
              <Menu.Item
                key={delivery}
                data-testid={`delivery-${delivery}`}
                onClick={() => onPick(delivery)}
                className={DELIVERY_ITEM}
              >
                <DeliveryGlyph action={delivery} />
                <span className="min-w-0 flex-1">
                  <span className="block">{DELIVERY_WORDS[delivery].label}</span>
                  <span className="block text-meta text-muted-foreground">{lines[delivery]}</span>
                </span>
                <kbd className="pl-3 font-mono text-caption text-muted-foreground phone:hidden">
                  {keys[delivery]}
                </kbd>
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/**
 * What the keys do while a suggestion shows: `→ accept · ⌥↓ 1/3 · esc`, in the keys as bound. Each
 * key stays whole, and a narrow field wraps them onto the lines below the reply.
 */
function GhostHint({
  position,
  count,
  hidden = false,
}: {
  position: number;
  count: number;
  /** Laid out but not shown, holding its lines while the pinned copy shows instead. */
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
