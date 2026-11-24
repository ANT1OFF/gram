import type {
  SubagentUsageData,
  GramUIMessage,
  ThreadId,
  TurnId,
  TurnUndoData,
} from "@gram/contracts";
import {
  measureElement,
  useVirtualizer,
  type VirtualItem,
  type Virtualizer,
} from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useMarkdown } from "@/components/ai-elements/markdown-loader";
import { agentLabel } from "@/agents/agent-label";
import { Button } from "@/components/ui/button";
import { useShortcut } from "@/keyboard/registry";
import { useStable } from "@/lib/use-stable";
import { heldReadingPlace, holdReadingPlace, releaseReadingPlace } from "@/settings/leave-settings";
import { cn } from "@/lib/utils";
import { StreamExtrasView, useOrchestratorStreamContext } from "@/orchestration/stream-context";
import { digestOf } from "@/orchestration/stream-model";
import { useThreadsStore } from "@/stores/threads";
import { useConversationOnly } from "@/stores/conversation-only";
import { isFoldOpen, useTurnFolds } from "@/stores/turn-folds";

import { AwaitingToolsProvider } from "./awaiting-tools";
import { CompactingLine } from "./compaction-marker";
import { StartingProgress } from "./starting-progress";
import { StopReceiptLine, useStopReceipt } from "./stop-receipt";
import { startingSteps } from "./starting-progress-model";
import { EmptyThread } from "./empty-thread";
import { HOLD_UNDER_POINTER } from "./hold-under-pointer";
import { retryHiddenOf } from "./attempt-model";
import { MessageBlock } from "./message-block";
import { isToolPart, type Chapter } from "./parts";
import { runningSubagents } from "./subagent-strip-model";
import type { ScrollAnchor } from "./find-bar";
import { ConversationRail } from "./table-of-contents";
import { showsInConversation } from "./conversation-only";
import { reuseFolds, turnFolds, type MessageFold } from "./tool-group-model";
import { useWaitLine, WaitLine } from "./wait-line";
import { WorkingLine } from "./working-line";
import { FileRefsProvider } from "./file-ref-link";
import { PrRefsProvider } from "./pr-ref-link";
import {
  beginScrollGesture,
  consumeScrollGesture,
  holdStill,
  scrollOwner,
  type ScrollGesture,
} from "./transcript-scroll";

const TURN_IN_PROGRESS = new Set(["starting", "running", "needsApproval", "needsInput"]);

const WORKING = new Set(["starting", "running"]);

const FOLLOW_THRESHOLD = 64;
const CURRENT_BOTTOM_TOLERANCE = 1.5;

const EARLIER_THRESHOLD = 600;
const EARLIER_ROW = 40;
const FADE_PX = 24;
const REVEAL_SETTLE_FRAMES = 12;
const RETURN_SETTLE_MS = 2000;
const COMPACTING_ROW = 40;

const NO_SUBAGENTS: ReadonlyMap<string, readonly GramUIMessage[]> = new Map();
const NO_SUBAGENT_USAGE: ReadonlyMap<string, SubagentUsageData> = new Map();
const NOT_STREAMING: ReadonlySet<string> = new Set();
const NO_FOLDS: ReadonlyMap<string, MessageFold> = new Map();

const sameIds = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((id) => b.has(id));

const hasSubagentTool = (message: GramUIMessage) =>
  message.parts.some(
    (part) =>
      part.type === "tool-Task" ||
      part.type === "tool-Agent" ||
      (part.type === "dynamic-tool" && part.toolName === "task"),
  );

/**
 * A first guess at a row's height before it's measured: collapsed tool cards, and text by length.
 * Close guesses keep scrolling into unmeasured history from jumping as rows correct their size.
 */
export function estimateRowHeight(message: GramUIMessage, closed?: MessageFold): number {
  const key = closed ?? message;
  const cached = estimates.get(key);
  if (cached !== undefined) return cached;
  if (closed?.empty === true) return 0;
  let height = message.role === "user" ? 56 : 48;
  for (const [index, part] of message.parts.entries()) {
    if (closed?.hidden.has(index) === true) continue;
    if (isToolPart(part)) height += 40;
    else if (part.type === "text")
      height += 22 * (part.text.split("\n").length + part.text.length / 90);
    else if (part.type === "reasoning") height += 36;
  }
  const estimate = Math.round(height);
  estimates.set(key, estimate);
  return estimate;
}

const estimates = new WeakMap<GramUIMessage | MessageFold, number>();

export interface JumpRequest {
  index: number;
  /** Outline requests retain an ID so a pending request survives history changes safely. */
  messageId?: string | undefined;
  /** Changes on every request so jumping to the same chapter twice still scrolls. */
  nonce: number;
  /** A tool card in that row to bring to the top and focus, once the row has rendered. */
  toolCallId?: string | undefined;
  /** The cards `toolCallId`'s is nested in, outermost first, opened on the way to it. */
  ancestors?: readonly string[] | undefined;
}

/**
 * One step toward the last card of `chain`, each nested in the one before: opens the first closed
 * card on the way, or brings the last to the top and focuses it. False while a card isn't rendered
 * yet or has just been opened, so the caller tries again a frame later.
 */
export function revealCard(root: ParentNode, chain: readonly string[]): boolean {
  for (const [i, id] of chain.entries()) {
    const card = root.querySelector<HTMLElement>(`[data-tool-call-id=${JSON.stringify(id)}]`);
    if (!card) return false;
    const trigger = card.querySelector<HTMLElement>("button");
    if (i < chain.length - 1) {
      if (trigger && !trigger.hasAttribute("data-panel-open")) {
        trigger.click();
        return false;
      }
      continue;
    }
    card.scrollIntoView({ block: "start" });
    trigger?.focus({ preventScroll: true });
    return true;
  }
  return false;
}

/** Where to put the transcript back to: Esc in find, to where it stood when find opened. */
export interface ScrollRestore {
  readonly anchor: ScrollAnchor;
  /** Changes on every request. */
  readonly nonce: number;
}

/** The scroller of `threadId`'s transcript, in the focused pane if it is in two. */
export function transcriptScroller(threadId: string): HTMLElement | undefined {
  const views = [
    ...document.querySelectorAll<HTMLElement>(`[data-thread-view=${JSON.stringify(threadId)}]`),
  ];
  const view = views.find((each) => each.dataset.focused === "true") ?? views[0];
  return view?.querySelector<HTMLElement>("[data-transcript]") ?? undefined;
}

const NO_MESSAGES: readonly GramUIMessage[] = [];

export function Transcript({
  threadId,
  loading: loadingMessages,
  slow = false,
  messages: loadedMessages,
  subagents,
  subagentUsage,
  streamingIds,
  turnEnds,
  turnUndos = NO_TURN_UNDOS,
  animate,
  jump,
  chapters = [],
  onChapterJump,
  reveal,
  restore,
  flashId,
  earlier = false,
  loadingEarlier = false,
  earlierFailed = false,
  onLoadEarlier,
  live = false,
  unreadFrom,
}: {
  threadId: ThreadId;
  loading: boolean;
  /** The server is slow to bring the conversation up and it is being asked again. */
  slow?: boolean | undefined;
  messages: readonly GramUIMessage[];
  subagents: ReadonlyMap<string, readonly GramUIMessage[]>;
  /** The latest counts for each subagent run, keyed by its tool call id. */
  subagentUsage: ReadonlyMap<string, SubagentUsageData>;
  streamingIds: ReadonlySet<string>;
  /** Each finished turn's last reply, by message id; see `turnEndMessages`. */
  turnEnds: ReadonlyMap<string, TurnId>;
  /** Each turn's undo receipt, by the turn it undid; see `turnUndos`. */
  turnUndos?: ReadonlyMap<TurnId, TurnUndoData>;
  /** Only the focused pane animates streaming text. */
  animate: boolean;
  jump: JumpRequest | undefined;
  chapters?: readonly Chapter[];
  onChapterJump?: (messageId: string) => void;
  /** A search hit to scroll to the middle of the view. */
  reveal?: JumpRequest | undefined;
  /** Where to scroll back to, e.g. as find closes with Esc. */
  restore?: ScrollRestore | undefined;
  /** A message to highlight briefly, e.g. the search hit just scrolled to. */
  flashId?: string | undefined;
  /** The thread has older history than `messages`, which `onLoadEarlier` pages in. */
  earlier?: boolean | undefined;
  loadingEarlier?: boolean | undefined;
  /** The last page failed; only the button asks again, with `retry`. */
  earlierFailed?: boolean | undefined;
  onLoadEarlier?: ((retry?: boolean) => void) | undefined;
  /**
   * A worker's transcript: while its turn runs, a "Following live" pill says the view keeps up,
   * and scrolling up turns it into "Jump to live".
   */
  live?: boolean | undefined;
  /** The first message the user hasn't seen, which a "New" line goes over; see `firstUnseen`. */
  unreadFrom?: string | undefined;
}) {
  "use no memo";
  const markdown = useMarkdown(!loadingMessages);
  const markdownPending =
    markdown.module === undefined && markdown.failed === undefined && markdown.plain === undefined;
  const loading = loadingMessages || markdownPending;
  const messages = markdownPending ? NO_MESSAGES : loadedMessages;
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [isFollowing, setIsFollowing] = useState(true);
  const manualGesture = useRef<ScrollGesture>(undefined);
  const layoutRevision = useRef(0);
  const scrollbarPointer = useRef<{ id: number; y: number }>(undefined);
  const touchPosition = useRef<{ id: number; y: number }>(undefined);
  const lastScrollTop = useRef(0);
  const [pressing, setPressing] = useState(false);
  const [readerPaused, setReaderPaused] = useState(false);
  const [scrolledEnd, setScrolledEnd] = useState(true);
  const held = useRef<string>(undefined);
  const inProgress = useThreadsStore((s) => TURN_IN_PROGRESS.has(s.byId[threadId]?.status ?? ""));
  const compaction = useThreadsStore((s) => s.byId[threadId]?.compaction);
  const orchestratedStream = useOrchestratorStreamContext() !== undefined;
  const startStatus = useThreadsStore((s) => s.byId[threadId]?.status);
  const startCheckout = useThreadsStore((s) => s.byId[threadId]?.thread.checkout);
  const startAgent = useThreadsStore((s) => s.byId[threadId]?.thread.model.agent);
  const startActivity = useThreadsStore(
    (s) => s.byId[threadId]?.activity ?? s.statusDetail[threadId],
  );
  const startSteps = useMemo(
    () =>
      orchestratedStream
        ? undefined
        : startingSteps({
            status: startStatus,
            checkout: startCheckout,
            agent: agentLabel(startAgent ?? "claude"),
            activity: startActivity,
            messages,
          }),
    [orchestratedStream, startStatus, startCheckout, startAgent, startActivity, messages],
  );
  const [compactingRow, setCompactingRow] = useState(COMPACTING_ROW);
  const measureCompacting = useCallback((element: HTMLDivElement | null) => {
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setCompactingRow(element.offsetHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const stopReceipt = useStopReceipt(threadId);
  const waitLine = useWaitLine(threadId);
  const conversationOnly = useConversationOnly((s) => s.on);
  const working = useThreadsStore(
    (s) => conversationOnly && WORKING.has(s.byId[threadId]?.status ?? ""),
  );
  const workingSince = working
    ? (loadedMessages.findLast((message) => message.role === "user")?.metadata?.createdAt ?? 0)
    : undefined;
  const compactingLine = conversationOnly ? undefined : compaction;
  const startLine = conversationOnly ? undefined : startSteps;
  const stopLine = conversationOnly ? undefined : stopReceipt;
  const tailLine =
    compactingLine !== undefined ||
    startLine !== undefined ||
    stopLine !== undefined ||
    waitLine ||
    workingSince !== undefined;
  const endRoom = FADE_PX + (tailLine ? compactingRow : 0);
  const orchestrated = useOrchestratorStreamContext() !== undefined;
  const background = useThreadsStore((s) => s.byId[threadId]?.background);
  const workingCalls = useStable(
    useMemo(
      () =>
        new Set([
          ...runningSubagents({
            top: messages,
            children: subagents,
            usage: subagentUsage,
            streamingIds,
          }).map((run) => run.toolCallId),
          ...(background ?? []).flatMap((task) => task.toolCallId ?? []),
        ]),
      [messages, subagents, subagentUsage, streamingIds, background],
    ),
    sameIds,
  );
  const builtFolds = useMemo(
    () =>
      orchestrated || conversationOnly ? NO_FOLDS : turnFolds(messages, inProgress, workingCalls),
    [messages, inProgress, orchestrated, conversationOnly, workingCalls],
  );
  const retryHidden = useMemo(
    () => (orchestrated ? NO_RETRY_HIDDEN : retryHiddenOf(messages)),
    [messages, orchestrated],
  );
  const keptFolds = useRef(NO_FOLDS);
  const folds = useMemo(() => reuseFolds(keptFolds.current, builtFolds), [builtFolds]);
  useLayoutEffect(() => {
    keptFolds.current = folds;
  }, [folds]);
  const openFolds = useTurnFolds((s) => s.open);
  const closedFold = (messageId: string) => {
    const fold = folds.get(messageId);
    return fold === undefined || isFoldOpen(openFolds, threadId, fold.turn) ? undefined : fold;
  };
  const revealFold = useCallback(
    (messageId: string | undefined) => {
      const fold = messageId === undefined ? undefined : keptFolds.current.get(messageId);
      if (fold === undefined || fold.hidden.size === 0) return false;
      const store = useTurnFolds.getState();
      if (isFoldOpen(store.open, threadId, fold.turn)) return false;
      store.reveal(threadId, fold.turn);
      return true;
    },
    [threadId],
  );
  const latestTurn = [...turnEnds.values()].at(-1);
  const turnEndOf = (messageId: string) => {
    const turnId = turnEnds.get(messageId);
    return inProgress && turnId === latestTurn ? undefined : turnId;
  };

  const measuredWidths = useRef(new Map<VirtualItem["key"], number>());
  const widthChanged = useRef(false);
  const measureRow = useCallback(
    (
      element: HTMLDivElement,
      entry: ResizeObserverEntry | undefined,
      instance: Virtualizer<HTMLDivElement, HTMLDivElement>,
    ) => {
      widthChanged.current = false;
      if (entry) {
        const key = instance.options.getItemKey(instance.indexFromElement(element));
        const width = entry.borderBoxSize[0]?.inlineSize ?? element.offsetWidth;
        const previous = measuredWidths.current.get(key);
        widthChanged.current = previous !== undefined && Math.abs(previous - width) > 0.5;
        measuredWidths.current.set(key, width);
      }
      const height = measureElement(element, entry, instance);
      const key = instance.options.getItemKey(instance.indexFromElement(element));
      if (instance.itemSizeCache.get(key) !== height) layoutRevision.current++;
      return height;
    },
    [],
  );

  // oxlint-disable-next-line react/incompatible-library -- opted out of memoization above
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    measureElement: measureRow,
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const message = messages[index];
      if (message !== undefined && retryHidden.has(message.id)) return 0;
      if (message !== undefined && conversationOnly && !showsInConversation(message)) return 0;
      return message ? estimateRowHeight(message, closedFold(message.id)) : 96;
    },
    overscan: 6,
    anchorTo: "end",
    followOnAppend: false,
    scrollEndThreshold: following.current && held.current === undefined ? 1 : -1,
    getItemKey: (index) => messages[index]?.id ?? index,
    paddingStart: earlier ? EARLIER_ROW : 0,
    paddingEnd: endRoom,
    scrollPaddingEnd: endRoom,
  });

  const setFollowing = useCallback(
    (value: boolean) => {
      following.current = value;
      virtualizer.options.scrollEndThreshold = value && held.current === undefined ? 1 : -1;
      setIsFollowing(value);
      if (value) setReaderPaused(false);
    },
    [virtualizer],
  );

  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    const hold = held.current;
    if (hold !== undefined) {
      const card = instance.measurementsCache.find((each) => each.key === hold);
      if (card !== undefined && item.index < card.index) return true;
    }
    const offset = (instance.scrollOffset ?? 0) + instance.scrollAdjustments;
    return !instance.itemSizeCache.has(item.key)
      ? item.start < offset
      : item.end <= offset && (widthChanged.current || instance.scrollDirection !== "backward");
  };

  const pendingJump = useRef<JumpRequest>(undefined);
  const previousMessages = useRef(messages);
  useLayoutEffect(() => {
    const previous = previousMessages.current;
    if (
      previous.length !== messages.length ||
      previous.some((message, index) => message.id !== messages[index]?.id)
    ) {
      manualGesture.current = undefined;
      layoutRevision.current++;
      const keys = new Set(messages.map((message) => message.id));
      for (const key of measuredWidths.current.keys()) {
        if (typeof key !== "string" || !keys.has(key)) measuredWidths.current.delete(key);
      }
      virtualizer.cancelScroll();
      const target = pendingJump.current?.messageId;
      const index =
        target === undefined ? -1 : messages.findIndex((message) => message.id === target);
      if (index >= 0) virtualizer.scrollToIndex(index, { align: "start" });
    }
    previousMessages.current = messages;
  }, [messages, virtualizer]);

  const wantEarlier = (scroller: HTMLElement) => {
    if (!earlier || loadingEarlier || earlierFailed || onLoadEarlier === undefined) return;
    const short = scroller.scrollHeight <= scroller.clientHeight;
    if (short || scroller.scrollTop < EARLIER_THRESHOLD) onLoadEarlier();
  };

  const count = messages.length;
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!earlier || loading || loadingEarlier || earlierFailed || !scroller || count === 0) return;
    if (scroller.scrollHeight <= scroller.clientHeight) onLoadEarlier?.();
  }, [earlier, loading, loadingEarlier, earlierFailed, count, onLoadEarlier]);

  const compactingSince = compaction?.startedAt;
  useEffect(() => {
    if (following.current && held.current === undefined && messages.length > 0) {
      virtualizer.scrollToIndex(messages.length - 1, { align: "end" });
    }
  }, [messages, compactingSince, compactingRow, tailLine, virtualizer]);

  const appliedJump = useRef<JumpRequest>(undefined);
  const jumpIndex =
    jump?.messageId === undefined
      ? jump?.index
      : messages.findIndex((message) => message.id === jump.messageId);
  const numericJumpIndex = jump?.messageId === undefined ? jumpIndex : undefined;
  const jumpAvailable = jumpIndex !== undefined && jumpIndex >= 0;
  useEffect(() => {
    if (!jump || !jumpAvailable || (jump.messageId !== undefined && appliedJump.current === jump))
      return;
    const targetIndex =
      jump.messageId === undefined
        ? numericJumpIndex
        : previousMessages.current.findIndex((message) => message.id === jump.messageId);
    if (targetIndex === undefined || targetIndex < 0) return;
    appliedJump.current = jump;
    manualGesture.current = undefined;
    setFollowing(false);
    revealFold(previousMessages.current[targetIndex]?.id);
    virtualizer.scrollToIndex(targetIndex, { align: "start" });
    let settleFrame = 0;
    if (jump.messageId !== undefined) {
      pendingJump.current = jump;
      const started = performance.now();
      let stableFrames = 0;
      let lastOffset: number | undefined;
      const settle = () => {
        if (pendingJump.current !== jump) return;
        const index = previousMessages.current.findIndex(
          (message) => message.id === jump.messageId,
        );
        const offset = index < 0 ? undefined : virtualizer.getOffsetForIndex(index, "start")?.[0];
        const scroller = scrollRef.current;
        const rendered = scroller?.querySelector<HTMLElement>(
          `[data-message-id=${JSON.stringify(jump.messageId)}]`,
        );
        const atTarget =
          offset !== undefined &&
          rendered !== null &&
          rendered !== undefined &&
          Math.abs((scroller?.scrollTop ?? 0) - offset) < 1.5;
        stableFrames = atTarget && offset === lastOffset ? stableFrames + 1 : 0;
        lastOffset = offset;
        if (stableFrames >= 4 || performance.now() - started > 5000) {
          pendingJump.current = undefined;
          return;
        }
        settleFrame = requestAnimationFrame(settle);
      };
      settleFrame = requestAnimationFrame(settle);
    }
    const finish = () => {
      cancelAnimationFrame(settleFrame);
      if (pendingJump.current === jump) pendingJump.current = undefined;
    };
    const { toolCallId, ancestors = [] } = jump;
    if (toolCallId === undefined) return finish;
    const chain = [...ancestors, toolCallId];
    let frames = 10 + 2 * chain.length;
    let frame = 0;
    const focusCard = () => {
      const scroller = scrollRef.current;
      if (scroller && revealCard(scroller, chain)) return;
      if (--frames > 0) frame = requestAnimationFrame(focusCard);
    };
    frame = requestAnimationFrame(focusCard);
    return () => {
      cancelAnimationFrame(frame);
      finish();
    };
  }, [jump, numericJumpIndex, jumpAvailable, virtualizer, setFollowing, revealFold]);

  useEffect(() => {
    if (!reveal) return;
    pendingJump.current = undefined;
    virtualizer.cancelScroll();
    manualGesture.current = undefined;
    setFollowing(false);
    if (!revealFold(previousMessages.current[reveal.index]?.id)) {
      virtualizer.scrollToIndex(reveal.index, { align: "center" });
      return;
    }
    pendingJump.current = reveal;
    let frames = REVEAL_SETTLE_FRAMES;
    let frame = 0;
    const settle = () => {
      if (pendingJump.current !== reveal) return;
      virtualizer.scrollToIndex(reveal.index, { align: "start" });
      if (--frames > 0) frame = requestAnimationFrame(settle);
      else pendingJump.current = undefined;
    };
    frame = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(frame);
  }, [reveal, virtualizer, setFollowing, revealFold]);

  useEffect(() => {
    if (!restore) return;
    const { anchor } = restore;
    pendingJump.current = undefined;
    virtualizer.cancelScroll();
    manualGesture.current = undefined;
    const index =
      anchor.messageId === undefined
        ? -1
        : previousMessages.current.findIndex((m) => m.id === anchor.messageId);
    if (anchor.atEnd || index === -1) {
      if (!anchor.atEnd) return;
      setFollowing(true);
      virtualizer.scrollToEnd();
      return;
    }
    setFollowing(false);
    virtualizer.scrollToIndex(index, { align: "start" });
    let frames = REVEAL_SETTLE_FRAMES;
    let frame = 0;
    const settle = () => {
      const scroller = scrollRef.current;
      const row = scroller?.querySelector<HTMLElement>(
        `[data-message-id=${JSON.stringify(anchor.messageId)}]`,
      );
      if (scroller && row) {
        const off =
          row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.top;
        if (Math.abs(off) > 1) scroller.scrollTop += off;
      } else virtualizer.scrollToIndex(index, { align: "start" });
      if (--frames > 0) frame = requestAnimationFrame(settle);
    };
    frame = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(frame);
  }, [restore, virtualizer, setFollowing]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    return () => {
      if (following.current || scroller === null) return;
      const top = scroller.getBoundingClientRect().top;
      const row = [...scroller.querySelectorAll<HTMLElement>("[data-message-id]")].find(
        (each) => each.getBoundingClientRect().bottom > top,
      );
      const key = row?.dataset["messageId"];
      if (row !== undefined && key !== undefined)
        holdReadingPlace(threadId, { key, offset: top - row.getBoundingClientRect().top });
    };
  }, [threadId]);
  const [comingBack] = useState(() => heldReadingPlace(threadId));
  useEffect(() => {
    if (comingBack !== undefined) releaseReadingPlace(threadId);
  }, [comingBack, threadId]);
  const hasMessages = messages.length > 0;
  useLayoutEffect(() => {
    if (comingBack === undefined || !hasMessages) return;
    const rowOf = () =>
      previousMessages.current.findIndex((message) => message.id === comingBack.key);
    const index = rowOf();
    if (index < 0) return;
    const request: JumpRequest = { index, messageId: comingBack.key, nonce: -1 };
    pendingJump.current = request;
    manualGesture.current = undefined;
    setFollowing(false);
    virtualizer.scrollToIndex(index, { align: "start" });
    const started = performance.now();
    let stableFrames = 0;
    let frame = 0;
    const settle = () => {
      if (pendingJump.current !== request) return;
      const start = virtualizer.measurementsCache[rowOf()]?.start;
      const scroller = scrollRef.current;
      if (start === undefined || scroller === null) {
        pendingJump.current = undefined;
        return;
      }
      const target = start + comingBack.offset;
      if (Math.abs(scroller.scrollTop - target) >= 1.5) {
        virtualizer.scrollToOffset(target);
        stableFrames = 0;
      } else stableFrames++;
      if (stableFrames >= 4 || performance.now() - started > RETURN_SETTLE_MS) {
        pendingJump.current = undefined;
        return;
      }
      frame = requestAnimationFrame(settle);
    };
    frame = requestAnimationFrame(settle);
    return () => {
      cancelAnimationFrame(frame);
      if (pendingJump.current === request) pendingJump.current = undefined;
    };
  }, [comingBack, hasMessages, virtualizer, setFollowing]);

  const inPane = () => {
    const pane = scrollRef.current?.closest<HTMLElement>("[data-pane-index]");
    if (!pane) return false;
    const active = document.activeElement;
    return active === null || active === document.body
      ? pane.dataset.focused === "true"
      : pane.contains(active);
  };
  const step = (delta: 1 | -1) => {
    const scroller = scrollRef.current;
    if (!scroller || messages.length === 0) return;
    const current = document.activeElement?.closest<HTMLElement>("[data-index]");
    const from =
      current && scroller.contains(current)
        ? Number(current.dataset.index) + delta
        : (virtualizer.getVirtualItems().find((item) => item.end > scroller.scrollTop)?.index ??
            0) + (delta === 1 ? 0 : -1);
    const index = Math.min(messages.length - 1, Math.max(0, from));
    pendingJump.current = undefined;
    virtualizer.cancelScroll();
    manualGesture.current = undefined;
    setFollowing(false);
    virtualizer.scrollToIndex(index, { align: "start" });
    let frames = 10;
    const focusRow = () => {
      const row = scroller.querySelector<HTMLElement>(`[data-index="${index}"]`);
      if (row) row.focus({ preventScroll: true });
      else if (--frames > 0) requestAnimationFrame(focusRow);
    };
    requestAnimationFrame(focusRow);
  };
  useShortcut({
    id: "thread.previousMessage",
    keys: "alt+arrowup",
    label: "Previous message",
    group: "Thread",
    focusScope: inPane,
    run: () => step(-1),
  });
  useShortcut({
    id: "thread.nextMessage",
    keys: "alt+arrowdown",
    label: "Next message",
    group: "Thread",
    focusScope: inPane,
    run: () => step(1),
  });

  const totalSize = virtualizer.getTotalSize();
  useLayoutEffect(() => {
    setScrolledEnd(scrolledToEnd(scrollRef.current));
  }, [totalSize, isFollowing]);

  const interruptJump = (reader = true) => {
    pendingJump.current = undefined;
    virtualizer.cancelScroll();
    manualGesture.current = undefined;
    lastScrollTop.current = scrollRef.current?.scrollTop ?? 0;
    setFollowing(false);
    if (reader) setReaderPaused(true);
  };

  const forwardGesture = (kind: ScrollGesture["kind"], scroller: HTMLDivElement) => {
    manualGesture.current = beginScrollGesture(
      kind,
      scroller,
      layoutRevision.current,
      performance.now(),
    );
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 1) {
      manualGesture.current = undefined;
      setFollowing(true);
    }
  };

  const holdUnder = (target: EventTarget | null) => {
    const card = target instanceof Element ? target.closest(`[${HOLD_UNDER_POINTER}]`) : null;
    const row = card?.closest<HTMLElement>("[data-index]");
    const key = row ? messages[Number(row.dataset["index"])]?.id : undefined;
    if (key === held.current) return;
    const released = held.current !== undefined && key === undefined;
    held.current = key;
    virtualizer.options.scrollEndThreshold = following.current && key === undefined ? 1 : -1;
    if (released && following.current && messages.length > 0)
      virtualizer.scrollToIndex(messages.length - 1, { align: "end" });
  };

  const jumpToLatest = () => {
    pendingJump.current = undefined;
    virtualizer.cancelScroll();
    manualGesture.current = undefined;
    setFollowing(true);
    virtualizer.scrollToEnd();
  };

  const firstVisible = virtualizer
    .getVirtualItems()
    .find((item) => item.end > (virtualizer.scrollOffset ?? 0))?.index;
  const quietAtEnd = !isFollowing && !readerPaused && scrolledEnd;
  const currentId = virtualizer.isAtEnd(CURRENT_BOTTOM_TOLERANCE)
    ? chapters.at(-1)?.id
    : firstVisible === undefined
      ? undefined
      : chapters.findLast((chapter) => chapter.index <= firstVisible)?.id;

  return (
    <div className="@container relative min-h-0 flex-1">
      {live && inProgress && messages.length > 0 ? (
        <FollowingLive
          following={isFollowing}
          streaming={streamingIds.size > 0}
          pressing={pressing}
          onJump={jumpToLatest}
        />
      ) : (
        !isFollowing &&
        !quietAtEnd &&
        messages.length > 0 && (
          <button
            type="button"
            className={cn(JUMP_PILL, pressing && "pointer-events-none")}
            onClick={jumpToLatest}
          >
            <JumpLabel>Jump to latest</JumpLabel>
          </button>
        )
      )}
      {onChapterJump && (
        <ConversationRail
          chapters={chapters}
          currentId={currentId}
          onJump={onChapterJump}
          scrollable={virtualizer.getTotalSize() > (virtualizer.scrollRect?.height ?? Infinity)}
          earlier={earlier}
          loadingEarlier={loadingEarlier}
          earlierFailed={earlierFailed}
          onLoadEarlier={() => onLoadEarlier?.(true)}
        />
      )}
      <div
        ref={scrollRef}
        data-testid="transcript"
        data-transcript=""
        className="h-full min-h-0 overflow-y-auto mask-b-from-[calc(100%-1.5rem)] [overflow-anchor:none] data-under:mask-t-from-[calc(100%-1rem)]"
        onWheel={(event) => {
          if (event.deltaY === 0) return;
          const el = event.currentTarget;
          interruptJump(canScroll(el));
          if (
            !event.defaultPrevented &&
            event.deltaY > 0 &&
            scrollOwner(event.target, el, event.deltaY) === el
          )
            forwardGesture("wheel", el);
        }}
        onTouchStart={(event) => {
          interruptJump(false);
          const touch = event.touches[0];
          touchPosition.current = touch ? { id: touch.identifier, y: touch.clientY } : undefined;
        }}
        onTouchMove={(event) => {
          const previous = touchPosition.current;
          const touch = Array.from(event.touches).find(
            (point) => point.identifier === previous?.id,
          );
          if (!previous || !touch) return;
          const delta = previous.y - touch.clientY;
          touchPosition.current = { id: touch.identifier, y: touch.clientY };
          if (delta === 0) return;
          interruptJump(canScroll(event.currentTarget));
          if (
            !event.defaultPrevented &&
            delta > 0 &&
            scrollOwner(event.target, event.currentTarget, delta) === event.currentTarget
          )
            forwardGesture("touch", event.currentTarget);
        }}
        onTouchEnd={() => {
          touchPosition.current = undefined;
        }}
        onTouchCancel={() => {
          touchPosition.current = undefined;
          manualGesture.current = undefined;
        }}
        onPointerOver={(event) => holdUnder(event.target)}
        onPointerLeave={() => holdUnder(null)}
        onPointerDown={(event) => {
          setPressing(true);
          const release = () => {
            setPressing(false);
            window.removeEventListener("pointerup", release, true);
            window.removeEventListener("pointercancel", release, true);
          };
          window.addEventListener("pointerup", release, true);
          window.addEventListener("pointercancel", release, true);
          scrollbarPointer.current = undefined;
          const el = event.currentTarget;
          const bounds = el.getBoundingClientRect();
          const scrollbar =
            event.target === el &&
            event.button === 0 &&
            event.clientX >= bounds.left + el.clientWidth;
          interruptJump(scrollbar);
          if (!scrollbar) holdStill(virtualizer, el);
          if (scrollbar) {
            scrollbarPointer.current = { id: event.pointerId, y: event.clientY };
            manualGesture.current = beginScrollGesture(
              "pointer",
              el,
              layoutRevision.current,
              performance.now(),
            );
          }
        }}
        onPointerMove={(event) => {
          const previous = scrollbarPointer.current;
          if (!previous || previous.id !== event.pointerId || (event.buttons & 1) === 0) return;
          scrollbarPointer.current = { id: event.pointerId, y: event.clientY };
          if (event.clientY > previous.y) forwardGesture("pointer", event.currentTarget);
        }}
        onPointerUp={() => {
          scrollbarPointer.current = undefined;
        }}
        onPointerCancel={() => {
          scrollbarPointer.current = undefined;
          if (manualGesture.current?.kind === "pointer") manualGesture.current = undefined;
        }}
        onKeyDown={(event) => {
          if (
            !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)
          )
            return;
          const target = event.target instanceof Element ? event.target : null;
          const operatesControl =
            event.defaultPrevented ||
            target?.closest(
              "input, textarea, select, [contenteditable=true], [role=radio], [role=listbox], [role=menu]",
            ) != null ||
            (event.key === " " && target?.closest("button, a, [role=button]") != null);
          interruptJump(!operatesControl);
          if (operatesControl) {
            holdStill(virtualizer, event.currentTarget);
            return;
          }
          const forward =
            !["ArrowUp", "PageUp", "Home"].includes(event.key) &&
            !(event.key === " " && event.shiftKey);
          if (forward && scrollOwner(event.target, event.currentTarget, 0) === event.currentTarget)
            forwardGesture("key", event.currentTarget);
        }}
        onScroll={(e) => {
          const el = e.currentTarget;
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight;
          const input = consumeScrollGesture(
            manualGesture.current,
            el,
            lastScrollTop.current,
            layoutRevision.current,
            performance.now(),
          );
          manualGesture.current = input.gesture;
          if (
            following.current &&
            el.scrollTop <= lastScrollTop.current &&
            (bottom >= FOLLOW_THRESHOLD || (el.scrollTop < lastScrollTop.current && bottom > 1))
          )
            setFollowing(false);
          else if (!following.current && input.resume) setFollowing(true);
          lastScrollTop.current = el.scrollTop;
          setScrolledEnd(bottom <= 0);
          el.toggleAttribute("data-under", el.scrollTop > 0);
          if (!following.current) wantEarlier(el);
        }}
      >
        {loading ? (
          <p className="p-6 text-reading text-muted-foreground" data-testid="transcript-loading">
            {slow && loadingMessages
              ? "Loading conversation… The server is slow to answer; still trying."
              : "Loading conversation…"}
          </p>
        ) : messages.length === 0 ? (
          <EmptyThread threadId={threadId} />
        ) : (
          <PrRefsProvider threadId={threadId}>
            <FileRefsProvider threadId={threadId}>
              <AwaitingToolsProvider threadId={threadId}>
                <div
                  className="relative w-full thread-column"
                  style={{ height: virtualizer.getTotalSize() }}
                >
                  {earlier ? (
                    <div
                      className="absolute top-0 left-0 flex w-full items-center justify-center"
                      style={{ height: EARLIER_ROW }}
                    >
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={loadingEarlier}
                        onClick={() => onLoadEarlier?.(true)}
                      >
                        {loadingEarlier
                          ? "Loading earlier messages…"
                          : earlierFailed
                            ? "Couldn't load earlier messages. Try again"
                            : "Show earlier messages"}
                      </Button>
                    </div>
                  ) : null}
                  {virtualizer.getVirtualItems().map((item) => {
                    const id = messages[item.index]!.id;
                    const closed = closedFold(id);
                    const retried = retryHidden.has(id);
                    const workOnly =
                      conversationOnly && !showsInConversation(messages[item.index]!);
                    return (
                      <div
                        key={item.key}
                        data-index={item.index}
                        data-message-id={id}
                        data-flash={flashId === id ? "true" : undefined}
                        ref={virtualizer.measureElement}
                        tabIndex={-1}
                        className={cn(
                          "absolute top-0 left-0 w-full rounded-(--radius-md) px-6 outline-none transition-[background-color,box-shadow] duration-(--dur-fast) [contain:content] [overflow-clip-margin:1rem] focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset data-[flash=true]:bg-highlight/10 data-[flash=true]:ring-2 data-[flash=true]:ring-highlight/50 data-[flash=true]:ring-inset",
                          closed?.empty !== true && !retried && !workOnly && "py-1.5",
                        )}
                        style={{ transform: `translateY(${item.start}px)` }}
                      >
                        {id === unreadFrom && <UnreadDivider />}
                        {!retried && (
                          <Row
                            threadId={threadId}
                            message={messages[item.index]!}
                            streamingIds={streamingIds}
                            subagents={subagents}
                            subagentUsage={subagentUsage}
                            animate={animate}
                            turnEnd={turnEndOf(id)}
                            turnUndos={turnUndos}
                            fold={folds.get(id)}
                            foldOpen={closed === undefined}
                          />
                        )}
                      </div>
                    );
                  })}
                  {tailLine && (
                    <div
                      ref={measureCompacting}
                      className="absolute left-0 flow-root w-full px-6"
                      style={{ top: virtualizer.getTotalSize() - endRoom }}
                    >
                      {compactingLine !== undefined ? (
                        <CompactingLine compaction={compactingLine} />
                      ) : startLine !== undefined ? (
                        <StartingProgress threadId={threadId} steps={startLine} />
                      ) : stopLine !== undefined ? (
                        <StopReceiptLine threadId={threadId} receipt={stopLine} />
                      ) : workingSince !== undefined && !waitLine ? (
                        <WorkingLine since={workingSince} />
                      ) : (
                        waitLine && <WaitLine threadId={threadId} />
                      )}
                    </div>
                  )}
                </div>
              </AwaitingToolsProvider>
            </FileRefsProvider>
          </PrRefsProvider>
        )}
      </div>
    </div>
  );
}

function UnreadDivider() {
  return (
    <div
      role="separator"
      aria-label="New since you last looked"
      data-testid="unread-divider"
      className="flex items-center gap-2 pb-2 text-meta font-medium text-link"
    >
      New
      <span aria-hidden className="h-px flex-1 bg-primary/50" />
    </div>
  );
}

const scrolledToEnd = (el: HTMLElement | null) =>
  el === null || el.scrollHeight - el.scrollTop - el.clientHeight <= 0;

const canScroll = (el: HTMLElement) => el.scrollHeight - el.clientHeight > 1;

const ARRIVAL_MS = 3000;

const NO_TURN_UNDOS: ReadonlyMap<TurnId, TurnUndoData> = new Map();
const NO_RETRY_HIDDEN: ReadonlySet<string> = new Set();

function Row({
  threadId,
  message,
  streamingIds,
  subagents,
  subagentUsage,
  animate,
  turnEnd,
  turnUndos,
  fold,
  foldOpen,
}: {
  threadId: ThreadId;
  message: GramUIMessage;
  streamingIds: ReadonlySet<string>;
  subagents: ReadonlyMap<string, readonly GramUIMessage[]>;
  subagentUsage: ReadonlyMap<string, SubagentUsageData>;
  animate: boolean;
  turnEnd: TurnId | undefined;
  turnUndos: ReadonlyMap<TurnId, TurnUndoData>;
  fold: MessageFold | undefined;
  foldOpen: boolean;
}) {
  const live = hasSubagentTool(message);
  const [arriving] = useState(
    () =>
      animate &&
      message.role === "user" &&
      Date.now() - (message.metadata?.createdAt ?? 0) < ARRIVAL_MS,
  );
  const stream = useOrchestratorStreamContext();
  const streamed = stream !== undefined && digestOf(message) !== undefined;
  return (
    <div className={arriving ? "gram-arrive" : undefined}>
      {!streamed && (
        <MessageBlock
          threadId={threadId}
          message={message}
          streamingIds={live || streamingIds.has(message.id) ? streamingIds : NOT_STREAMING}
          subagents={live ? subagents : NO_SUBAGENTS}
          subagentUsage={live ? subagentUsage : NO_SUBAGENT_USAGE}
          animate={animate}
          turnEnd={turnEnd}
          turnUndo={turnEnd === undefined ? undefined : turnUndos.get(turnEnd)}
          fold={fold}
          foldOpen={foldOpen}
        />
      )}
      <StreamExtrasView
        messageId={message.id}
        renderReply={(reply) => (
          <MessageBlock
            threadId={threadId}
            message={reply}
            streamingIds={streamingIds.has(reply.id) ? streamingIds : NOT_STREAMING}
            subagents={NO_SUBAGENTS}
            subagentUsage={NO_SUBAGENT_USAGE}
            animate={false}
            turnEnd={undefined}
            turnUndo={undefined}
            fold={undefined}
            foldOpen={false}
          />
        )}
      />
    </div>
  );
}

const PILL =
  "absolute bottom-6 thread-column-center z-10 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-edge bg-popover px-2.5 py-1 text-meta shadow-raised";

const JUMP_PILL = cn(
  PILL,
  "text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
  "phone:right-4 phone:left-auto phone:size-11 phone:translate-x-0 phone:justify-center phone:px-0",
);

function JumpLabel({ children }: { children: string }) {
  return (
    <>
      <ArrowDown aria-hidden className="hidden size-icon-bar phone:block" />
      <span className="phone:sr-only">{children}</span>
    </>
  );
}

function FollowingLive({
  following,
  streaming,
  pressing,
  onJump,
}: {
  following: boolean;
  streaming: boolean;
  pressing: boolean;
  onJump: () => void;
}) {
  const dot = (
    <span
      aria-hidden
      data-testid="following-live-dot"
      data-streaming={streaming}
      className={cn("size-1.5 rounded-full bg-status-working", streaming && "gram-breathe")}
    />
  );
  return following ? (
    <span role="status" data-testid="following-live" className={cn(PILL, "text-muted-foreground")}>
      {dot}
      Following live
    </span>
  ) : (
    <button
      type="button"
      data-testid="jump-to-live"
      className={cn(JUMP_PILL, pressing && "pointer-events-none")}
      onClick={onJump}
    >
      <span className="contents phone:hidden">{dot}</span>
      <JumpLabel>Jump to live</JumpLabel>
    </button>
  );
}
