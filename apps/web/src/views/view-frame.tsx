import type { ThreadId } from "@gram/contracts";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useId, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { useShortcut } from "@/keyboard/registry";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
import { radioGroupKeyDown } from "@/lib/list-keys";
import { lazyPart } from "@/lib/lazy-part";
import { cn } from "@/lib/utils";
import { SegmentSlab, Swap } from "@/motion";
import {
  setNeedsYouStepper,
  useNeedsYouList,
  useNeedsYouStep,
} from "@/orchestration/use-needs-you";
import { useOpenBoard } from "@/orchestration/open-board";
import { useWorkspacesQuery } from "@/orchestration/use-orchestration";
import { nextNeedsYou } from "@/sidebar/grouping";
import { useConversationOnly } from "@/stores/conversation-only";
import { useThreadsStore } from "@/stores/threads";

import { useQuietMode } from "./quiet-mode";
import {
  APP_VIEWS,
  chatRoute,
  switcherChecked,
  useViewStore,
  VIEW_LABELS,
  type AppView,
} from "./view-store";
import { useViewWorkspace } from "./view-workspace";

// The frame Chat, Board and Quiet share: the title bar's switcher and Quiet toggle, the
// main area each view mounts in, and their keys. A view itself lives in its own file, loaded apart
// from the shell; a view picked before its code is in hand shows once it is.

const boardView = lazyPart(() => import("./board-view"));
const quietView = lazyPart(() => import("./quiet-view"));

/** Board needs a workspace to show; Chat is always there. */
const viewAvailable = (view: AppView, hasWorkspace: boolean) => view !== "board" || hasWorkspace;

/**
 * The window's main area: the route (Chat) or the view picked over it. The route stays mounted
 * and laid out under another view, so coming back finds the chat as it was, scroll and all. Any
 * route change but a workspace switch goes back to Chat.
 */
export function ViewOutlet({ children }: { children: ReactNode }) {
  const view = useViewStore((s) => s.view);
  const workspace = useViewWorkspace();
  const pathname = useLocation({ select: (location) => location.pathname });
  useEffect(() => {
    useViewStore.getState().routeChanged(pathname);
  }, [pathname]);
  // A workspace removed under Board leaves nothing to show it for.
  useEffect(() => {
    if (!viewAvailable(view, workspace !== undefined)) useViewStore.getState().setView("chat");
  }, [view, workspace]);

  const board = boardView.useModule(view !== "chat");
  // Chat stays in view until the picked view can draw.
  const shown = board === undefined ? "chat" : view;
  const over = shown !== "chat";
  const workspaceId = workspace?.workspace.id;
  return (
    <div data-view={shown} className="relative flex min-h-0 flex-1 flex-col">
      <div
        inert={over}
        aria-hidden={over || undefined}
        className={cn("flex min-h-0 flex-1 flex-col", over && "invisible")}
      >
        {children}
      </div>
      <Swap
        swapKey={over ? shown : undefined}
        as="div"
        className="absolute inset-0 flex min-h-0 flex-col bg-thread"
      >
        <div data-testid={`view-${shown}`} className="flex min-h-0 flex-1 flex-col">
          {board && <board.BoardView workspaceId={workspaceId} />}
        </div>
      </Swap>
    </div>
  );
}

/**
 * Quiet, over the whole window: what `QuietView` shows, and a way out. The shell makes everything
 * under it inert.
 */
export function QuietLayer() {
  const quiet = useViewStore((s) => s.quiet);
  const workspace = useViewWorkspace();
  useQuietMode();
  const hint = useShortcutHint("quiet.leave");
  const screen = quietView.useModule(quiet);
  return (
    <Swap
      swapKey={quiet && screen !== undefined ? "quiet" : undefined}
      as="div"
      className="fixed inset-0 z-40 flex flex-col bg-thread"
    >
      <div
        data-testid="quiet-layer"
        className="flex h-(--titlebar-height) shrink-0 items-center justify-end px-2 [-webkit-app-region:drag]"
      >
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground [-webkit-app-region:no-drag]"
          onClick={() => useViewStore.getState().setQuiet(false)}
        >
          Leave Focus
          {hint && <kbd className="font-sans text-caption opacity-70 phone:hidden">{hint}</kbd>}
        </Button>
      </div>
      {screen && <screen.QuietView workspaceId={workspace?.workspace.id} />}
    </Swap>
  );
}

/**
 * Chat · Board in the title bar. On a page of its own (Settings, Memory, New) neither is marked
 * (`switcherChecked`), Chat goes back to the last chat shown, and Board opens the workspace's.
 */
export function ViewSwitcher({ className }: { className?: string }) {
  const view = useViewStore((s) => s.view);
  const setView = useViewStore((s) => s.setView);
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  const workspace = useViewWorkspace();
  const hasWorkspace = workspace !== undefined;
  const openBoard = useOpenBoard();
  const slab = useId();
  const available = APP_VIEWS.filter((each) => viewAvailable(each, hasWorkspace));
  const checked = switcherChecked(view, pathname);
  const pickView = (each: AppView) => {
    // From a page of its own the Board is its workspace's, over its orchestrator: the view alone
    // has nothing to draw over there, so the click did nothing on Memory.
    if (each === "board" && !chatRoute(pathname) && workspace !== undefined) {
      return openBoard(workspace.workspace.id);
    }
    setView(each);
    if (each === "chat" && !chatRoute(pathname)) {
      void navigate({ to: useViewStore.getState().lastChat ?? "/" });
    }
  };
  // With no workspace yet there is no Board to switch to, and Chat alone is no choice.
  const { workspaces, settled } = useWorkspacesQuery();
  if (settled && workspaces.length === 0) return null;
  return (
    <div
      role="radiogroup"
      aria-label="View"
      data-testid="view-switcher"
      className={cn("isolate flex items-center gap-0.5", className)}
      onKeyDown={(event) => radioGroupKeyDown(event, available, checked ?? view, pickView)}
    >
      {APP_VIEWS.map((each) => (
        <ViewSegment
          key={each}
          view={each}
          shortcutId={`view.${each}`}
          checked={checked === each}
          // With neither marked, Tab still lands on the first.
          focusable={checked === each || (checked === undefined && each === available[0])}
          disabled={!available.includes(each)}
          slab={slab}
          onPick={() => pickView(each)}
        />
      ))}
    </div>
  );
}

function ViewSegment({
  view,
  shortcutId,
  checked,
  focusable,
  disabled,
  slab,
  onPick,
}: {
  view: AppView;
  shortcutId: string;
  checked: boolean;
  focusable: boolean;
  disabled: boolean;
  slab: string;
  onPick: () => void;
}) {
  const hint = useShortcutHint(shortcutId);
  const label = VIEW_LABELS[view];
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      tabIndex={focusable ? 0 : -1}
      disabled={disabled}
      title={withHint(label, hint)}
      onClick={onPick}
      className="relative flex h-6 items-center gap-1 rounded-(--radius-sm) px-2 text-body text-muted-foreground outline-none transition-colors duration-(--dur-fast) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 aria-checked:text-foreground"
    >
      {checked && <SegmentSlab group={slab} className="bg-muted" />}
      {label}
    </button>
  );
}

/** A view's key: that view, out of Quiet. */
const pick = (view: AppView) => () => {
  const store = useViewStore.getState();
  store.setQuiet(false);
  store.setView(view);
};

/**
 * The views' keys. ⌘⌥1–2 pick Chat and Board (⌘⌥3 is `NeedsYouShortcut`'s) and ⌘⌥4 enters Quiet: chords that type nothing, so a focused composer
 * keeps every key it types. Esc goes back to Chat from Board, and leaves Quiet, but never from a
 * field being typed in.
 */
export function useViewShortcuts(): void {
  const hasWorkspace = useViewWorkspace() !== undefined;
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  useShortcut({
    id: "view.chat",
    keys: "mod+alt+1",
    label: "Chat",
    group: "Navigation",
    // From a page of its own, back to the last chat, as the switcher's Chat goes.
    run: () => {
      pick("chat")();
      if (!chatRoute(pathname)) void navigate({ to: useViewStore.getState().lastChat ?? "/" });
    },
  });
  useShortcut({
    id: "view.board",
    keys: "mod+alt+2",
    label: "Board",
    group: "Navigation",
    when: () => hasWorkspace,
    run: pick("board"),
  });
  useShortcut({
    id: "view.quiet",
    keys: "mod+alt+4",
    label: "Focus",
    group: "Navigation",
    run: () => useViewStore.getState().toggleQuiet(),
  });
  useShortcut({
    id: "view.conversationOnly",
    keys: "mod+alt+5",
    label: "Conversation only",
    group: "Navigation",
    run: () => useConversationOnly.getState().toggle(),
  });
  useShortcut({
    id: "quiet.leave",
    keys: "escape",
    label: "Leave Focus",
    group: "Navigation",
    // Ahead of Escape's unscoped uses, which belong to the window under it.
    focusScope: () => useViewStore.getState().quiet,
    run: () => useViewStore.getState().setQuiet(false),
  });
  useShortcut({
    id: "view.back",
    keys: "escape",
    label: "Back to Chat",
    group: "Navigation",
    focusScope: () => {
      const { view, quiet } = useViewStore.getState();
      return view !== "chat" && !quiet;
    },
    run: () => useViewStore.getState().setView("chat"),
  });
}

/**
 * ⌘⇧U and ⌘⇧Y open the Inbox's next and previous item at the turn that asked, from anywhere; with
 * nothing listed, ⌘⇧U still goes to the next thread the sidebar marks as needing you. A component
 * of its own, so the list's every change re-renders only it, never the shell that mounts it.
 */
export function NeedsYouShortcut(): null {
  const { items } = useNeedsYouList();
  const step = useNeedsYouStep(items);
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const stepOrThread = (by: 1 | -1) => {
    if (items.length > 0) return step(by);
    if (by === -1) return;
    const next = nextNeedsYou(
      Object.values(useThreadsStore.getState().byId),
      params.threadId as ThreadId | undefined,
    );
    if (next) void navigate({ to: "/t/$threadId", params: { threadId: next } });
  };
  useEffect(() => setNeedsYouStepper(stepOrThread));
  useShortcut({
    id: "thread.nextNeedsYou",
    keys: "mod+shift+u",
    label: "Next that needs you, at its turn",
    group: "Navigation",
    run: () => stepOrThread(1),
  });
  useShortcut({
    id: "needsYou.previous",
    keys: "mod+shift+y",
    label: "Previous that needs you, at its turn",
    group: "Navigation",
    when: () => items.length > 0,
    run: () => stepOrThread(-1),
  });
  return null;
}
