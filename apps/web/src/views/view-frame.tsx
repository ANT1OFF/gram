import type { ThreadId } from "@gram/contracts";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { Moon } from "lucide-react";
import { useEffect, useId, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { useShortcut } from "@/keyboard/registry";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
import { radioGroupKeyDown } from "@/lib/list-keys";
import { cn } from "@/lib/utils";
import { SegmentSlab, Swap } from "@/motion";
import {
  openNeedsYou,
  setNeedsYouStepper,
  useNeedsYouList,
  useNeedsYouStep,
} from "@/orchestration/use-needs-you";
import { nextNeedsYou } from "@/sidebar/grouping";
import { useThreadsStore } from "@/stores/threads";

import { BoardView } from "./board-view";
import { QuietView, useQuietMode } from "./quiet-view";
import { APP_VIEWS, useViewStore, VIEW_LABELS, type AppView } from "./view-store";
import { useViewWorkspace } from "./view-workspace";

// The frame Chat, Board and Quiet share: the title bar's switcher and Quiet toggle, the
// main area each view mounts in, and their keys. A view itself lives in its own file.

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

  const over = view !== "chat";
  const workspaceId = workspace?.workspace.id;
  return (
    <div data-view={view} className="relative flex min-h-0 flex-1 flex-col">
      <div
        inert={over}
        aria-hidden={over || undefined}
        className={cn("flex min-h-0 flex-1 flex-col", over && "invisible")}
      >
        {children}
      </div>
      <Swap
        swapKey={over ? view : undefined}
        as="div"
        className="absolute inset-0 flex min-h-0 flex-col bg-thread"
      >
        <div data-testid={`view-${view}`} className="flex min-h-0 flex-1 flex-col">
          <BoardView workspaceId={workspaceId} />
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
  return (
    <Swap
      swapKey={quiet ? "quiet" : undefined}
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
          Leave quiet
          {hint && <kbd className="font-sans text-[11px] opacity-70">{hint}</kbd>}
        </Button>
      </div>
      <QuietView workspaceId={workspace?.workspace.id} />
    </Swap>
  );
}

/** Chat · Board in the title bar. */
export function ViewSwitcher({ className }: { className?: string }) {
  const view = useViewStore((s) => s.view);
  const setView = useViewStore((s) => s.setView);
  const hasWorkspace = useViewWorkspace() !== undefined;
  const slab = useId();
  const available = APP_VIEWS.filter((each) => viewAvailable(each, hasWorkspace));
  return (
    <div
      role="radiogroup"
      aria-label="View"
      data-testid="view-switcher"
      className={cn("isolate flex items-center gap-0.5", className)}
      onKeyDown={(event) => radioGroupKeyDown(event, available, view, setView)}
    >
      {APP_VIEWS.map((each) => (
        <ViewSegment
          key={each}
          view={each}
          shortcutId={`view.${each}`}
          checked={view === each}
          disabled={!available.includes(each)}
          slab={slab}
          onPick={() => setView(each)}
        />
      ))}
    </div>
  );
}

function ViewSegment({
  view,
  shortcutId,
  checked,
  disabled,
  slab,
  onPick,
}: {
  view: AppView;
  shortcutId: string;
  checked: boolean;
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
      tabIndex={checked ? 0 : -1}
      disabled={disabled}
      title={withHint(label, hint)}
      onClick={onPick}
      className="relative flex h-6 items-center gap-1 rounded-(--radius-sm) px-2 text-[13px] text-muted-foreground outline-none transition-colors duration-(--dur-fast) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 aria-checked:text-foreground"
    >
      {checked && <SegmentSlab group={slab} className="bg-muted" />}
      {label}
    </button>
  );
}

/** The title bar's way into Quiet. */
export function QuietToggle({ className }: { className?: string }) {
  const hint = useShortcutHint("view.quiet");
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label="Quiet"
      title={withHint("Quiet", hint)}
      data-testid="quiet-toggle"
      className={cn("text-muted-foreground", className)}
      onClick={() => useViewStore.getState().setQuiet(true)}
    >
      <Moon />
    </Button>
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
  useShortcut({
    id: "view.chat",
    keys: "mod+alt+1",
    label: "Chat",
    group: "Navigation",
    run: pick("chat"),
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
    label: "Quiet",
    group: "Navigation",
    run: () => useViewStore.getState().toggleQuiet(),
  });
  useShortcut({
    id: "quiet.leave",
    keys: "escape",
    label: "Leave quiet",
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
 * ⌘⌥3, where the Inbox's key was: opens and closes the Needs you popover. ⌘⇧U and ⌘⇧Y open the
 * next and previous item at the turn that asked, from anywhere; with nothing listed, ⌘⇧U still goes
 * to the next thread the sidebar marks as needing you. A component of its own, so the list's every
 * change re-renders only it, never the shell that mounts it.
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
    id: "view.needsYou",
    keys: "mod+alt+3",
    label: "Needs you",
    group: "Navigation",
    // Again from inside the popover closes it.
    allowInDialogs: true,
    run: openNeedsYou,
  });
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
