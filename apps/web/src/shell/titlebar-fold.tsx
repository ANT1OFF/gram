import { Menu } from "@base-ui/react/menu";
import type { GridPreset, ThreadId, WorkspaceState } from "@gram/contracts";
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
  LayoutGrid,
  Moon,
  Rows3,
  Settings2,
  Users,
} from "lucide-react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { useHistoryStore } from "@/history/history-view";
import { useShortcutHint } from "@/keyboard/use-shortcut-hint";
import { MENU_ITEM, MENU_LABEL, MENU_POPUP } from "@/lib/selection";
import { cn } from "@/lib/utils";
import { useTidyUp } from "@/orchestration/use-board-actions";
import { WorkerMenuItems } from "@/orchestration/worker-header";
import { useWorkersListStore, useWorkersNow } from "@/orchestration/workers-list";
import { useWorkspacePause } from "@/orchestration/workspace-pause-button";
import { RunScriptMenuItems } from "@/scripts/run-script-menu";
import { openWorkspaceSettings } from "@/settings/workspace-sheet";
import { GRID_PRESETS, PRESET_LABELS, useLayoutStore, type BoardLayout } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { pauseClock } from "@/thread/orchestration-model";
import { useThreadMenu } from "@/thread/thread-menu";
import { useViewStore } from "@/views/view-store";
import { useViewWorkspace } from "@/views/view-workspace";

import { PresetGlyph } from "./preset-glyph";
import { useTitlebarOutline } from "./titlebar-outline";
import { FOLD_ALL, useTitlebarSlot, useTitlebarThread } from "./titlebar-slot";

// The title bar's one "…": everything the bar keeps out of sight, each item with its words and its
// shortcut. The thread the bar carries first (its Contents, scripts and the thread menu's verbs),
// then the workspace's (Workers, Tidy up, Pause, Memory, its settings), then the window's (Quiet,
// focus mode, History, the layout). A narrow bar folds a worker's own actions and Board's layout
// into it too. Each item does what its button did.

const SEPARATOR = <div role="separator" className="-mx-1 my-1 h-px bg-border" />;

const TIDY_HINT =
  "Ask the orchestrator to archive what's done, fix groups, stages and plans, close settled questions and refresh its memory";

/** An item's shortcut, right-aligned as the palette shows it. */
function Keys({ id }: { id: string }) {
  const hint = useShortcutHint(id);
  return hint ? <span className="ml-auto pl-4 text-xs text-muted-foreground">{hint}</span> : null;
}

/** A submenu's current value, right-aligned before its chevron. */
function Current({ children }: { children: ReactNode }) {
  return (
    <span className="ml-auto max-w-32 truncate pl-4 text-xs text-muted-foreground">{children}</span>
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
      <div className="px-2 py-1 text-xs text-muted-foreground">Loaded prompts and chapters</div>
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
 * The workspace's Tidy up, held by the bar rather than the menu, so what was just sent outlasts
 * the menu closing: reopened, it still says it asked, and rests until it may ask again.
 */
const TidyContext = createContext<ReturnType<typeof useTidyUp> | undefined>(undefined);

export function TidyScope({ state, children }: { state: WorkspaceState; children: ReactNode }) {
  const tidy = useTidyUp(state);
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
  return <TidyContext value={tidy}>{children}</TidyContext>;
}

export function TidyItem() {
  const tidy = useContext(TidyContext);
  if (tidy === undefined) return null;
  return (
    <Menu.Item
      data-testid="folded-tidy"
      data-sent={tidy.sent}
      disabled={tidy.blocked !== undefined || tidy.resting}
      title={TIDY_HINT}
      className={MENU_ITEM}
      onClick={() => void tidy.send()}
    >
      <BroomSparkles aria-hidden />
      {/* A disabled item shows no tooltip, so it says why it is off. */}
      {tidy.blocked === undefined ? (
        tidy.sent === undefined ? (
          "Tidy up"
        ) : (
          "Asked to tidy up"
        )
      ) : (
        <span className="flex min-w-0 flex-col">
          Tidy up
          <span className="text-xs text-muted-foreground">{tidy.blocked}</span>
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
        className={MENU_ITEM}
        onClick={() => run(false)}
      >
        <CirclePlay aria-hidden />
        Resume workspace
        <Current>since {pauseClock(state.paused.at)}</Current>
      </Menu.Item>
    );
  }
  if (confirming && confirm !== undefined) {
    return (
      <div data-testid="folded-pause-confirm" className="flex max-w-72 flex-col gap-0.5">
        <p className="px-2 py-1 text-xs text-muted-foreground">{confirm}</p>
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
      title="The orchestrator and its workers finish the step they're on and stop, and nothing wakes them until you resume"
      className={MENU_ITEM}
      onClick={() => (confirm === undefined ? run(true) : setConfirming(true))}
    >
      <CirclePause aria-hidden />
      {confirm === undefined ? "Pause workspace" : "Pause workspace…"}
    </Menu.Item>
  );
}

/** The workspace's own: Workers, Tidy up, Pause, Memory and its settings. */
function WorkspaceItems({ state, opening }: { state: WorkspaceState; opening: number }) {
  const navigate = useNavigate();
  const { count } = useWorkersNow();
  const workspaceId = state.workspace.id;
  return (
    <Menu.Group data-testid="titlebar-menu-workspace">
      <Menu.GroupLabel className={MENU_LABEL}>{state.workspace.name}</Menu.GroupLabel>
      <Menu.Item
        data-testid="folded-workers"
        className={MENU_ITEM}
        onClick={() => useWorkersListStore.getState().toggle()}
      >
        <Users aria-hidden />
        Workers
        {count > 0 && (
          <span className="text-xs text-muted-foreground tabular-nums">{count} now</span>
        )}
        <Keys id="workers.open" />
      </Menu.Item>
      <TidyItem />
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
    </Menu.Group>
  );
}

/** The window's own: Board's layout when folded, Quiet, focus mode, History and the layout. */
function ViewItems() {
  const state = useViewWorkspace();
  const preset = useLayoutStore((s) => s.grid.preset);
  const focusMode = useLayoutStore((s) => s.focusMode);
  const fold = useTitlebarSlot((s) => s.fold);
  // The Board's Grid or Lanes, folded out of its header with the lesser buttons.
  const board = useViewStore((s) => s.view === "board") && state !== undefined && fold > 0;
  const boardLayout = useLayoutStore((s) => s.boardLayout);
  return (
    <Menu.Group data-testid="titlebar-menu-view">
      <Menu.GroupLabel className={MENU_LABEL}>View</Menu.GroupLabel>
      {board && (
        <Menu.RadioGroup
          data-testid="folded-board-layout"
          value={boardLayout}
          onValueChange={(next: BoardLayout) => useLayoutStore.getState().setBoardLayout(next)}
        >
          {(
            [
              ["grid", "Board as grid", Rows3],
              ["lanes", "Board as lanes", Columns3],
            ] as const
          ).map(([value, label, Icon]) => (
            <Menu.RadioItem key={value} value={value} closeOnClick className={MENU_ITEM}>
              <Icon aria-hidden />
              {label}
              <span className="ml-auto flex size-3.5 items-center justify-center pl-4">
                <Menu.RadioItemIndicator>
                  <CheckIcon aria-hidden />
                </Menu.RadioItemIndicator>
              </span>
            </Menu.RadioItem>
          ))}
        </Menu.RadioGroup>
      )}
      <Menu.Item
        data-testid="folded-quiet"
        title="Show only what needs you, one card at a time"
        className={MENU_ITEM}
        onClick={() => useViewStore.getState().setQuiet(true)}
      >
        <Moon aria-hidden />
        Quiet
        <Keys id="view.quiet" />
      </Menu.Item>
      <Menu.Item
        data-testid="folded-focus"
        className={MENU_ITEM}
        onClick={() => useLayoutStore.getState().toggleFocusMode()}
      >
        <Focus aria-hidden />
        {focusMode ? "Leave focus mode" : "Focus mode"}
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
      <Submenu
        label="Layout"
        testId="menu-layout"
        icon={<LayoutGrid aria-hidden />}
        current={PRESET_LABELS[preset]}
      >
        <Menu.RadioGroup
          data-testid="folded-layout"
          value={preset}
          onValueChange={(next: GridPreset) => useLayoutStore.getState().setPreset(next)}
        >
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
              <span className="flex size-3.5 items-center justify-center">
                <Menu.RadioItemIndicator>
                  <CheckIcon aria-hidden />
                </Menu.RadioItemIndicator>
              </span>
            </Menu.RadioItem>
          ))}
        </Menu.RadioGroup>
      </Submenu>
    </Menu.Group>
  );
}

/** The thread the bar carries: Contents, its scripts, a folded worker's actions, then its menu. */
function ThreadItems({ threadId, items }: { threadId: ThreadId; items: ReactNode }) {
  const fold = useTitlebarSlot((s) => s.fold);
  const thread = useThreadsStore((s) => s.byId[threadId]?.thread);
  if (thread === undefined) return null;
  return (
    <Menu.Group data-testid="titlebar-menu-thread">
      <Menu.GroupLabel className={cn(MENU_LABEL, "max-w-64 truncate")}>
        {thread.role === "orchestrator" ? "Orchestrator" : thread.title || "Thread"}
      </Menu.GroupLabel>
      {/* A worker in the bar folded all the way: its own actions are this menu's. */}
      {fold >= FOLD_ALL && thread.spawnedBy !== undefined && (
        <WorkerMenuItems thread={thread} itemClassName={MENU_ITEM} />
      )}
      <ContentsSubmenu threadId={threadId} />
      {thread.role !== "orchestrator" && (
        <RunScriptMenuItems
          threadId={thread.id}
          projectId={thread.projectId}
          itemClassName={MENU_ITEM}
        />
      )}
      {items}
    </Menu.Group>
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
  // How many times the menu has opened: what it asked last time doesn't carry over.
  const [opening, setOpening] = useState(0);
  const menu = (
    <Menu.Root
      onOpenChange={(open) => {
        if (open) setOpening((n) => n + 1);
      }}
    >
      <Hint
        label={"More\nThe thread's, the workspace's and the window's controls"}
        side="bottom"
        render={
          <Menu.Trigger
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
      </Hint>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className="isolate z-50 outline-none">
          <Menu.Popup
            data-testid="titlebar-overflow-menu"
            className={cn(MENU_POPUP, "max-h-(--available-height) w-64 overflow-y-auto")}
          >
            <div data-testid="titlebar-folded" role="group" aria-label="Title bar">
              {thread !== undefined && (
                <>
                  <ThreadItems threadId={thread.id} items={thread.items} />
                  {SEPARATOR}
                </>
              )}
              {workspace && (
                <>
                  <WorkspaceItems key={state.workspace.id} state={state} opening={opening} />
                  {SEPARATOR}
                </>
              )}
              <ViewItems />
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
