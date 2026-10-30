import type { Thread, ThreadId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { GitFork, MessageSquareOff, X } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
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
import { useShortcut } from "@/keyboard/registry";
import { targetBadge } from "@/panels/pr-identity";
import { turnEndMessages } from "@/panels/turn-diff";
import { FakeAgentBadge } from "@/shell/fake-agent-badge";
import { FOLD_ALL, useSoloRoute, useTitlebarSlot, useTitlebarThread } from "@/shell/titlebar-slot";
import { useStable } from "@/lib/use-stable";
import { cn } from "@/lib/utils";
import { AttentionPulse, Swap, TurnCompleteSheen } from "@/motion";
import { answersInPlace } from "@/orchestration/ask-model";
import { AskStack } from "@/orchestration/ask-stack";
import { BriefingPlaceholder } from "@/orchestration/briefing";
import { orchestratorRowTitle } from "@/orchestration/tree-model";
import { FinishedWorkerView } from "@/orchestration/finished-worker-view";
import { useWorkspaces } from "@/orchestration/use-orchestration";
import { OrchestratorBanner, OrchestratorChips, WorkerBanner } from "@/orchestration/worker-banner";
import { CatchUpCard } from "@/orchestration/catch-up-card";
import { SinceYouLeftCard } from "@/orchestration/since-you-left";
import { OrchestratorStreamProvider, useOrchestratorStream } from "@/orchestration/stream-context";
import { StuckCard } from "@/orchestration/stuck-card";
import {
  useBackToOrchestrator,
  WorkerActions,
  WorkerCrumbs,
  WorkerNowChip,
} from "@/orchestration/worker-header";
import { loadEarlier, useThreadFeed } from "@/stores/feeds";
import { useLayoutStore } from "@/stores/layout";
import { useRevealStore } from "@/stores/reveal";
import { useThreadsStore } from "@/stores/threads";

import { messageMarkdown } from "./copy-markdown";
import { FindBar } from "./find-bar";
import { copyMarkdown } from "./message-actions";
import { forkedFromText } from "./fork-text";
import { trackWrappedChips } from "./header-chips";
import { LabelChip, labelTint, useThreadLabel } from "./label-chip";
import { FolderMissingNotice } from "./folder-missing-notice";
import { LapsedConnectorsNotice } from "./lapsed-connectors-notice";
import { MergedCleanupNotice } from "./merged-cleanup-notice";
import { chaptersOf, sameChapters } from "./parts";
import { useSplitSubagents } from "./use-split-subagents";
import { trackPaneHeight } from "./pane-height";
import { PlanStrip } from "./plan-strip";
import { WaitingTray } from "./waiting-tray";
import { PrStrip } from "./pr-strip";
import { LimitWaitLine } from "./limit-wait-line";
import { QueueList } from "./queue-list";
import { RecapCard } from "./recap-card";
import { RequestCards } from "./request-cards";
import { RoleGlyph, useThreadRole } from "./role-chip";
import { activeStreamingIds } from "./streaming";
import { SubagentStrip } from "./subagent-strip";
import {
  nextJump,
  runningSubagents,
  stripRows,
  type RunningSubagent,
} from "./subagent-strip-model";
import { TableOfContents } from "./table-of-contents";
import { ThreadMenu } from "./thread-menu";
import { Transcript, type JumpRequest } from "./transcript";
import { HeaderWakeChip } from "./wake-chip";

const FLASH_MS = 1600;

/** The transcript row holding keyboard focus, by message id. */
const focusedMessageId = (): string | undefined =>
  document.activeElement?.closest<HTMLElement>("[data-message-id]")?.dataset["messageId"];

const isControl = (target: EventTarget) =>
  target instanceof Element &&
  target.closest("button, a, input, select, textarea, [role='button'], [role='menuitem']") !== null;

/** A thread's header, transcript, cards and composer; the focused one owns the keyboard. */
export function ThreadView({
  threadId,
  focused: paneFocused,
  actions,
  onHeaderDoubleClick,
  onHeaderDragStart,
}: {
  threadId: ThreadId;
  focused: boolean;
  /** Pane controls at the end of the header. */
  actions?: ReactNode;
  /** Runs on a double-click on the header outside its controls; the grid maximizes or restores. */
  onHeaderDoubleClick?: () => void;
  /** Makes the header a drag source; the grid swaps panes on drop. */
  onHeaderDragStart?: (event: DragEvent<HTMLElement>) => void;
}) {
  // An expanded right panel covers the chat, so nothing in it answers keys: Enter would otherwise
  // approve a request nobody can see, and ⌘Enter send a draft behind the panel.
  const panelExpanded = useLayoutStore((s) => s.panelExpanded);
  const focused = paneFocused && !panelExpanded;
  const summary = useThreadsStore((s) => s.byId[threadId]);
  const titlebarThread = useTitlebarThread();
  const titlebarSlot = useTitlebarSlot((s) => s.slot);
  const titlebarFold = useTitlebarSlot((s) => s.fold);
  const soloRoute = useSoloRoute();
  const detail = useThreadsStore((s) => s.statusDetail[threadId]);
  const ready = useThreadsStore((s) => s.ready);
  const phase = useThreadFeed(threadId, (s) => s.phase);
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
  // An orchestrator's calm stream: its silent digests left out, its feature cards placed.
  const stream = useOrchestratorStream(summary?.thread, top);
  // What the transcript renders, which every index handed to it counts in: an orchestrator's
  // stream has fewer rows than `top`.
  const shown = stream?.plan.messages ?? top;
  // Rebuilt with every streamed frame, but the same chapters keep the rail from re-rendering.
  const chapters = useStable(
    useMemo(() => chaptersOf(shown), [shown]),
    sameChapters,
  );
  // Walks the whole history, so once per history change rather than on every scroll render.
  const turnEnds = useMemo(() => turnEndMessages(top), [top]);
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
  const stripLines = useMemo(
    () => stripRows(running, background ?? [], canStop),
    [running, background, canStop],
  );
  const api = useApi();
  const stopTask = (taskId: string) =>
    api.stopTask(threadId, taskId).catch((error: unknown) => {
      // Gone already, which is what Stop was for.
      if (Reflect.get(error as object, "_tag") === "NotFound") return;
      useThreadsStore.getState().applyEvent({
        type: "notify",
        kind: "error",
        title: "Couldn't stop it",
        body: errorMessage(error),
      });
      throw error;
    });
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
  const lastSubagentJump = useRef<string>(undefined);
  const [finding, setFinding] = useState(false);
  const revealRequest = useRevealStore((s) => s.request);
  const sourceTitle = useThreadsStore((s) => {
    const from = s.byId[threadId]?.thread.forkedFrom?.threadId;
    return from ? s.byId[from]?.thread.title : undefined;
  });
  const label = useThreadLabel(summary?.thread);
  const paneTitle = usePaneTitle(summary?.thread);

  // A search hit (⌘K or ⌘F) is scrolled to and flashed once the transcript has the message.
  const revealIndex =
    revealRequest?.threadId === threadId
      ? shown.findIndex((m) => m.id === revealRequest.messageId)
      : -1;
  // Loaded, though perhaps folded out of an orchestrator's stream, which no page brings back.
  const revealLoaded =
    revealRequest?.threadId === threadId && top.some((m) => m.id === revealRequest.messageId);
  const revealNonce = revealIndex === -1 ? undefined : revealRequest?.nonce;
  const revealJump = useMemo(
    () => (revealNonce === undefined ? undefined : { index: revealIndex, nonce: revealNonce }),
    [revealIndex, revealNonce],
  );
  const flashId = revealNonce === undefined ? undefined : revealRequest?.messageId;
  // A search hit older than the history loaded so far is paged in first, and again once a failed
  // page is retried.
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

  const reveal = (messageId: string) => useRevealStore.getState().reveal(threadId, messageId);

  const jumpToSubagent = (run: RunningSubagent) => {
    lastSubagentJump.current = run.toolCallId;
    // `run.index` counts in `top`; the transcript counts in what it shows.
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

  useBackToOrchestrator(threadId, focused);

  useShortcut(
    {
      id: "thread.find",
      keys: "mod+f",
      label: "Find in thread",
      group: "Thread",
      run: () => setFinding(true),
    },
    focused,
  );

  useShortcut(
    {
      id: "message.copy",
      keys: "mod+shift+c",
      label: "Copy focused message",
      group: "Thread",
      // A message counts as focused while one of its actions has keyboard focus.
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
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  const { thread, status } = summary;
  const pr = summary.git?.pr;
  // The badge's PR as the badge paints it: anchored when the thread is bound to that very PR.
  const shownPr = targetBadge(summary.git, thread.boundPr) ?? pr;
  // It rings while it needs you, by the test the sidebar and the window title count by.
  const needs = needsYou(summary) || summary.pendingRequests.length > 0;
  const activity = activityLine(status, detail, summary.activity);
  const display = threadStatusOf(summary, detail);
  const tint = label === undefined ? undefined : labelTint(label.color);
  // A thread alone in Chat puts its header in the window's title bar: one bar, not two. The
  // title and the empty room move the window; everything after the title is a control.
  const inTitlebar = titlebarSlot !== null && titlebarThread === threadId && actions === undefined;
  // The chips drop by the pane's width, as they did in the pane, and the title bar is as wide as
  // the pane: the header itself is narrower there, sharing the bar with the window's controls.
  const hideSm = inTitlebar ? "@max-sm/titlebar:hidden" : "@max-sm:hidden";
  // Beside the title bar's switcher, an orchestrator named for its workspace shows its glyph alone.
  const titleShown = !(inTitlebar && paneTitle.workspaceName);
  const hideMd = inTitlebar ? "@max-md/titlebar:hidden" : "@max-md:hidden";

  const header = (
    <AttentionPulse
      active={needs}
      // In the title bar the ring rounds and insets, so it marks the thread rather than boxing in
      // part of the window's bar.
      className={cn(
        "@container",
        inTitlebar ? "my-1 flex min-w-0 flex-1 rounded-(--radius-md)" : "shrink-0",
      )}
    >
      <header
        data-testid="pane-header"
        draggable={onHeaderDragStart !== undefined}
        onDragStart={onHeaderDragStart}
        // A double-click selects a word first; keep the selection out of the maximize gesture.
        onMouseDown={(event) => {
          if (onHeaderDoubleClick && event.detail > 1 && !isControl(event.target)) {
            event.preventDefault();
          }
        }}
        onDoubleClick={(event) => {
          if (onHeaderDoubleClick && !isControl(event.target)) onHeaderDoubleClick();
        }}
        data-label-tint={tint === undefined ? undefined : label?.name}
        style={tint === undefined ? undefined : ({ "--label-tint": tint } as CSSProperties)}
        data-in-titlebar={inTitlebar || undefined}
        className={cn(
          "flex items-center gap-2 text-sm",
          inTitlebar
            ? "relative h-full min-w-0 flex-1 rounded-[inherit] pr-1 pl-2 [&>*:not(:first-child)]:[-webkit-app-region:no-drag]"
            : "h-10 border-b border-border px-4 @max-sm:px-2",
          tint !== undefined &&
            "bg-[color-mix(in_oklab,var(--label-tint)_8%,transparent)] shadow-[inset_3px_0_0_var(--label-tint)]",
        )}
      >
        {/* The title truncates before any chip goes, and the chips drop whole rather than clip:
              they wrap, the fixed height hides every line after the first, and what wraps is
              inert. What drops is in the thread menu or the PR row too. The cap keeps the title
              at least 40% of the room. */}
        <div
          // In the title bar, the room the bar folds its lesser buttons to keep: a few letters of
          // the title, or the orchestrator's glyph and a chip when the switcher has its name.
          data-titlebar-room={inTitlebar ? (titleShown ? 96 : 48) : undefined}
          // Shorter still, the title is cut rather than run under the controls after it.
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
            className={cn(
              "flex h-6 max-w-[60%] min-w-0 shrink-[0.01] flex-wrap items-center gap-x-2 gap-y-4 overflow-hidden",
              // Chips that wrapped out of sight still widen the row, so in the title bar, which it
              // shares with the window's controls, the title keeps the larger share, and narrow
              // the chips go: the PR row, the right panel and the thread menu have the rest.
              inTitlebar && "[-webkit-app-region:no-drag]",
              inTitlebar && titleShown && "max-w-[40%] @max-sm:max-w-[30%]",
              // An orchestrator's title is the switcher's, so its chips have the room.
              inTitlebar && !titleShown && "max-w-none shrink",
              // Wrapped, the first line is as tall as the row, so its chips stay centred on it.
              inTitlebar && "before:-mr-2 before:h-6 before:w-0 before:content-['']",
            )}
          >
            <WorkerNowChip thread={thread} />
            <OrchestratorChips thread={thread} inTitlebar={inTitlebar} />
            {thread.forkedFrom && (
              <ForkedFrom from={thread.forkedFrom} title={sourceTitle} hideClass={hideMd} />
            )}
            {label && (
              <LabelChip
                label={label}
                testId="pane-label"
                compact
                className={cn("text-xs text-muted-foreground", hideMd)}
              />
            )}
            {/* The branch is the agents' working detail, not the thread's name: the thread menu
                  has it, to read and copy. */}
            <WorktreeMissingChip
              git={summary.git}
              testId="pane-folder-missing"
              className={cn("text-xs", hideSm)}
            />
            {pr && summary.git?.pr && (
              <ContextMenu>
                <ContextMenuTrigger className="flex shrink-0">
                  <PrBadge
                    threadId={threadId}
                    git={summary.git}
                    thread={thread}
                    testId="pane-pr-badge"
                    className="text-xs text-muted-foreground"
                  />
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <PrBadgeMenuItems threadId={threadId} pr={summary.git.pr} />
                </ContextMenuContent>
              </ContextMenu>
            )}
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
            <PrElsewhereChip
              git={summary.git}
              threadId={threadId}
              testId="pane-pr-elsewhere"
              compact
              className={cn("text-xs text-muted-foreground", hideMd)}
            />
            <PortChips
              threadId={threadId}
              ports={summary.ports}
              className={cn("text-xs text-muted-foreground", hideSm)}
            />
            <HeaderWakeChip threadId={threadId} />
            <FakeAgentBadge className={hideSm} />
          </div>
        </div>
        {/* Outside the chips that drop when short of room: Hand back must always be there. */}
        <WorkerActions thread={thread} inTitlebar={inTitlebar} />
        <Hint
          label={statusHint(display, activity)}
          side="bottom"
          render={<span data-testid="pane-status" className="relative flex shrink-0" />}
        >
          <Swap swapKey={display.label}>
            <display.icon
              aria-hidden
              data-testid="status-icon"
              data-working={display.working}
              data-running={display.running}
              className={cn("size-3.5", display.tone)}
            />
          </Swap>
          <RunningCount count={display.running} />
          <span className="sr-only">{display.label}</span>
        </Hint>
        <TableOfContents
          chapters={chapters}
          onJump={jumpToChapter}
          earlier={earlier}
          loadingEarlier={loadingEarlier}
          earlierFailed={earlierFailed}
          onLoadEarlier={() => void pageEarlier(true)}
        />
        {/* A narrow title bar's folded buttons are this menu's while the header is the bar's. */}
        <ThreadMenu
          threadId={threadId}
          folded={
            inTitlebar && titlebarFold > 0
              ? { orchestration: !soloRoute, worker: titlebarFold >= FOLD_ALL }
              : undefined
          }
        />
        {actions}
      </header>
    </AttentionPulse>
  );

  return (
    <div
      ref={trackPaneHeight}
      data-pane-root
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
          className="shrink-0 px-4 py-2 text-xs wrap-anywhere text-muted-foreground"
        >
          {detail}
        </p>
      )}
      <WaitingTray threadId={threadId} />
      <PlanStrip threadId={threadId} />
      <WorkerBanner thread={thread} />
      <CatchUpCard thread={thread} />
      <StuckCard thread={thread} />
      <OrchestratorBanner thread={thread} />
      {finding && (
        <FindBar threadId={threadId} onReveal={reveal} onClose={() => setFinding(false)} />
      )}
      <OrchestratorStreamProvider stream={stream}>
        <Transcript
          threadId={threadId}
          loading={phase === "loading"}
          messages={shown}
          subagents={children}
          subagentUsage={subagentUsage}
          streamingIds={streamingSet}
          turnEnds={turnEnds}
          animate={focused}
          jump={chapterJump}
          chapters={chapters}
          onChapterJump={jumpToChapter}
          reveal={revealJump}
          flashId={flashId}
          earlier={earlier}
          loadingEarlier={loadingEarlier}
          earlierFailed={earlierFailed}
          onLoadEarlier={(retry) => void pageEarlier(retry)}
          live={thread.spawnedBy !== undefined}
        />
      </OrchestratorStreamProvider>
      <div className="mx-auto w-full max-w-(--thread-max-width) shrink-0 px-6">
        {/* A worker opens on its catch-up instead, whose words send nothing to it. */}
        {thread.role === "orchestrator" && <BriefingPlaceholder thread={thread} />}
        {thread.spawnedBy === undefined && <RecapCard threadId={threadId} focused={focused} />}
        <RequestCards
          threadId={threadId}
          // An orchestrator's ask stack answers the requests it can, so each shows in one place.
          requests={
            thread.role === "orchestrator"
              ? summary.pendingRequests.filter((request) => !answersInPlace(request))
              : summary.pendingRequests
          }
          focused={focused}
          thread={thread}
        />
        <LimitWaitLine thread={thread} />
        <QueueList threadId={threadId} />
      </div>
      <FolderMissingNotice threadId={threadId} />
      <MergedCleanupNotice threadId={threadId} />
      <LapsedConnectorsNotice threadId={threadId} />
      <EditBanner threadId={threadId} />
      <PrStrip threadId={threadId} focused={focused} />
      <SubagentStrip rows={stripLines} onJump={jumpToSubagent} onStop={stopTask} />
      {stream !== undefined && (
        <SinceYouLeftCard
          key={`since-you-left:${thread.id}`}
          thread={thread}
          digests={stream.plan.digests}
        />
      )}
      {thread.role === "orchestrator" && (
        <AskStack workspaceId={thread.workspaceId} composerThreadId={thread.id} focused={focused} />
      )}
      <TurnCompleteSheen key={threadId} status={status}>
        <Composer threadId={threadId} focused={focused} />
      </TurnCompleteSheen>
    </div>
  );
}

function ForkedFrom({
  from,
  title,
  hideClass,
}: {
  from: NonNullable<Thread["forkedFrom"]>;
  title: string | undefined;
  /** The container query that drops it when narrow. */
  hideClass: string;
}) {
  const label = forkedFromText(from, title);
  const className = cn("flex shrink-0 items-center text-muted-foreground", hideClass);
  const body = (
    <>
      <GitFork aria-hidden className="size-3.5" />
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

/**
 * The pane's heading: the role's glyph and the title. An orchestrator opened as
 * `Orchestrator · <workspace>` shows the workspace's name alone, as its glyph says the rest: the
 * current one, or with workspaces off or not loaded yet, the one it was opened under. The heading's
 * name spells the role out, since the glyph's words would run into the title.
 */
/** The pane's title, and whether it is the orchestrator's workspace's name, as the switcher says. */
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
  /** False beside the title bar's workspace switcher, which says an orchestrator's name already. */
  titleShown: boolean;
}) {
  const role = useThreadRole(thread);
  const { title } = usePaneTitle(thread);
  return (
    <h1
      aria-label={role === undefined ? undefined : `${role.name}: ${title}`}
      className="flex min-w-0 items-center gap-1.5 font-heading font-medium"
      title={
        gestures ? `${title}. Double-click to maximize or restore; drag to swap panes` : undefined
      }
    >
      <RoleGlyph thread={thread} testId="pane-role" />
      <span className={titleShown ? "truncate" : "sr-only"}>{title}</span>
    </h1>
  );
}

/**
 * A thread the server no longer has: closed or deleted elsewhere, or a stale link. A worker closed
 * with its worktree stays readable from what Gram kept of it.
 */
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
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
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
      className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground"
    >
      <MessageSquareOff aria-hidden className="size-6" />
      <p>This thread no longer exists.</p>
      <Button variant="outline" size="sm" onClick={close}>
        <X data-icon="inline-start" />
        Close
      </Button>
    </div>
  );
}
