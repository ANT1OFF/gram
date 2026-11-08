import { Menu } from "@base-ui/react/menu";
import type { GridPreset, ProjectId, ThreadId, WorkspaceState } from "@gram/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  BookOpen,
  Brain,
  BroomSparkles,
  CheckIcon,
  ChevronRightIcon,
  CirclePause,
  CirclePlay,
  Columns3,
  Ellipsis,
  Focus,
  History,
  MessageSquare,
  Moon,
  Network,
  PanelsTopLeft,
  Play,
  Rows3,
  Settings2,
  Telescope,
  Workflow,
} from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { useHistoryStore } from "@/history/history-view";
import { useShortcutHint } from "@/keyboard/use-shortcut-hint";
import { MENU_ITEM, MENU_LABEL, MENU_POPUP } from "@/lib/selection";
import { EXPLAIN } from "@/lib/explain";
import { seeTerm } from "@/lib/first-use";
import { cn } from "@/lib/utils";
import { DISCOVER_QUEUED, DISCOVER_SENT } from "@/orchestration/board-model";
import { useDiscover, useTidyUp } from "@/orchestration/use-board-actions";
import { WorkerMenuItems } from "@/orchestration/worker-header";
import { showWorkersTab, useWorkersNow } from "@/orchestration/workers-tab";
import { useWorkspacePause } from "@/orchestration/workspace-pause-button";
import { RunScriptMenuItems } from "@/scripts/run-script-menu";
import { useProjectScripts } from "@/scripts/use-project-scripts";
import { openWorkspaceSettings } from "@/settings/workspace-sheet";
import { GRID_PRESETS, PRESET_LABELS, useLayoutStore, type BoardLayout } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { pauseClock } from "@/thread/orchestration-model";
import { AllActivityItem, useThreadMenu } from "@/thread/thread-menu";
import { useViewStore } from "@/views/view-store";
import { useViewWorkspace } from "@/views/view-workspace";

import { PresetGlyph } from "./preset-glyph";
import { useTitlebarOutline } from "./titlebar-outline";
import { FOLD_ALL, useTitlebarSlot, useTitlebarThread } from "./titlebar-slot";

// The title bar's one "…": everything the bar keeps out of sight, each item with its words and its
// shortcut, and like every menu at most seven items. The carried thread's menu (and its scripts),
// Workers, the workspace's (Tidy up, Discover, Pause, Memory, its settings) and the window's (Contents,
// Quiet, focus mode, History, the layout), the groups each a submenu. A narrow bar folds a worker's
// own actions and Board's layout into it too. Each item does what its button did.

const SEPARATOR = <div role="separator" className="-mx-1 my-1 h-px bg-border" />;

/** How soon after the menu closes a focus on its trigger is the one it handed back. */
const FOCUS_RETURN_MS = 500;

/**
 * A menu item's words and, under them, one line on what it does: for Gram's own words, whose
 * meaning a name alone doesn't carry (`EXPLAIN`).
 */
function Described({ label, line }: { label: ReactNode; line: string }) {
  return (
    <span className="flex max-w-64 min-w-0 flex-col">
      {label}
      {/* Its item's description, not part of its name: the item carries it as aria-description. */}
      <span
        aria-hidden
        data-testid="menu-item-line"
        className="text-meta whitespace-normal text-muted-foreground"
      >
        {line}
      </span>
    </span>
  );
}

/** An item's shortcut, right-aligned as the palette shows it. */
function Keys({ id }: { id: string }) {
  const hint = useShortcutHint(id);
  return hint ? <span className="ml-auto pl-4 text-meta text-muted-foreground">{hint}</span> : null;
}

/** A submenu's current value, right-aligned before its chevron. */
function Current({ children }: { children: ReactNode }) {
  return (
    <span className="ml-auto max-w-32 truncate pl-4 text-meta text-muted-foreground">
      {children}
    </span>
  );
}

function Submenu({
  label,
  icon,
  current,
  testId,
  popupTestId,
  popupLabel = label,
  children,
}: {
  label: string;
  icon: ReactNode;
  current?: ReactNode;
  testId: string;
  popupTestId?: string;
  popupLabel?: string;
  children: ReactNode;
}) {
  return (
    <Menu.SubmenuRoot>
      <Menu.SubmenuTrigger
        data-testid={testId}
        className={cn(MENU_ITEM, "data-[popup-open]:row-cursor")}
      >
        {icon}
        {label}
        {current === undefined ? <span className="ml-auto" /> : <Current>{current}</Current>}
        <ChevronRightIcon aria-hidden className="text-muted-foreground" />
      </Menu.SubmenuTrigger>
      <Menu.Portal>
        <Menu.Positioner
          side="left"
          align="start"
          alignOffset={-4}
          className="isolate z-50 outline-none"
        >
          <Menu.Popup
            data-testid={popupTestId}
            aria-label={popupLabel}
            className={cn(MENU_POPUP, "max-h-80 overflow-y-auto")}
          >
            {children}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
  );
}

/** The carried thread's chapters, as its header's Contents button listed them. */
function ContentsSubmenu({ threadId }: { threadId: ThreadId }) {
  const outline = useTitlebarOutline((s) =>
    s.outline?.threadId === threadId ? s.outline : undefined,
  );
  if (outline === undefined || (outline.chapters.length === 0 && !outline.earlier)) return null;
  return (
    <Submenu
      label="Contents"
      testId="menu-contents"
      popupTestId="toc"
      popupLabel="Loaded conversation"
      icon={<BookOpen aria-hidden />}
      current={outline.chapters.length === 0 ? undefined : outline.chapters.length}
    >
      <div className="px-2 py-1 text-meta text-muted-foreground">Loaded prompts and chapters</div>
      {outline.earlier && outline.onLoadEarlier && (
        <Menu.Item
          className={MENU_ITEM}
          disabled={outline.loadingEarlier}
          onClick={outline.onLoadEarlier}
        >
          {outline.loadingEarlier
            ? "Loading earlier prompts and chapters…"
            : outline.earlierFailed
              ? "Couldn't load earlier prompts and chapters. Try again"
              : "Load earlier prompts and chapters"}
        </Menu.Item>
      )}
      {outline.chapters.map((chapter) => (
        <Menu.Item
          key={chapter.id}
          className={cn(MENU_ITEM, "w-72 max-w-[calc(100vw-2rem)] wrap-anywhere")}
          onClick={() => outline.jump(chapter.messageId)}
        >
          {chapter.title}
        </Menu.Item>
      ))}
    </Submenu>
  );
}

/**
 * The workspace's Tidy up and Discover, held by the bar rather than the menu, so what was just sent
 * outlasts the menu closing: reopened, it still says it asked, and rests until it may ask again.
 */
const TidyContext = createContext<ReturnType<typeof useTidyUp> | undefined>(undefined);
const DiscoverContext = createContext<ReturnType<typeof useDiscover> | undefined>(undefined);

export function TidyScope({ state, children }: { state: WorkspaceState; children: ReactNode }) {
  const tidy = useTidyUp(state);
  const discover = useDiscover(state);
  useEffect(() => {
    if (discover.sent === undefined) return;
    useThreadsStore.getState().applyEvent({
      type: "notify",
      kind: "info",
      title: "Asked the orchestrator to discover the workspace",
      body: discover.sent === "queued" ? DISCOVER_QUEUED : DISCOVER_SENT,
    });
  }, [discover.sent]);
  // The menu has closed by the time it goes: a toast says so, as the palette's Tidy up does.
  useEffect(() => {
    if (tidy.sent === undefined) return;
    useThreadsStore.getState().applyEvent({
      type: "notify",
      kind: "info",
      title: "Asked the orchestrator to tidy up",
      body:
        tidy.sent === "queued"
          ? "It starts once its current turn ends."
          : "It summarises what it changed when it is done.",
    });
  }, [tidy.sent]);
  return (
    <TidyContext value={tidy}>
      <DiscoverContext value={discover}>{children}</DiscoverContext>
    </TidyContext>
  );
}

export function DiscoverItem() {
  const discover = useContext(DiscoverContext);
  if (discover === undefined) return null;
  return (
    <Menu.Item
      data-testid="folded-discover"
      data-sent={discover.sent}
      disabled={discover.blocked !== undefined || discover.resting}
      aria-description={
        discover.blocked === undefined && discover.sent === undefined ? EXPLAIN.discover : undefined
      }
      className={cn(MENU_ITEM, "items-start")}
      onClick={() => void discover.send()}
    >
      <Telescope aria-hidden className="mt-0.5" />
      {/* A disabled item shows no tooltip, so it says why it is off. */}
      {discover.blocked === undefined ? (
        discover.sent === undefined ? (
          <Described label="Discover workspace" line={EXPLAIN.discover} />
        ) : (
          "Asked to discover"
        )
      ) : (
        <span className="flex min-w-0 flex-col">
          Discover workspace
          <span className="text-meta text-muted-foreground">{discover.blocked}</span>
        </span>
      )}
    </Menu.Item>
  );
}

export function TidyItem() {
  const tidy = useContext(TidyContext);
  if (tidy === undefined) return null;
  return (
    <Menu.Item
      data-testid="folded-tidy"
      data-sent={tidy.sent}
      disabled={tidy.blocked !== undefined || tidy.resting}
      aria-description={
        tidy.blocked === undefined && tidy.sent === undefined ? EXPLAIN.tidyUp : undefined
      }
      className={cn(MENU_ITEM, "items-start")}
      onClick={() => void tidy.send()}
    >
      <BroomSparkles aria-hidden className="mt-0.5" />
      {/* A disabled item shows no tooltip, so it says why it is off. */}
      {tidy.blocked === undefined ? (
        tidy.sent === undefined ? (
          <Described label="Tidy up" line={EXPLAIN.tidyUp} />
        ) : (
          "Asked to tidy up"
        )
      ) : (
        <span className="flex min-w-0 flex-col">
          Tidy up
          <span className="text-meta text-muted-foreground">{tidy.blocked}</span>
        </span>
      )}
    </Menu.Item>
  );
}

/**
 * Pause or Resume the workspace. A pause that would stop work mid-flight asks first, in the menu:
 * the item says what it stops and the next click pauses.
 */
export function PauseItem({ state }: { state: WorkspaceState }) {
  const { busy, confirm, run } = useWorkspacePause(state);
  const [confirming, setConfirming] = useState(false);
  if (state.paused !== undefined) {
    return (
      <Menu.Item
        data-testid="folded-pause"
        data-paused=""
        disabled={busy}
        aria-description={EXPLAIN.resume}
        className={cn(MENU_ITEM, "items-start")}
        onClick={() => run(false)}
      >
        <CirclePlay aria-hidden className="mt-0.5" />
        <Described label="Resume workspace" line={EXPLAIN.resume} />
        <Current>since {pauseClock(state.paused.at)}</Current>
      </Menu.Item>
    );
  }
  if (confirming && confirm !== undefined) {
    return (
      <div data-testid="folded-pause-confirm" className="flex max-w-72 flex-col gap-0.5">
        <p className="px-2 py-1 text-meta text-muted-foreground">{confirm}</p>
        <Menu.Item
          data-testid="folded-pause-confirmed"
          disabled={busy}
          className={MENU_ITEM}
          onClick={() => run(true)}
        >
          <CirclePause aria-hidden />
          Pause {state.workspace.name} anyway
        </Menu.Item>
      </div>
    );
  }
  return (
    <Menu.Item
      data-testid="folded-pause"
      disabled={busy}
      closeOnClick={confirm === undefined}
      aria-description={EXPLAIN.pause}
      className={cn(MENU_ITEM, "items-start")}
      onClick={() => (confirm === undefined ? run(true) : setConfirming(true))}
    >
      <CirclePause aria-hidden className="mt-0.5" />
      <Described
        label={confirm === undefined ? "Pause workspace" : "Pause workspace…"}
        line={EXPLAIN.pause}
      />
    </Menu.Item>
  );
}

/** Workers, the right panel's tab of the workspace's workers (⌘J), with how many are on now. */
function WorkersItem() {
  const { count } = useWorkersNow();
  return (
    <Menu.Item data-testid="folded-workers" className={MENU_ITEM} onClick={showWorkersTab}>
      <Workflow aria-hidden />
      Workers
      {count > 0 && (
        <span className="text-meta text-muted-foreground tabular-nums">{count} now</span>
      )}
      <Keys id="workers.open" />
    </Menu.Item>
  );
}

/** The workspace's own, in a submenu named for it: Tidy up, Discover, Pause, Memory and its settings. */
function WorkspaceSubmenu({ state, opening }: { state: WorkspaceState; opening: number }) {
  const navigate = useNavigate();
  const workspaceId = state.workspace.id;
  return (
    <Submenu
      label="Workspace"
      testId="menu-workspace"
      popupTestId="titlebar-menu-workspace"
      popupLabel={state.workspace.name}
      icon={<Network aria-hidden />}
      current={state.workspace.name}
    >
      <TidyItem />
      <DiscoverItem />
      {/* Each opening of the menu starts Pause unasked, whatever the last one left. */}
      <PauseItem key={`pause-${workspaceId}-${opening}`} state={state} />
      <Menu.Item
        data-testid="menu-memory"
        className={MENU_ITEM}
        onClick={() => void navigate({ to: "/w/$workspaceId/memory", params: { workspaceId } })}
      >
        <Brain aria-hidden />
        Memory
      </Menu.Item>
      <Menu.Item
        data-testid="menu-workspace-settings"
        className={MENU_ITEM}
        onClick={() => openWorkspaceSettings(workspaceId)}
      >
        <Settings2 aria-hidden />
        Workspace settings
      </Menu.Item>
    </Submenu>
  );
}

/**
 * The window's own, in a submenu: the carried thread's Contents and, on an orchestrator's
 * chat, Show all activity, then Quiet, focus mode, History, then
 * Board's layout when folded and the grid's layout, each picked with a check.
 */
function ViewSubmenu({ threadId }: { threadId: ThreadId | undefined }) {
  const state = useViewWorkspace();
  const preset = useLayoutStore((s) => s.grid.preset);
  const focusMode = useLayoutStore((s) => s.focusMode);
  const fold = useTitlebarSlot((s) => s.fold);
  // The Board's Grid or Lanes, folded out of its header with the lesser buttons.
  const board = useViewStore((s) => s.view === "board") && state !== undefined && fold > 0;
  const boardLayout = useLayoutStore((s) => s.boardLayout);
  return (
    <Submenu
      label="View"
      testId="menu-view"
      popupTestId="titlebar-menu-view"
      icon={<PanelsTopLeft aria-hidden />}
    >
      {threadId !== undefined && <ContentsSubmenu threadId={threadId} />}
      {threadId !== undefined && <AllActivityItem threadId={threadId} className={MENU_ITEM} />}
      <Menu.Item
        data-testid="folded-quiet"
        aria-description={EXPLAIN.quiet}
        className={cn(MENU_ITEM, "items-start")}
        onClick={() => {
          seeTerm("quiet");
          useViewStore.getState().setQuiet(true);
        }}
      >
        <Moon aria-hidden className="mt-0.5" />
        <Described label="Focus" line={EXPLAIN.quiet} />
        <Keys id="view.quiet" />
      </Menu.Item>
      <Menu.Item
        data-testid="folded-focus"
        className={MENU_ITEM}
        onClick={() => useLayoutStore.getState().toggleFocusMode()}
      >
        <Focus aria-hidden />
        {focusMode ? "Show side panels" : "Hide side panels"}
        <Keys id="focus.toggle" />
      </Menu.Item>
      <Menu.Item
        data-testid="menu-history"
        className={MENU_ITEM}
        // After the menu has closed and given focus back, so History's field keeps it.
        onClick={() => setTimeout(() => useHistoryStore.getState().toggle())}
      >
        <History aria-hidden />
        History
        <Keys id="history.open" />
      </Menu.Item>
      {board && (
        <>
          {SEPARATOR}
          <Menu.RadioGroup
            data-testid="folded-board-layout"
            value={boardLayout}
            onValueChange={(next: BoardLayout) => useLayoutStore.getState().setBoardLayout(next)}
          >
            <Menu.GroupLabel className={MENU_LABEL}>Board</Menu.GroupLabel>
            {(
              [
                ["grid", "Grid", Rows3],
                ["lanes", "Lanes", Columns3],
              ] as const
            ).map(([value, label, Icon]) => (
              <Menu.RadioItem key={value} value={value} closeOnClick className={MENU_ITEM}>
                <Icon aria-hidden />
                {label}
                <Check />
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
        </>
      )}
      {SEPARATOR}
      <Menu.RadioGroup
        data-testid="folded-layout"
        value={preset}
        onValueChange={(next: GridPreset) => useLayoutStore.getState().setPreset(next)}
      >
        <Menu.GroupLabel className={MENU_LABEL}>Layout</Menu.GroupLabel>
        {GRID_PRESETS.map((value, i) => (
          <Menu.RadioItem
            key={value}
            value={value}
            aria-label={PRESET_LABELS[value]}
            closeOnClick
            className={MENU_ITEM}
          >
            <PresetGlyph preset={value} />
            {PRESET_LABELS[value]}
            <Keys id={`layout.preset${i + 1}`} />
            <Check />
          </Menu.RadioItem>
        ))}
      </Menu.RadioGroup>
    </Submenu>
  );
}

/** A radio item's check, at its end: the current value's mark. */
function Check() {
  return (
    <span className="ml-auto flex size-3.5 shrink-0 items-center justify-center pl-0">
      <Menu.RadioItemIndicator>
        <CheckIcon aria-hidden />
      </Menu.RadioItemIndicator>
    </span>
  );
}

/** The carried thread's scripts, in a submenu once its project has any. */
function RunScriptSubmenu({ threadId, projectId }: { threadId: ThreadId; projectId: ProjectId }) {
  const scripts = useProjectScripts(projectId).data?.scripts ?? [];
  if (scripts.length === 0) return null;
  return (
    <Submenu
      label="Run script"
      testId="menu-run-script"
      icon={<Play aria-hidden />}
      current={scripts.length}
    >
      <RunScriptMenuItems threadId={threadId} projectId={projectId} itemClassName={MENU_ITEM} />
    </Submenu>
  );
}

/**
 * The carried thread's own: a folded worker's Open beside and Take over, its menu's verbs in a
 * submenu, and its scripts.
 */
function ThreadItems({ threadId, items }: { threadId: ThreadId; items: ReactNode }) {
  const fold = useTitlebarSlot((s) => s.fold);
  const thread = useThreadsStore((s) => s.byId[threadId]?.thread);
  if (thread === undefined) return null;
  const orchestrator = thread.role === "orchestrator";
  return (
    <>
      {/* A worker in the bar folded all the way: its own actions are this menu's, first. */}
      {fold >= FOLD_ALL && thread.spawnedBy !== undefined && (
        <WorkerMenuItems thread={thread} itemClassName={MENU_ITEM} />
      )}
      <Submenu
        label={orchestrator ? "Orchestrator" : "Thread"}
        testId="menu-thread"
        popupTestId="titlebar-menu-thread"
        icon={orchestrator ? <Network aria-hidden /> : <MessageSquare aria-hidden />}
      >
        {items}
      </Submenu>
      {!orchestrator && <RunScriptSubmenu threadId={thread.id} projectId={thread.projectId} />}
    </>
  );
}

function OverflowMenu({
  orchestration,
  thread,
  className,
}: {
  orchestration: boolean;
  thread?: { id: ThreadId; items: ReactNode } | undefined;
  className?: string | undefined;
}) {
  const state = useViewWorkspace();
  const workspace = orchestration && state !== undefined;
  const paletteHint = useShortcutHint("palette.open");
  // How many times the menu has opened: what it asked last time doesn't carry over.
  const [opening, setOpening] = useState(0);
  // The trigger's words show on hover and on Tab, but not as the menu closes and hands focus
  // back: they would stand over what is under the bar, a banner's button say, as the user goes on.
  const [hint, setHint] = useState(false);
  const closedAt = useRef(0);
  // Closed from a submenu (a chapter in View ▸ Contents, say), focus comes back here too, not to
  // the submenu's trigger that closes with it. Unless something has taken it since: Workers' list
  // or a dialog an item opened keeps it.
  const trigger = useRef<HTMLButtonElement>(null);
  const returnFocus = () => {
    const active = document.activeElement;
    const unclaimed =
      active === null || active === document.body || active.closest('[role="menu"]') !== null;
    return unclaimed ? trigger.current : false;
  };
  const menu = (
    <Menu.Root
      onOpenChange={(open) => {
        if (open) {
          setOpening((n) => n + 1);
          setHint(false);
        } else closedAt.current = performance.now();
      }}
    >
      <Tooltip
        open={hint}
        onOpenChange={(open, details) => {
          if (details.reason === "escape-key") details.allowPropagation();
          if (open && details.reason === "trigger-focus") {
            if (performance.now() - closedAt.current < FOCUS_RETURN_MS) return;
          }
          setHint(open);
        }}
      >
        <TooltipTrigger
          render={
            <Menu.Trigger
              ref={trigger}
              data-testid="titlebar-overflow"
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="More"
                  className={cn(
                    "text-muted-foreground data-popup-open:bg-muted data-popup-open:text-foreground",
                    className,
                  )}
                />
              }
            />
          }
        >
          <Ellipsis />
        </TooltipTrigger>
        <TooltipContent side="bottom" className="whitespace-pre-line">
          {`More\nThe thread's, the workspace's and the window's controls${paletteHint === "" ? "" : `\nEvery place and command: ${paletteHint}`}`}
        </TooltipContent>
      </Tooltip>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className="isolate z-50 outline-none">
          {/* At most seven items, as every menu: the thread's, the workspace's and the window's
              each a submenu of its own, Workers beside them. */}
          <Menu.Popup
            data-testid="titlebar-overflow-menu"
            finalFocus={returnFocus}
            className={cn(MENU_POPUP, "w-64")}
          >
            <div data-testid="titlebar-folded" role="group" aria-label="Title bar">
              {thread !== undefined && <ThreadItems threadId={thread.id} items={thread.items} />}
              {workspace && (
                <>
                  <WorkersItem />
                  <WorkspaceSubmenu key={state.workspace.id} state={state} opening={opening} />
                </>
              )}
              {(thread !== undefined || workspace) && SEPARATOR}
              <ViewSubmenu threadId={thread?.id} />
            </div>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
  return workspace ? (
    // A workspace switch starts the next one's Tidy up fresh, not resting on the last one's send.
    <TidyScope key={state.workspace.id} state={state}>
      {menu}
    </TidyScope>
  ) : (
    menu
  );
}

/** The bar's "…" with the carried thread's menu in it, whose dialogs outlast the menu. */
function ThreadOverflow({
  threadId,
  orchestration,
  className,
}: {
  threadId: ThreadId;
  orchestration: boolean;
  className?: string | undefined;
}) {
  const { items, aside } = useThreadMenu(threadId);
  return (
    <>
      {aside}
      <OverflowMenu
        orchestration={orchestration}
        thread={{ id: threadId, items: items(MENU_ITEM) }}
        className={className}
      />
    </>
  );
}

/**
 * The bar's one "…", before the panel toggle: the carried thread's menu, the workspace's controls
 * and the window's, each labelled, with its shortcut.
 */
export function TitlebarOverflow({
  orchestration,
  className,
}: {
  /** The bar shows a workspace's work, so its controls (Workers, Tidy up, Pause…) are here. */
  orchestration: boolean;
  className?: string;
}) {
  const carried = useTitlebarThread();
  return carried === undefined ? (
    <OverflowMenu orchestration={orchestration} className={className} />
  ) : (
    <ThreadOverflow
      key={carried}
      threadId={carried}
      orchestration={orchestration}
      className={className}
    />
  );
}
