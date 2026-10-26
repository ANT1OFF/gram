import { SpeedField, speedOptions, speedReport, speedUsage } from "./speed-field";
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
import { ArrowUp, Gauge, ListPlus, Send, Square, SquarePen, Zap } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { AgentIcon, agentLabel } from "@/agents/agent-display";
import { RECONNECT_WAIT_MS, whenReconnected } from "@/api/connection";
import { useApi } from "@/api/context";
import { useWindowAttended } from "@/desktop/use-window-attended";
import { errorMessage } from "@/api/errors";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
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
import { PressScale, RunningEdge, SharedSlab, SlotPresence, Swap, useChangeCount } from "@/motion";
import { useServerSettings } from "@/settings-sync/store";
import { activityLine, backgroundWorking } from "@/sidebar/status";
import { useDiffComments, useDiffCommentsStore, withDiffComments } from "@/stores/diff-comments";
import { useDraftStore } from "@/stores/drafts";
import { useSuggestionsStore } from "@/stores/suggestions";
import { useThreadsStore } from "@/stores/threads";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";

import { AttachmentChips } from "./attachment-chips";
import { ContextRing } from "./context-ring";
import { PendingRestart } from "./pending-restart";
import { DiffCommentChips } from "./diff-comment-chips";
import { ghostOf, nextWord, stepped, typeIntoField, type Ghost } from "./ghost";
import { usePromptHistory } from "./history";
import { useAttachments } from "./use-attachments";
import { modeWarning } from "@/thread/mode-warning";
import { STEER_LABEL } from "@/thread/queue-list";

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
  useRefreshModels,
} from "./models";
import { MODE_ICONS, MODE_OPTIONS } from "./options";
import { Picker } from "./picker";
import { inOpenFence } from "./mention";
import { enterSends } from "./send-key";
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
  QUEUE_GLYPH,
  ROUND,
  SEND_FILL,
  SLAB,
  SLAB_TEXTAREA,
  STOP_OUTLINE,
} from "./styles";
import { StashMenu, stashesQueryKey } from "./stash-menu";
import { ToolbarOverflow, type FoldedPicker } from "./toolbar-overflow";
import { useMentions } from "./use-mentions";
import { useToolbarLayout } from "./use-toolbar-layout";
import { useTypingPresence } from "./typing-presence";

const RUNNING: ReadonlySet<ThreadStatus> = new Set(["starting", "running"]);
const BUSY: ReadonlySet<ThreadStatus> = new Set([
  "starting",
  "running",
  "needsApproval",
  "needsInput",
]);
const HINT_MS = 2500;
/**
 * The threads with a send or steer waiting for the connection, across every composer: a thread's
 * pane is remounted when the user leaves and comes back, and a second press there must not queue a
 * second send of the same draft beside the first mount's.
 */
const waitingThreads = new Set<string>();
/** Shown while a send waits for the connection to come back. */
const RECONNECT_HINT = "Waiting for the connection — sends once it's back";

export function Composer({ threadId, focused }: { threadId: ThreadId; focused: boolean }) {
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
  const dragDepth = useRef(0);
  const sendHint = useShortcutHint("composer.send");
  const newDraftHint = useShortcutHint("composer.sendNewDraft");
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [overflowSub, setOverflowSub] = useState<string | undefined>();

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
  const steerable = running && summary?.capabilities?.steer === true;
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
      accepted.current = { turnId: suggestions.turnId, text: current.suggestion };
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
    | { input: UserInput; giveBack: () => void; release: () => void; active: () => boolean }
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
    return { input, giveBack, release: files.release, active: () => files.active };
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

  const steer = async () => {
    if (intercept()) return;
    if (!(await connected())) return;
    const taken = take();
    if (!taken) return;
    const { input, giveBack, release, active } = taken;
    try {
      await api.steer(threadId, input);
      if (active()) flash("Steering…");
    } catch (error) {
      // The turn can end between the click and the call, so give the message back rather than lose it.
      giveBack();
      if (active()) flash(`Couldn't steer: ${errorMessage(error)}`);
    } finally {
      release();
    }
  };

  useShortcut(
    {
      id: "composer.send",
      keys: "mod+enter",
      label: "Send (queues while running)",
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
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
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
      return void send();
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
  const modelChoices = modelOptions(
    models,
    model?.model ?? summary?.identity?.model,
    model && model.agent !== "claude" ? [] : undefined,
    unlistedWarning(model?.agent ?? "claude", model?.profileId),
  );
  const efforts = effortOptions(models, model?.model);
  const modelWarning =
    model?.profileId !== undefined
      ? gatewayModelWarning(models, model.model)
      : model?.agent === "claude"
        ? accountModelWarning(models, model.model)
        : undefined;
  const isFavourite = useIsFavourite(model?.agent ?? "claude");
  // The effort picker only renders when the model has levels; otherwise ⌘⇧E explains why.
  useShortcut(
    {
      id: "composer.effort",
      keys: "mod+shift+e",
      label: "Pick effort",
      group: "Composer",
      run: () => flash("This model has no effort levels"),
    },
    focused && efforts.length === 0,
  );

  const ModeIcon = MODE_ICONS[summary?.thread.mode ?? "default"];
  const sendLabel = busy ? "Queue: sends when the turn ends" : "Send";

  const onModel = (value: string) => {
    if (!model) return;
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
  const onEffort = (next: ReasoningVariant) => {
    if (!model) return;
    void api
      .setModel(threadId, { ...model, variant: next })
      .catch((error: unknown) => flash(errorMessage(error)));
  };
  const onSpeed = (speed: SpeedMode) => {
    if (model)
      void api
        .setModel(threadId, { ...model, speed })
        .catch((error: unknown) => flash(errorMessage(error)));
  };
  const onMode = (mode: PermissionMode) =>
    void api
      .setMode(threadId, mode)
      .catch((error: unknown) => flash(`Couldn't switch mode: ${errorMessage(error)}`));
  const modeIcon = <ModeIcon aria-hidden className="size-3.5" />;
  const effortIcon = <Gauge aria-hidden className="size-3.5" />;

  // Fold order is from the end: the mode picker first, then effort, then Steer. Labels go first.
  const hasEffort = efforts.length > 0;
  // Only when it can act: a turn that takes input mid-turn, and something typed to send into it.
  const showSteer = steerable && canSend;
  // Steer settles in when a draft makes it possible mid-turn, rather than popping in; it only fades
  // and settles in place, since the toolbar measures its blocks' widths to decide what folds.
  const steerArrives = useChangeCount(showSteer) > 0;
  const blocks = useMemo(
    () => [
      { id: "model", foldable: false },
      ...(showSteer ? [{ id: "steer", foldable: true }] : []),
      { id: "speed", foldable: true },
      ...(hasEffort ? [{ id: "effort", foldable: true }] : []),
      { id: "mode", foldable: true },
    ],
    [showSteer, hasEffort],
  );
  const toolbar = useToolbarLayout(blocks);
  const { ref: toolbarRef, labelled, folded } = toolbar;
  const isFolded = (id: string) => folded.includes(id);
  const isLabelled = (id: string) => labelled === "all" || labelled.has(id);
  const openFolded = (id: string) => {
    setOverflowOpen(true);
    setOverflowSub(id);
  };
  const foldedPickers: FoldedPicker[] = [
    ...(model && isFolded("speed")
      ? [
          {
            id: "speed",
            label: "Speed",
            icon: <Zap aria-hidden />,
            value: model.speed ?? "default",
            options: speedOptions(models, model.model, model.speed, summary?.thread.speedState),
            onChange: (value: string) => {
              if (
                value === "standard" ||
                (value === "fast" && modelSpeeds(models, model.model).includes("fast"))
              )
                onSpeed(value);
            },
            description: `${speedUsage(model.agent)} ${speedReport(summary?.thread.speedState)}`,
          },
        ]
      : []),
    ...(isFolded("effort")
      ? [
          {
            id: "effort",
            label: "Effort",
            icon: effortIcon,
            value: model?.variant,
            options: efforts,
            onChange: (value: string) => onEffort(value as ReasoningVariant),
          },
        ]
      : []),
    ...(isFolded("mode")
      ? [
          {
            id: "mode",
            label: "Mode",
            icon: modeIcon,
            value: summary?.thread.mode,
            options: MODE_OPTIONS,
            onChange: (value: string) => onMode(value as PermissionMode),
            warning: modeWarning(summary?.thread.mode),
          },
        ]
      : []),
  ];

  const steerButton = (
    <Hint
      label={STEER_LABEL}
      render={
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Steer now"
          disabled={!canSend}
          className="rounded-(--composer-button-radius) text-muted-foreground"
          onClick={() => void steer()}
        />
      }
    >
      <Send />
    </Hint>
  );

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
        className={cn(SLAB, "mx-auto max-w-(--thread-max-width)")}
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
                <span className="text-muted-foreground/70">{ghost.rest}</span>
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
                : running
                  ? "Queue a message… (/ for commands, @ for files)"
                  : "Message… (/ for commands, @ for files)"
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
        {/* Never wraps: labels give way to glyphs, then pickers fold into "…" (toolbar-layout.ts). */}
        <div
          ref={toolbarRef}
          data-testid="composer-toolbar"
          className="flex flex-nowrap items-center gap-1 px-2 pb-2"
        >
          <ToolbarBlock id="model" folded={false}>
            <Picker
              label="Model"
              shortcutId="composer.model"
              keys="mod+shift+m"
              focused={focused}
              value={model?.model}
              options={modelChoices}
              icon={model && <AgentIcon agent={model.agent} className="size-3.5" />}
              iconLabel={model && agentLabel(model.agent)}
              warning={modelWarning}
              onOpen={refreshModels}
              labelled={isLabelled("model")}
              search={
                model && {
                  rowIcon: <AgentIcon agent={model.agent} className="size-3.5" />,
                  favourite: isFavourite,
                  onToggleFavourite: (value) =>
                    useModelFavourites.getState().toggle(model.agent, value),
                }
              }
              onChange={onModel}
            />
          </ToolbarBlock>
          {efforts.length > 0 && (
            <ToolbarBlock id="effort" folded={isFolded("effort")} separator>
              <Picker
                label="Effort"
                shortcutId="composer.effort"
                keys="mod+shift+e"
                focused={focused}
                value={model?.variant}
                options={efforts}
                icon={effortIcon}
                labelled={isLabelled("effort")}
                folded={isFolded("effort")}
                onFoldedOpen={() => openFolded("effort")}
                onChange={onEffort}
              />
            </ToolbarBlock>
          )}
          {model && !isFolded("speed") && (
            <ToolbarBlock id="speed" folded={false} separator>
              <SpeedField
                agent={model.agent}
                model={model.model}
                models={models}
                value={model.speed}
                state={summary?.thread.speedState ?? { speed: "unknown" }}
                ghost
                labelled={isLabelled("speed")}
                onChange={onSpeed}
              />
            </ToolbarBlock>
          )}
          <ToolbarBlock id="mode" folded={isFolded("mode")} separator>
            <Picker
              label="Mode"
              shortcutId="composer.mode"
              keys="mod+shift+a"
              focused={focused}
              value={summary?.thread.mode}
              options={MODE_OPTIONS}
              icon={modeIcon}
              warning={modeWarning(summary?.thread.mode)}
              labelled={isLabelled("mode")}
              folded={isFolded("mode")}
              onFoldedOpen={() => openFolded("mode")}
              onChange={onMode}
            />
          </ToolbarBlock>
          {folded.length > 0 && (
            <ToolbarOverflow
              pickers={foldedPickers}
              steer={
                showSteer && isFolded("steer")
                  ? { run: () => void steer(), disabled: !canSend, label: STEER_LABEL }
                  : undefined
              }
              open={overflowOpen}
              onOpenChange={(next) => {
                setOverflowOpen(next);
                if (!next) setOverflowSub(undefined);
              }}
              openSub={overflowSub}
              onOpenSubChange={setOverflowSub}
            />
          )}
          <div data-toolbar-fixed className="flex shrink-0 empty:hidden">
            <StashMenu
              threadId={threadId}
              onRestore={(saved) => void restore(saved)}
              onError={flash}
              keep={attachments.keep}
            />
          </div>
          <span
            aria-live="polite"
            className="min-w-0 flex-1 truncate px-1 text-xs text-muted-foreground"
          >
            {hint ?? (dictation.active ? dictationStatus(dictation.state) : undefined)}
          </span>
          {/* Folded, Steer lives in "…" alone: unlike a picker it has no shortcut to keep mounted. */}
          {showSteer && !isFolded("steer") && (
            <ToolbarBlock
              id="steer"
              folded={false}
              className={steerArrives ? "gram-swap" : undefined}
            >
              {steerButton}
            </ToolbarBlock>
          )}
          <div data-toolbar-fixed className="flex shrink-0 items-center gap-1.5">
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
            {/* Stop opens beside Send as a turn starts and folds away as it ends, so Send slides over
                rather than jumping. */}
            <SlotPresence shown={busy || background} gap={6}>
              <Hint
                label={background ? "Stop the background agents" : "Stop"}
                render={
                  <button
                    type="button"
                    aria-label="Stop"
                    className={cn(ROUND, STOP_OUTLINE)}
                    onClick={() => void api.interrupt(threadId)}
                  />
                }
              >
                <Square aria-hidden className="size-2.5 fill-current" />
              </Hint>
            </SlotPresence>
            {/* Right-click for the other ways to send: steer into the running turn, or send and
                start a new draft. */}
            <ContextMenu>
              <ContextMenuTrigger
                data-testid="send-menu-trigger"
                render={<span className="inline-flex" />}
              >
                <PressScale hover={canSend ? 1.05 : undefined}>
                  <Hint
                    label={withHint(sendLabel, sendKey === "enter" ? "↵" : sendHint)}
                    render={
                      <button
                        type="button"
                        aria-label={busy ? "Queue" : "Send"}
                        disabled={!canSend}
                        className={cn(ROUND, busy ? QUEUE_GLYPH : SEND_FILL)}
                        onClick={() => void send()}
                      />
                    }
                  >
                    <Swap swapKey={busy ? "Queue" : "Send"}>
                      {busy ? (
                        <ListPlus aria-hidden className="size-4" />
                      ) : (
                        <ArrowUp aria-hidden className="size-4" strokeWidth={2.25} />
                      )}
                    </Swap>
                  </Hint>
                </PressScale>
              </ContextMenuTrigger>
              <ContextMenuContent data-testid="send-menu" className="[&_svg]:size-3.5">
                <ContextMenuItem disabled={!canSend} onClick={() => void send()}>
                  {busy ? <ListPlus aria-hidden /> : <ArrowUp aria-hidden />}
                  {busy ? "Queue" : "Send"}
                  <kbd className="ml-auto pl-3 font-mono text-[10px] text-muted-foreground">
                    {sendKey === "enter" ? "↵" : sendHint}
                  </kbd>
                </ContextMenuItem>
                {steerable && (
                  <ContextMenuItem disabled={!canSend} onClick={() => void steer()}>
                    <Send aria-hidden />
                    {STEER_LABEL}
                  </ContextMenuItem>
                )}
                <ContextMenuItem disabled={!canSend} onClick={() => void send(true)}>
                  <SquarePen aria-hidden />
                  Send and start a new draft
                  <kbd className="ml-auto pl-3 font-mono text-[10px] text-muted-foreground">
                    {newDraftHint}
                  </kbd>
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </div>
        </div>
      </SharedSlab>
    </div>
  );
}

/**
 * One foldable control on the toolbar, measured by `useToolbarLayout`. Folded, its children stay
 * mounted outside the row, so a picker's shortcut still opens it in the "…" menu.
 */
function ToolbarBlock({
  id,
  folded,
  separator = false,
  className,
  children,
}: {
  id: string;
  folded: boolean;
  separator?: boolean;
  className?: string | undefined;
  children: ReactNode;
}) {
  if (folded) return <>{children}</>;
  return (
    <div data-toolbar-block={id} className={cn("flex shrink-0 items-center gap-1", className)}>
      {separator && <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />}
      {children}
    </div>
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
        "text-[11px] text-muted-foreground *:ms-2 *:inline-block *:whitespace-nowrap",
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

const KBD = "rounded-sm border border-border px-1 font-mono text-[10px]";
