import type { SubagentUsageData, GramUIMessage, ThreadId, TurnId } from "@gram/contracts";
import {
  measureElement,
  useVirtualizer,
  type VirtualItem,
  type Virtualizer,
} from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useMarkdown } from "@/components/ai-elements/markdown-loader";
import { Button } from "@/components/ui/button";
import { useShortcut } from "@/keyboard/registry";
import { useStable } from "@/lib/use-stable";
import { cn } from "@/lib/utils";
import { StreamExtrasView, useOrchestratorStreamContext } from "@/orchestration/stream-context";
import { digestOf } from "@/orchestration/stream-model";
import { useThreadsStore } from "@/stores/threads";
import { isFoldOpen, useTurnFolds } from "@/stores/turn-folds";

import { CompactingLine } from "./compaction-marker";
import { MessageBlock } from "./message-block";
import { isToolPart, type Chapter } from "./parts";
import { runningSubagents } from "./subagent-strip-model";
import { ConversationRail } from "./table-of-contents";
import { reuseFolds, turnFolds, type MessageFold } from "./tool-group-model";
import { FileRefsProvider } from "./file-ref-link";
import { PrRefsProvider } from "./pr-ref-link";
import {
  beginScrollGesture,
  consumeScrollGesture,
  scrollOwner,
  type ScrollGesture,
} from "./transcript-scroll";

/** Statuses in which the latest turn is still under way, so its files aren't final. */
const TURN_IN_PROGRESS = new Set(["starting", "running", "needsApproval", "needsInput"]);

/** Distance from the bottom (px) tolerated while already following new content. */
const FOLLOW_THRESHOLD = 64;
/** Only a clamped/subpixel bottom viewport overrides the actual reading-edge chapter. */
const CURRENT_BOTTOM_TOLERANCE = 1.5;

/** Distance from the top (px) within which scrolling pages in earlier history. */
const EARLIER_THRESHOLD = 600;
/** The height of the row above the first message while there's earlier history. */
const EARLIER_ROW = 40;
/** How far the transcript fades into the composer: `mask-b-from-[calc(100%-1.5rem)]` below. */
const FADE_PX = 24;
/** How long a search hit in a fold keeps its place while the opened row settles. */
const REVEAL_SETTLE_FRAMES = 12;
/** The live compaction line's room under the last row until it is measured: one line and `my-3`. */
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

/**
 * The virtualizer re-estimates every row whenever its options change, which is each render; stored
 * messages keep their identity, so each is estimated once.
 */
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
      // A closed card's transcript is inert, so nothing in it can take focus.
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

const NO_MESSAGES: readonly GramUIMessage[] = [];

export function Transcript({
  threadId,
  loading: loadingMessages,
  messages: loadedMessages,
  subagents,
  subagentUsage,
  streamingIds,
  turnEnds,
  animate,
  jump,
  chapters = [],
  onChapterJump,
  reveal,
  flashId,
  earlier = false,
  loadingEarlier = false,
  earlierFailed = false,
  onLoadEarlier,
  live = false,
}: {
  threadId: ThreadId;
  loading: boolean;
  messages: readonly GramUIMessage[];
  subagents: ReadonlyMap<string, readonly GramUIMessage[]>;
  /** The latest counts for each subagent run, keyed by its tool call id. */
  subagentUsage: ReadonlyMap<string, SubagentUsageData>;
  streamingIds: ReadonlySet<string>;
  /** Each finished turn's last reply, by message id; see `turnEndMessages`. */
  turnEnds: ReadonlyMap<string, TurnId>;
  /** Only the focused pane animates streaming text. */
  animate: boolean;
  jump: JumpRequest | undefined;
  chapters?: readonly Chapter[];
  onChapterJump?: (messageId: string) => void;
  /** A search hit to scroll to the middle of the view. */
  reveal?: JumpRequest | undefined;
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
}) {
  // The virtualizer is a mutable instance; the compiler must not memoize around it.
  "use no memo";
  // Rows wait for the markdown renderer as they wait for the messages, so none is laid out as
  // plain text first and measured again. A failed load shows them plain rather than never.
  const markdown = useMarkdown();
  const markdownPending = markdown.module === undefined && markdown.failed === undefined;
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
  const inProgress = useThreadsStore((s) => TURN_IN_PROGRESS.has(s.byId[threadId]?.status ?? ""));
  const compaction = useThreadsStore((s) => s.byId[threadId]?.compaction);
  // Measured: in a narrow pane the line wraps, and the room under the last row must grow with it.
  const [compactingRow, setCompactingRow] = useState(COMPACTING_ROW);
  const measureCompacting = useCallback((element: HTMLDivElement | null) => {
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setCompactingRow(element.offsetHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const endRoom = FADE_PX + (compaction === undefined ? 0 : compactingRow);
  // An orchestrator's stream is its own digest of the thread, with no turns to fold.
  const orchestrated = useOrchestratorStreamContext() !== undefined;
  const background = useThreadsStore((s) => s.byId[threadId]?.background);
  // Calls that returned and go on: a backgrounded subagent or shell stays in view until it's done.
  const workingCalls = useStable(
    useMemo(
      () =>
        new Set([
          // Not the usage alone: a finished run's last snapshot can still say it's running.
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
    () => (orchestrated ? NO_FOLDS : turnFolds(messages, inProgress, workingCalls)),
    [messages, inProgress, orchestrated, workingCalls],
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
  /** What a jump or a search hit lands on mustn't stay folded away. True when it opened a fold. */
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

  // Record widths only alongside actual ResizeObserver measurements, never a cached height.
  // A backward jump leaves a backward scroll direction behind; that must not suppress anchoring
  // when rows above the reading edge subsequently reflow at a different width.
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
      return message ? estimateRowHeight(message, closedFold(message.id)) : 96;
    },
    overscan: 6,
    // The virtualizer preserves the visible key/offset through prepend and trim.
    // Transcript's following ref still decides whether to follow new content.
    anchorTo: "end",
    followOnAppend: false,
    // End anchoring also follows row remeasurement, independently of followOnAppend and the
    // size-change predicate below. A negative threshold disables that while the reader is paused,
    // including the frame between an upward gesture and its native scroll event.
    scrollEndThreshold: following.current ? 1 : -1,
    getItemKey: (index) => messages[index]?.id ?? index,
    paddingStart: earlier ? EARLIER_ROW : 0,
    // Room under the last row, and in what following scrolls to, so the newest line sits clear of
    // the fade into the composer; a compaction under way takes its line's room there too.
    paddingEnd: endRoom,
    scrollPaddingEnd: endRoom,
  });

  const setFollowing = useCallback(
    (value: boolean) => {
      following.current = value;
      // ResizeObserver may run before React commits this input event's state update.
      virtualizer.options.scrollEndThreshold = value ? 1 : -1;
      setIsFollowing(value);
    },
    [virtualizer],
  );

  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    const offset = (instance.scrollOffset ?? 0) + instance.scrollAdjustments;
    // Keep the default first-measure and spanning-row rules. Width reflow above the fold
    // preserves the reader's current position even after backward navigation or manual input.
    return !instance.itemSizeCache.has(item.key)
      ? item.start < offset
      : item.end <= offset && (widthChanged.current || instance.scrollDirection !== "backward");
  };

  // History changes can shift numeric indices. The virtualizer owns the visible key/offset;
  // retire an in-flight index jump whenever that mapping changes.
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
      // A requested stable anchor can move while estimates settle or a history page arrives.
      // Re-resolve only the active jump, never a retired request after the reader moves on.
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

  // A window that doesn't fill the view can't be scrolled up to ask for more. Checked only while
  // there is more, since reading the height forces a layout, which on every streamed render adds up.
  const count = messages.length;
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!earlier || loading || loadingEarlier || earlierFailed || !scroller || count === 0) return;
    if (scroller.scrollHeight <= scroller.clientHeight) onLoadEarlier?.();
  }, [earlier, loading, loadingEarlier, earlierFailed, count, onLoadEarlier]);

  // A compaction starting, or its line wrapping, takes room under the last row, which following
  // brings into view.
  const compactingSince = compaction?.startedAt;
  useEffect(() => {
    if (following.current && messages.length > 0) {
      virtualizer.scrollToIndex(messages.length - 1, { align: "end" });
    }
  }, [messages, compactingSince, compactingRow, virtualizer]);

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
    // Keep an outline request alive through measurement/paging reconciliation, then retire it.
    // Replaying the last clicked ID on every later append would fight manual reading.
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
    // The row may not be rendered until the virtualizer has scrolled to it, and each closed card on
    // the way takes a render to open.
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
    // A stable-ID jump is reconciled by the layout effect while it is active. Its changed numeric
    // index must not clean up that active request before the new mapping is applied.
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
    // The opened row is taller than the one measured, and likely than the view: its start is where
    // the turn's story is, and a few frames bring that back as the row settles at its new height.
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

  // This pane's transcript answers ⌥↑ / ⌥↓ while focus is in the pane, or nowhere in the focused one.
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

  const interruptJump = () => {
    pendingJump.current = undefined;
    virtualizer.cancelScroll();
    manualGesture.current = undefined;
    lastScrollTop.current = scrollRef.current?.scrollTop ?? 0;
    setFollowing(false);
  };

  const forwardGesture = (kind: ScrollGesture["kind"], scroller: HTMLDivElement) => {
    manualGesture.current = beginScrollGesture(
      kind,
      scroller,
      layoutRevision.current,
      performance.now(),
    );
    // Explicit downward input at the outer clamped end produces no native scroll event.
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 1) {
      manualGesture.current = undefined;
      setFollowing(true);
    }
  };

  const jumpToLatest = () => {
    pendingJump.current = undefined;
    virtualizer.cancelScroll();
    manualGesture.current = undefined;
    setFollowing(true);
    virtualizer.scrollToEnd();
  };

  // Fades into the composer with a mask, not a blur: backdrop-filter stays off
  // streaming content. The virtualizer's end padding keeps the newest line clear of the fade.
  const firstVisible = virtualizer
    .getVirtualItems()
    .find((item) => item.end > (virtualizer.scrollOffset ?? 0))?.index;
  // The newest prompt can be below the top of a clamped final viewport. At the bottom, name that
  // last turn; everywhere else the row at the reading edge determines the current chapter.
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
          onJump={jumpToLatest}
        />
      ) : (
        !isFollowing &&
        messages.length > 0 && (
          <Button
            className="absolute left-1/2 bottom-6 z-10 -translate-x-1/2"
            variant="secondary"
            size="sm"
            onClick={jumpToLatest}
          >
            Jump to latest
          </Button>
        )
      )}
      {onChapterJump && (
        <ConversationRail
          chapters={chapters}
          currentId={currentId}
          onJump={onChapterJump}
          earlier={earlier}
          loadingEarlier={loadingEarlier}
          earlierFailed={earlierFailed}
          onLoadEarlier={() => onLoadEarlier?.(true)}
        />
      )}
      <div
        ref={scrollRef}
        data-testid="transcript"
        className="h-full min-h-0 overflow-y-auto mask-b-from-[calc(100%-1.5rem)] [overflow-anchor:none]"
        onWheel={(event) => {
          if (event.deltaY === 0) return;
          interruptJump();
          const el = event.currentTarget;
          if (
            !event.defaultPrevented &&
            event.deltaY > 0 &&
            scrollOwner(event.target, el, event.deltaY) === el
          )
            forwardGesture("wheel", el);
        }}
        onTouchStart={(event) => {
          interruptJump();
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
          interruptJump();
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
        onPointerDown={(event) => {
          interruptJump();
          scrollbarPointer.current = undefined;
          const el = event.currentTarget;
          const bounds = el.getBoundingClientRect();
          // Only a drag of this viewport's actual scrollbar owns a pointer scroll gesture.
          if (
            event.target === el &&
            event.button === 0 &&
            event.clientX >= bounds.left + el.clientWidth
          ) {
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
          interruptJump();
          const target = event.target instanceof Element ? event.target : null;
          if (
            event.defaultPrevented ||
            target?.closest("input, textarea, select, [contenteditable=true]") ||
            (event.key === " " && target?.closest("button, a, [role=button]"))
          )
            return;
          const forward =
            !["ArrowUp", "PageUp", "Home"].includes(event.key) &&
            !(event.key === " " && event.shiftKey);
          // Keyboard navigation belongs to the focused scrollport, even at an inner boundary.
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
          // A scroll toward the end never leaves it, even when rows grew faster than it moved:
          // only a scroll that stayed or went up pauses.
          if (
            following.current &&
            el.scrollTop <= lastScrollTop.current &&
            (bottom >= FOLLOW_THRESHOLD || (el.scrollTop < lastScrollTop.current && bottom > 1))
          )
            setFollowing(false);
          // Near the bottom is still a reading position. Only returning to the actual end resumes
          // follow; an upward gesture must stay paused even for a subpixel movement.
          else if (!following.current && input.resume) setFollowing(true);
          lastScrollTop.current = el.scrollTop;
          if (!following.current) wantEarlier(el);
        }}
      >
        {loading ? (
          <p className="p-6 text-sm text-muted-foreground">Loading conversation…</p>
        ) : messages.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">No messages yet.</p>
        ) : (
          <PrRefsProvider threadId={threadId}>
            <FileRefsProvider threadId={threadId}>
              <div
                className="relative mx-auto w-full max-w-(--thread-max-width)"
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
                  return (
                    <div
                      key={item.key}
                      data-index={item.index}
                      data-message-id={id}
                      data-flash={flashId === id ? "true" : undefined}
                      ref={virtualizer.measureElement}
                      tabIndex={-1}
                      className={cn(
                        "absolute top-0 left-0 w-full rounded-(--radius-md) px-6 outline-none transition-[background-color,box-shadow] duration-(--dur-fast) [contain:content] focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset data-[flash=true]:bg-highlight/10 data-[flash=true]:ring-2 data-[flash=true]:ring-highlight/50 data-[flash=true]:ring-inset",
                        closed?.empty !== true && "py-2",
                      )}
                      style={{ transform: `translateY(${item.start}px)` }}
                    >
                      <Row
                        threadId={threadId}
                        message={messages[item.index]!}
                        streamingIds={streamingIds}
                        subagents={subagents}
                        subagentUsage={subagentUsage}
                        animate={animate}
                        turnEnd={turnEndOf(id)}
                        fold={folds.get(id)}
                        foldOpen={closed === undefined}
                      />
                    </div>
                  );
                })}
                {compaction !== undefined && (
                  <div
                    ref={measureCompacting}
                    // `flow-root` keeps the line's own margins inside what is measured.
                    className="absolute left-0 flow-root w-full px-6"
                    style={{ top: virtualizer.getTotalSize() - endRoom }}
                  >
                    <CompactingLine compaction={compaction} />
                  </div>
                )}
              </div>
            </FileRefsProvider>
          </PrRefsProvider>
        )}
      </div>
    </div>
  );
}

/**
 * A transcript row. Only rows with a subagent card, or streaming themselves, see the live subagent
 * map and streaming set; the rest get constants, so a streamed chunk doesn't re-render them.
 */
/** A message counts as just sent for this long, which is when it animates in. */
const ARRIVAL_MS = 3000;

function Row({
  threadId,
  message,
  streamingIds,
  subagents,
  subagentUsage,
  animate,
  turnEnd,
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
  fold: MessageFold | undefined;
  foldOpen: boolean;
}) {
  const live = hasSubagentTool(message);
  // Decided once, at mount: what you just sent lands in the transcript you are watching, and the
  // same message scrolled back into view later, or met in a pane you aren't in, is simply there.
  // A reply needs none of this, since its text streams in.
  const [arriving] = useState(
    () =>
      animate &&
      message.role === "user" &&
      Date.now() - (message.metadata?.createdAt ?? 0) < ARRIVAL_MS,
  );
  // In an orchestrator's stream a digest is its lines, its cards and one quiet digest line, never
  // the digest's own card.
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
          fold={fold}
          foldOpen={foldOpen}
        />
      )}
      <StreamExtrasView messageId={message.id} at={message.metadata?.createdAt} />
    </div>
  );
}

/**
 * A live worker's pill: "Following live" while the view keeps up with it, its dot breathing only
 * while text streams in; scrolled up, "Jump to live" brings the view back and follows again.
 * Following or not is the reader's; the worker never hears of it.
 */
function FollowingLive({
  following,
  streaming,
  onJump,
}: {
  following: boolean;
  streaming: boolean;
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
  const pill =
    "absolute bottom-6 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-popover px-2.5 py-1 text-xs shadow-sm";
  return following ? (
    <span role="status" data-testid="following-live" className={cn(pill, "text-muted-foreground")}>
      {dot}
      Following live
    </span>
  ) : (
    <button
      type="button"
      data-testid="jump-to-live"
      className={cn(
        pill,
        "text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
      )}
      onClick={onJump}
    >
      {dot}
      Jump to live
    </button>
  );
}
