import type { Thread, ThreadId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { GitFork, MessageSquareOff } from "lucide-react";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { useApi } from "@/api/context";
import { lazyPart } from "@/lib/lazy-part";
import { PinnedDocChip } from "@/docs/doc-chip";
import { needsYou } from "@/sidebar/grouping";
import { activityLine, statusHint, threadStatusOf } from "@/sidebar/status";
import { mergeStateMarkOf, PrBadge, PrChip, reviewDecisionMarkOf } from "@/components/git-badges";
import { PrBadgeMenuItems } from "@/components/pr-badge-menu";
import { PrElsewhereChip } from "@/components/pr-elsewhere";
import { RunningCount } from "@/components/running-count";
import { WorktreeMissingChip } from "@/components/worktree-missing";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { PortChips } from "@/components/port-chips";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { Composer } from "@/composer/composer";
import { EditBanner } from "@/composer/edit-banner";
import { UndoLine } from "@/inbox/inbox-line";
import { useShortcut } from "@/keyboard/registry";
import { targetBadge } from "@/panels/pr-identity";
import { turnEndMessages } from "@/panels/turn-diff";
import { FakeAgentBadge } from "@/shell/fake-agent-badge";
import { Foldable } from "@/shell/foldable";
import { useTitlebarOutline } from "@/shell/titlebar-outline";
import { FOLD_ICONS, useTitlebarSlot, useTitlebarThread } from "@/shell/titlebar-slot";
import { usePhone } from "@/lib/use-phone";
import { useStable } from "@/lib/use-stable";
import { cn } from "@/lib/utils";
import { AttentionPulse, Swap, TurnCompleteSheen } from "@/motion";
import { orchestratorRowTitle } from "@/orchestration/tree-model";
import { FinishedWorkerView } from "@/orchestration/finished-worker-view";
import { useWorkspaces } from "@/orchestration/use-orchestration";
import { OrchestratorBanner, OrchestratorChips, WorkerBanner } from "@/orchestration/worker-banner";
import { besideShown, useBesideStore } from "@/orchestration/beside-store";
import { BesideLinkScope } from "@/orchestration/beside-link";
import { CatchUpCard } from "@/orchestration/catch-up-card";
import { FailuresCard } from "@/orchestration/failures-card";
import { StatusHeader } from "@/orchestration/status-header";
import { useAllActivity } from "@/stores/all-activity";
import { useConversationOnly } from "@/stores/conversation-only";
import { OrchestratorStreamProvider, useOrchestratorStream } from "@/orchestration/stream-context";
import { StuckCard } from "@/orchestration/stuck-card";
import {
  useBackToOrchestrator,
  WorkerActions,
  WorkerCrumbs,
  WorkerNowChip,
} from "@/orchestration/worker-header";
import { RunScriptMenu } from "@/scripts/run-script-menu";
import { loadEarlier, useThreadFeed } from "@/stores/feeds";
import { fitShell, useLayoutStore } from "@/stores/layout";
import { useRevealStore } from "@/stores/reveal";
import { useThreadsStore } from "@/stores/threads";

import { messageMarkdown } from "./copy-markdown";
import { sameCommand, toggleCommandView, useCommandViewStore } from "./command-view-store";
import { useStopTask } from "./use-stop-task";
import { FindBar } from "./find-bar";
import { copyMarkdown } from "./message-actions";
import { forkedFromText } from "./fork-text";
import { trackWrappedChips } from "./header-chips";
import { LabelChip, useThreadLabel } from "./label-chip";
import { AwaitingMachine, MachineStarting, useMachineWait } from "./awaiting-machine";
import { WAIT_WORDS } from "./awaiting-machine-model";
import { MachineChip } from "./machine-chip";
import { FolderMissingNotice } from "./folder-missing-notice";
import { LapsedConnectorsNotice } from "./lapsed-connectors-notice";
import { MergedCleanupNotice } from "./merged-cleanup-notice";
import { chaptersOf, sameChapters } from "./parts";
import { useSplitSubagents } from "./use-split-subagents";
import { trackPaneHeight } from "./pane-height";
import { PlanStrip } from "./plan-strip";
import { WaitingTray } from "./waiting-tray";
import { PrStrip } from "./pr-strip";
import { ownPrOnStrip } from "./pr-strip-model";
import { LimitWaitLine } from "./limit-wait-line";
import { QueueList } from "./queue-list";
import { RecapCard } from "./recap-card";
import { ApprovalSlotsProvider } from "./approval-slots";
import { RequestCards } from "./request-cards";
import { RoleGlyph, useThreadRole } from "./role-chip";
import { activeStreamingIds } from "./streaming";
import { SubagentStrip } from "./subagent-strip";
import {
  nextJump,
  runningSubagents,
  stripRows,
  type RunningSubagent,
  type StripRow,
} from "./subagent-strip-model";
import { TableOfContents } from "./table-of-contents";
import { ConversationOnlyButton } from "./conversation-only-toggle";
import { ThreadMenu } from "./thread-menu";
import { useTraceViewStore } from "./trace-view-store";
import { Transcript, transcriptScroller, type JumpRequest, type ScrollRestore } from "./transcript";
import { turnUndos } from "./turn-undo-marker";
import { useUnseenFrom } from "./unread";
import { SnoozeChip } from "./snooze-chip";
import { BrowserChip } from "./browser-chip";
import { HeaderWakeChip } from "./wake-chip";

const SentNotice = lazy(async () => ({
  default: (await import("./sent-notice")).SentNotice,
}));
const MovedAwayNotice = lazy(async () => ({
  default: (await import("./moved-away-notice")).MovedAwayNotice,
}));

const LeftOpenNotice = lazy(async () => ({
  default: (await import("./moved-away-notice")).LeftOpenNotice,
}));

const traceBody = lazyPart(() => import("./trace-view"));

const FLASH_MS = 1600;

const focusedMessageId = (): string | undefined =>
  document.activeElement?.closest<HTMLElement>("[data-message-id]")?.dataset["messageId"];

const isControl = (target: EventTarget) =>
  target instanceof Element &&
  target.closest("button, a, input, select, textarea, [role='button'], [role='menuitem']") !== null;

const NO_STRIP_LINES: readonly StripRow[] = [];

export function ThreadView({
  threadId,
  focused: paneFocused,
  actions,
  onHeaderDoubleClick,
  onHeaderDragStart,
  beside,
}: {
  threadId: ThreadId;
  focused: boolean;
  /**
   * Shown in the right panel's Thread tab beside the chat: `header` in place of the thread's own,
   * and a composer that says it steers the thread (or `placeholder`, the words of an app that shows
   * it). What it sends is the same as typing in the view.
   */
  beside?:
    | {
        header: ReactNode;
        placeholder?: string;
        /** A finished worker: its transcript only, no composer, and a line saying so instead. */
        readOnly?: boolean;
        /**
         * The worker pane's head says the plan's step and the repositories itself, so neither the
         * plan strip nor the banner's multi-repo note stacks under it.
         */
        ownHead?: boolean;
      }
    | undefined;
  /** Pane controls at the end of the header. */
  actions?: ReactNode;
  /** Runs on a double-click on the header outside its controls; the grid maximizes or restores. */
  onHeaderDoubleClick?: () => void;
  /** Makes the header a drag source; the grid swaps panes on drop. */
  onHeaderDragStart?: (event: DragEvent<HTMLElement>) => void;
}) {
  const covered = useLayoutStore((s) => s.panelExpanded || fitShell(s).reviewFocus);
  const besideFocused = useBesideStore((s) => s.focused && besideShown(s) !== undefined);
  const focused = beside === undefined ? paneFocused && !covered && !besideFocused : paneFocused;
  const summary = useThreadsStore((s) => s.byId[threadId]);
  const titlebarThread = useTitlebarThread();
  const titlebarSlot = useTitlebarSlot((s) => s.slot);
  const detail = useThreadsStore((s) => s.statusDetail[threadId]);
  const ready = useThreadsStore((s) => s.ready);
  const phase = useThreadFeed(threadId, (s) => s.phase);
  const slow = useThreadFeed(threadId, (s) => s.slow);
  const messages = useThreadFeed(threadId, (s) => s.messages);
  const streamingIds = useThreadFeed(threadId, (s) => s.streamingMessageIds);
  const earlier = useThreadFeed(threadId, (s) => s.earlier);
  const loadingEarlier = useThreadFeed(threadId, (s) => s.loadingEarlier);
  const earlierFailed = useThreadFeed(threadId, (s) => s.earlierFailed);
  const pageEarlier = (retry?: boolean) =>
    loadEarlier(threadId, { retry: retry === true }).catch((error: unknown) =>
      console.error("thread history", error),
    );

  const { top, children, subagentUsage } = useSplitSubagents(messages);
  const tracing = useTraceViewStore((s) => (beside === undefined ? s.open[threadId] : undefined));
  const trace = traceBody.useModule(tracing !== undefined);
  const traceShown = tracing !== undefined && trace !== undefined;
  const stream = useOrchestratorStream(summary?.thread, top);
  const shown = stream?.plan.messages ?? top;
  const unreadFrom = useUnseenFrom(
    threadId,
    shown,
    summary?.thread.lastViewedAt,
    summary !== undefined && phase !== "loading",
  );
  const chapters = useStable(
    useMemo(() => chaptersOf(shown), [shown]),
    sameChapters,
  );
  const turnEnds = useMemo(() => turnEndMessages(top), [top]);
  const undos = useMemo(() => turnUndos(top), [top]);
  const turnStatus = summary?.status;
  const nestedIds = useMemo(
    () => new Set([...children.values()].flatMap((list) => list.map((m) => m.id))),
    [children],
  );
  const streamingSet = useMemo(
    () => activeStreamingIds(turnStatus, streamingIds, nestedIds),
    [turnStatus, streamingIds, nestedIds],
  );
  const running = useMemo(
    () =>
      runningSubagents({
        top,
        children,
        usage: subagentUsage,
        streamingIds: streamingSet,
      }),
    [top, children, subagentUsage, streamingSet],
  );
  const background = summary?.background;
  const canStop = summary?.capabilities?.stopTasks === true;
  const conversationOnly = useConversationOnly((s) => s.on);
  const stripLines = useMemo(
    () => stripRows(running, background ?? [], canStop),
    [running, background, canStop],
  );
  const stopTask = useStopTask(threadId);
  const commandOf = (row: StripRow) =>
    row.output === undefined
      ? undefined
      : {
          threadId,
          ...row.output,
          command: row.command ?? row.label,
          startedAt: row.startedAt,
        };
  const shownCommand = useCommandViewStore((s) =>
    s.shown && s.open?.threadId === threadId ? s.open : undefined,
  );
  const shownRow =
    shownCommand === undefined
      ? undefined
      : stripLines.find((row) => {
          const open = commandOf(row);
          return open !== undefined && sameCommand(shownCommand, open);
        })?.key;
  const openCommand = (row: StripRow) => {
    const open = commandOf(row);
    if (open !== undefined) toggleCommandView(open);
  };
  const [chapterJump, setChapterJump] = useState<JumpRequest>();
  const jumpToChapter = (messageId: string) => {
    const index = shown.findIndex((message) => message.id === messageId);
    if (index === -1) return;
    setChapterJump((previous) => ({
      index,
      messageId,
      nonce: (previous?.nonce ?? 0) + 1,
    }));
  };
  const carriedByBar =
    titlebarSlot !== null &&
    titlebarThread === threadId &&
    actions === undefined &&
    beside === undefined;
  const latestOutline = useRef({ jump: jumpToChapter, loadEarlier: () => void pageEarlier(true) });
  useEffect(() => {
    latestOutline.current = { jump: jumpToChapter, loadEarlier: () => void pageEarlier(true) };
  });
  useEffect(() => {
    if (!carriedByBar) return;
    const { set } = useTitlebarOutline.getState();
    set({
      threadId,
      chapters,
      earlier,
      loadingEarlier,
      earlierFailed,
      jump: (messageId) => latestOutline.current.jump(messageId),
      onLoadEarlier: () => latestOutline.current.loadEarlier(),
    });
    return () => {
      if (useTitlebarOutline.getState().outline?.threadId === threadId) set(undefined);
    };
  }, [carriedByBar, threadId, chapters, earlier, loadingEarlier, earlierFailed]);
  const lastSubagentJump = useRef<string>(undefined);
  const [finding, setFinding] = useState(false);
  const [restore, setRestore] = useState<ScrollRestore>();
  const revealRequest = useRevealStore((s) => s.request);
  const sourceTitle = useThreadsStore((s) => {
    const from = s.byId[threadId]?.thread.forkedFrom?.threadId;
    return from ? s.byId[from]?.thread.title : undefined;
  });
  const label = useThreadLabel(summary?.thread);
  const paneTitle = usePaneTitle(summary?.thread);

  const revealIndex =
    revealRequest?.threadId === threadId
      ? shown.findIndex((m) => m.id === revealRequest.messageId)
      : -1;
  const revealLoaded =
    revealRequest?.threadId === threadId && top.some((m) => m.id === revealRequest.messageId);
  const revealNonce = revealIndex === -1 ? undefined : revealRequest?.nonce;
  const revealJump = useMemo(
    () => (revealNonce === undefined ? undefined : { index: revealIndex, nonce: revealNonce }),
    [revealIndex, revealNonce],
  );
  const flashId = revealNonce === undefined ? undefined : revealRequest?.messageId;
  const unloadedHit =
    revealRequest?.threadId === threadId && !revealLoaded && earlier
      ? revealRequest.messageId
      : undefined;
  useEffect(() => {
    if (unloadedHit === undefined || earlierFailed) return;
    loadEarlier(threadId, { until: unloadedHit }).catch((error: unknown) =>
      console.error("thread history", error),
    );
  }, [unloadedHit, threadId, earlierFailed]);

  useEffect(() => {
    if (revealNonce === undefined) return;
    const timer = setTimeout(() => useRevealStore.getState().done(revealNonce), FLASH_MS);
    return () => clearTimeout(timer);
  }, [revealNonce]);

  const foldedHit =
    revealRequest?.threadId === threadId && revealIndex === -1
      ? stream?.plan.foldedInto.has(revealRequest.messageId)
      : false;
  useEffect(() => {
    if (foldedHit === true) useAllActivity.getState().set(threadId, true);
  }, [foldedHit, threadId]);

  const reveal = (messageId: string) => useRevealStore.getState().reveal(threadId, messageId);

  const jumpToSubagent = (run: RunningSubagent) => {
    lastSubagentJump.current = run.toolCallId;
    const messageId = top[run.index]?.id;
    const index = shown.findIndex((m) => m.id === messageId);
    if (index === -1) return;
    setChapterJump({
      index,
      nonce: Date.now(),
      toolCallId: run.toolCallId,
      ancestors: run.ancestors,
    });
  };

  useShortcut(
    {
      id: "subagent.jump",
      keys: "mod+alt+j",
      label: "Jump to a running subagent (again for the next)",
      group: "Thread",
      when: () => running.length > 0,
      run: () => {
        const run = nextJump(running, lastSubagentJump.current);
        if (run) jumpToSubagent(run);
      },
    },
    focused,
  );

  useBackToOrchestrator(threadId, focused && beside === undefined);

  useShortcut(
    {
      id: "thread.find",
      keys: "mod+f",
      label: "Find in thread",
      group: "Thread",
      run: () => {
        setFinding(true);
        requestAnimationFrame(() =>
          transcriptScroller(threadId)
            ?.closest("[data-thread-view]")
            ?.querySelector<HTMLInputElement>('[data-testid="find-bar"] input')
            ?.select(),
        );
      },
    },
    focused,
  );

  useShortcut(
    {
      id: "message.copy",
      keys: "mod+shift+c",
      label: "Copy focused message",
      group: "Thread",
      when: () => focusedMessageId() !== undefined,
      run: (event) => {
        const message = top.find((m) => m.id === focusedMessageId());
        if (message === undefined) return;
        event.preventDefault();
        void copyMarkdown(messageMarkdown(message), { toast: true });
      },
    },
    focused,
  );

  if (phase === "gone" || (!summary && ready)) return <ThreadGone threadId={threadId} />;
  if (!summary) {
    return (
      <div className="flex flex-1 items-center justify-center text-reading text-muted-foreground">
        Loading…
      </div>
    );
  }

  const { thread, status } = summary;
  const awaiting = thread.awaitingMachine !== undefined;
  const linkScope =
    thread.role === "orchestrator" ? thread.id : beside ? thread.spawnedBy?.threadId : undefined;
  const pr = summary.git?.pr;
  const shownPr = targetBadge(summary.git, thread.boundPr) ?? pr;
  const needs = needsYou(summary) || summary.pendingRequests.length > 0;
  const activity = activityLine(status, detail, summary.activity);
  const display = threadStatusOf(summary, detail);
  const glyphWorks = display.working || display.running !== undefined || status === "starting";
  const inTitlebar = carriedByBar;
  const hideSm = inTitlebar ? "@max-sm/titlebar:hidden" : "@max-sm:hidden";
  const titleShown = !(inTitlebar && paneTitle.workspaceName);
  const hideMd = inTitlebar ? "@max-md/titlebar:hidden" : "@max-md:hidden";
  const prOnStrip = ownPrOnStrip(thread.boundPr, summary.git, thread.hiddenPrs);

  const header = beside ? (
    beside.header
  ) : (
    <AttentionPulse
      active={needs && !inTitlebar}
      className={cn(
        "@container",
        inTitlebar ? "my-1 flex min-w-0 flex-1 rounded-(--radius-md)" : "shrink-0",
      )}
    >
      <header
        data-testid="pane-header"
        draggable={onHeaderDragStart !== undefined}
        onDragStart={onHeaderDragStart}
        onMouseDown={(event) => {
          if (onHeaderDoubleClick && event.detail > 1 && !isControl(event.target)) {
            event.preventDefault();
          }
        }}
        onDoubleClick={(event) => {
          if (onHeaderDoubleClick && !isControl(event.target)) onHeaderDoubleClick();
        }}
        data-in-titlebar={inTitlebar || undefined}
        className={cn(
          "flex items-center gap-2 text-reading",
          inTitlebar
            ? "relative h-full min-w-0 flex-1 rounded-[inherit] pr-1 pl-2 [&>*:not(:first-child)]:[-webkit-app-region:no-drag]"
            : "h-10 border-b border-border px-4 @max-sm:px-2",
        )}
      >
        <div
          data-titlebar-room={inTitlebar ? (titleShown ? 96 : 48) : undefined}
          className={cn("flex min-w-0 flex-1 items-center gap-2", inTitlebar && "overflow-x-clip")}
        >
          {thread.spawnedBy === undefined ? (
            <PaneHeading
              thread={thread}
              gestures={onHeaderDoubleClick !== undefined}
              titleShown={titleShown}
            />
          ) : (
            <WorkerCrumbs
              thread={thread}
              gestures={onHeaderDoubleClick !== undefined}
              inTitlebar={inTitlebar}
            />
          )}
          <div
            ref={trackWrappedChips}
            data-testid="pane-header-chips"
            data-titlebar-gives={inTitlebar ? "" : undefined}
            className={cn(
              "flex h-6 max-w-[60%] min-w-0 shrink-[0.01] flex-wrap items-center gap-x-2 gap-y-4 overflow-hidden",
              inTitlebar && "[-webkit-app-region:no-drag]",
              inTitlebar && titleShown && "max-w-[45%] @max-sm:max-w-[30%]",
              inTitlebar && titleShown && "shrink-[10000]",
              inTitlebar && !titleShown && "max-w-none shrink",
              inTitlebar && "before:-mr-2 before:h-6 before:w-0 before:content-['']",
            )}
          >
            <MachineChip thread={thread} className={hideSm} />
            <WorkerNowChip thread={thread} prOnStrip={prOnStrip} />
            <OrchestratorChips thread={thread} inTitlebar={inTitlebar} />
            {thread.forkedFrom && (
              <ForkedFrom from={thread.forkedFrom} title={sourceTitle} hideClass={hideMd} />
            )}
            {label && (
              <LabelChip
                label={label}
                neutral
                testId="pane-label"
                className={cn("text-meta text-muted-foreground", hideMd)}
              />
            )}
            <WorktreeMissingChip
              git={summary.git}
              testId="pane-folder-missing"
              className={cn("text-meta", hideSm)}
            />
            {!prOnStrip && pr && summary.git?.pr && (
              <ContextMenu>
                <ContextMenuTrigger className="flex shrink-0">
                  <PrBadge
                    threadId={threadId}
                    git={summary.git}
                    thread={thread}
                    testId="pane-pr-badge"
                    className="text-meta text-muted-foreground"
                  />
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <PrBadgeMenuItems threadId={threadId} pr={summary.git.pr} />
                </ContextMenuContent>
              </ContextMenu>
            )}
            {!prOnStrip && (
              <>
                <PrChip
                  group="merge"
                  mark={mergeStateMarkOf(shownPr, thread.boundPr)}
                  testId="pane-merge-state"
                  iconOnly
                  className={hideMd}
                />
                <PrChip
                  group="review"
                  mark={reviewDecisionMarkOf(shownPr)}
                  testId="pane-review-decision"
                  iconOnly
                  className={hideMd}
                />
              </>
            )}
            <PrElsewhereChip
              git={summary.git}
              threadId={threadId}
              testId="pane-pr-elsewhere"
              compact
              className={cn("text-meta text-muted-foreground", hideMd)}
            />
            <PortChips
              threadId={threadId}
              ports={summary.ports}
              className={cn("text-meta text-muted-foreground", hideSm)}
            />
            <BrowserChip threadId={threadId} className={hideSm} />
            <HeaderWakeChip threadId={threadId} />
            <FakeAgentBadge className={hideSm} />
          </div>
        </div>
        <SnoozeChip threadId={threadId} />
        <WorkerActions thread={thread} inTitlebar={inTitlebar} />
        <Hint
          label={statusHint(display, activity)}
          side="bottom"
          render={
            <span
              data-testid="pane-status"
              data-quiet={(inTitlebar && !glyphWorks) || undefined}
              className={cn("relative flex shrink-0", inTitlebar && !glyphWorks && "hidden")}
            />
          }
        >
          <Swap swapKey={display.label}>
            <display.icon
              aria-hidden
              data-testid="status-icon"
              data-working={display.working}
              data-running={display.running}
              className={cn("size-icon-row", display.tone)}
            />
          </Swap>
          <RunningCount count={display.running} />
          <span className="sr-only">{display.label}</span>
        </Hint>
        {inTitlebar ? (
          <Foldable level={FOLD_ICONS} gap={8}>
            <ConversationOnlyButton inTitlebar />
          </Foldable>
        ) : (
          <ConversationOnlyButton hideClass={hideMd} />
        )}
        {!inTitlebar && (
          <>
            <TableOfContents
              chapters={chapters}
              onJump={jumpToChapter}
              earlier={earlier}
              loadingEarlier={loadingEarlier}
              earlierFailed={earlierFailed}
              onLoadEarlier={() => void pageEarlier(true)}
            />
            {thread.role !== "orchestrator" && (
              <HeaderRunScript
                threadId={threadId}
                projectId={thread.projectId}
                hideClass={hideSm}
              />
            )}
            <ThreadMenu threadId={threadId} />
          </>
        )}
        {actions}
      </header>
    </AttentionPulse>
  );

  return (
    <BesideLinkScope.Provider value={linkScope}>
      <div
        ref={trackPaneHeight}
        data-pane-root
        data-thread-view={threadId}
        className="flex min-h-0 flex-1 flex-col"
        data-testid="thread-view"
        data-focused={focused}
      >
        {inTitlebar ? createPortal(header, titlebarSlot) : header}
        {status === "starting" && detail && (
          <p
            role="status"
            aria-live="polite"
            data-testid="thread-starting-detail"
            className="shrink-0 px-4 py-2 text-meta wrap-anywhere text-muted-foreground"
          >
            {detail}
          </p>
        )}
        {traceShown && (
          <trace.TraceView
            threadId={threadId}
            messages={top}
            subagents={children}
            subagentUsage={subagentUsage}
            turn={tracing.turn}
            working={status === "running" || status === "needsApproval" || status === "needsInput"}
            onTurn={(turn) => useTraceViewStore.getState().show(threadId, turn)}
            onClose={() => useTraceViewStore.getState().close(threadId)}
            onReveal={(messageId) => {
              useTraceViewStore.getState().close(threadId);
              reveal(messageId);
            }}
          />
        )}
        <div className={traceShown ? "hidden" : "contents"}>
          <StatusHeader thread={thread} digests={stream?.plan.digests} />
          <WaitingTray threadId={threadId} />
          {beside?.ownHead !== true && <PlanStrip threadId={threadId} />}
          <WorkerBanner thread={thread} repos={beside?.ownHead !== true} />
          {!conversationOnly && <CatchUpCard thread={thread} />}
          <StuckCard thread={thread} />
          <OrchestratorBanner thread={thread} />
          {thread.role === "orchestrator" && thread.workspaceId !== undefined && (
            <FailuresCard
              workspaceId={thread.workspaceId}
              className="w-full thread-column shrink-0 px-6 pt-2 pb-2"
            />
          )}
          {finding && (
            <FindBar
              threadId={threadId}
              messages={top}
              earlier={earlier}
              getScroller={() => transcriptScroller(threadId)}
              onReveal={reveal}
              onClose={(anchor) => {
                setFinding(false);
                if (anchor !== undefined) setRestore({ anchor, nonce: Date.now() });
              }}
            />
          )}
          <ApprovalSlotsProvider threadId={threadId}>
            {awaiting && shown.length === 0 && (
              <div
                data-testid="machine-wait-scroll"
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
              >
                <AwaitingMachine thread={thread} />
              </div>
            )}
            <OrchestratorStreamProvider stream={stream}>
              {!(awaiting && shown.length === 0) && (
                <Transcript
                  threadId={threadId}
                  loading={phase === "loading"}
                  slow={slow}
                  messages={shown}
                  subagents={children}
                  subagentUsage={subagentUsage}
                  streamingIds={streamingSet}
                  turnEnds={turnEnds}
                  turnUndos={undos}
                  animate={focused}
                  jump={chapterJump}
                  chapters={chapters}
                  onChapterJump={jumpToChapter}
                  reveal={revealJump}
                  restore={restore}
                  flashId={flashId}
                  earlier={earlier}
                  loadingEarlier={loadingEarlier}
                  earlierFailed={earlierFailed}
                  onLoadEarlier={(retry) => void pageEarlier(retry)}
                  live={thread.spawnedBy !== undefined}
                  unreadFrom={unreadFrom}
                />
              )}
            </OrchestratorStreamProvider>
            {awaiting && shown.length > 0 && <AwaitingMachine thread={thread} />}
            {!awaiting && <MachineStarting thread={thread} />}
            <div className="w-full thread-column shrink-0 px-6">
              {thread.spawnedBy === undefined && !conversationOnly && (
                <RecapCard threadId={threadId} focused={focused} />
              )}
              <RequestCards
                threadId={threadId}
                requests={summary.pendingRequests}
                focused={focused}
                thread={thread}
              />
              {shown.length === 0 && <LimitWaitLine thread={thread} />}
              <QueueList threadId={threadId} />
            </div>
          </ApprovalSlotsProvider>
          {thread.transferredTo !== undefined && (
            <Suspense fallback={null}>
              <MovedAwayNotice threadId={threadId} />
            </Suspense>
          )}
          {thread.transferredFrom?.leftOpen !== undefined && (
            <Suspense fallback={null}>
              <LeftOpenNotice threadId={threadId} />
            </Suspense>
          )}
          <FolderMissingNotice threadId={threadId} />
          <MergedCleanupNotice threadId={threadId} />
          <LapsedConnectorsNotice threadId={threadId} />
          <EditBanner threadId={threadId} />
          <PinnedDocChip threadId={threadId} />
          {beside?.readOnly !== true && <PrStrip threadId={threadId} focused={focused} />}
          <SubagentStrip
            rows={conversationOnly ? NO_STRIP_LINES : stripLines}
            shownRow={shownRow}
            onJump={jumpToSubagent}
            onOpen={openCommand}
            onStop={stopTask}
          />
          {thread.role === "orchestrator" && <UndoLine />}
          {beside?.readOnly === true ? (
            <p
              data-testid="beside-readonly-note"
              className="mx-section mb-section shrink-0 rounded-md border border-dashed border-edge px-3 py-2 text-meta text-muted-foreground"
            >
              Finished, so this is its record: read only.
            </p>
          ) : thread.sentTo !== undefined ? (
            <Suspense fallback={null}>
              <SentNotice threadId={threadId} />
            </Suspense>
          ) : (
            <TurnCompleteSheen key={threadId} status={status}>
              <ThreadComposer
                thread={thread}
                focused={focused}
                {...(beside === undefined
                  ? {}
                  : {
                      placeholder: beside.placeholder ?? "Steer this thread…",
                    })}
              />
            </TurnCompleteSheen>
          )}
        </div>
      </div>
    </BesideLinkScope.Provider>
  );
}

function ThreadComposer({
  thread,
  focused,
  placeholder,
}: {
  thread: Thread;
  focused: boolean;
  placeholder?: string;
}) {
  const wait = useMachineWait(thread);
  const phone = usePhone();
  const words =
    wait === undefined
      ? placeholder
      : phone
        ? WAIT_WORDS.composePhone
        : wait.state === "failed"
          ? WAIT_WORDS.composeFailed
          : WAIT_WORDS.composeStarting;
  return (
    <Composer
      threadId={thread.id}
      focused={focused}
      toWorker={thread.spawnedBy !== undefined}
      {...(words === undefined ? {} : { placeholder: words })}
    />
  );
}

function ForkedFrom({
  from,
  title,
  hideClass,
}: {
  from: NonNullable<Thread["forkedFrom"]>;
  title: string | undefined;
  hideClass: string;
}) {
  const label = forkedFromText(from, title);
  const className = cn("flex shrink-0 items-center text-muted-foreground", hideClass);
  const body = (
    <>
      <GitFork aria-hidden className="size-icon-row" />
      <span className="sr-only">{label}</span>
    </>
  );
  if (!from.threadId || title === undefined) {
    return (
      <Hint
        label={label}
        side="bottom"
        render={<span data-testid="forked-from" className={className} />}
      >
        {body}
      </Hint>
    );
  }
  return (
    <Hint
      label={label}
      side="bottom"
      render={
        <Link
          to="/t/$threadId"
          params={{ threadId: from.threadId }}
          data-testid="forked-from"
          className={cn(className, "hover:text-foreground")}
        />
      }
    >
      {body}
    </Hint>
  );
}

function usePaneTitle(thread: Thread | undefined): { title: string; workspaceName: boolean } {
  const workspaces = useWorkspaces();
  if (thread === undefined) return { title: "", workspaceName: false };
  if (thread.role !== "orchestrator") return { title: thread.title, workspaceName: false };
  const workspace = workspaces.find((state) => state.workspace.id === thread.workspaceId);
  const title = orchestratorRowTitle(thread.title, workspace?.workspace.name);
  return { title, workspaceName: workspace !== undefined && title === workspace.workspace.name };
}

function PaneHeading({
  thread,
  gestures,
  titleShown,
}: {
  thread: Thread;
  gestures: boolean;
  titleShown: boolean;
}) {
  const role = useThreadRole(thread);
  const { title } = usePaneTitle(thread);
  return (
    <h1
      aria-label={role === undefined ? undefined : `${role.name}: ${title}`}
      className="flex min-w-0 items-center gap-1.5 font-heading font-medium"
      title={gestures ? `${title}. Double-click to maximize or restore; drag to swap panes` : title}
    >
      <RoleGlyph thread={thread} testId="pane-role" spoken={!titleShown} />
      <span
        data-titlebar-title={titleShown ? "" : undefined}
        className={titleShown ? "truncate" : "sr-only"}
      >
        {title}
      </span>
    </h1>
  );
}

function ThreadGone({ threadId }: { threadId: ThreadId }) {
  const api = useApi();
  const finished = useQuery({
    queryKey: ["orchestrator", "finishedWorker", threadId],
    queryFn: () => api.finishedWorker(threadId),
    retry: false,
    staleTime: 60_000,
  });
  if (finished.isPending) {
    return (
      <div className="flex flex-1 items-center justify-center text-reading text-muted-foreground">
        Loading…
      </div>
    );
  }
  if (finished.data !== undefined) return <FinishedWorkerView detail={finished.data} />;
  return <ThreadGoneNotice threadId={threadId} />;
}

function ThreadGoneNotice({ threadId }: { threadId: ThreadId }) {
  const close = () => {
    const { grid, closePane } = useLayoutStore.getState();
    const index = grid.panes.indexOf(threadId);
    if (index !== -1) closePane(index);
  };

  return (
    <div
      data-testid="thread-gone"
      className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-reading text-muted-foreground"
    >
      <MessageSquareOff aria-hidden className="size-icon-empty" />
      <p>This thread no longer exists.</p>
      <Button variant="outline" size="sm" onClick={close}>
        Close
      </Button>
    </div>
  );
}

function HeaderRunScript({
  threadId,
  projectId,
  hideClass,
}: {
  threadId: ThreadId;
  projectId: Thread["projectId"];
  hideClass: string;
}) {
  return (
    <RunScriptMenu
      threadId={threadId}
      projectId={projectId}
      size="glyph"
      onlyWithScripts
      className={hideClass}
    />
  );
}
