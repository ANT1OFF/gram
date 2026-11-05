import type { WorkspaceState } from "@gram/contracts";
import { Archive, Columns3, Hand, Pause, Rows3 } from "lucide-react";
import { createPortal } from "react-dom";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { showInbox } from "@/inbox/inbox-store";
import { cn } from "@/lib/utils";
import { midTurnWorkers } from "@/orchestration/tree-model";
import { useNeedsYouCounts } from "@/orchestration/use-needs-you";
import { Foldable } from "@/shell/foldable";
import { useTitlebarSlot } from "@/shell/titlebar-slot";
import { useLayoutStore, type BoardLayout } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { pauseClock, pauseLeavesRunning, pauseText } from "@/thread/orchestration-model";

import { useViewStore } from "./view-store";

// The Board's header: what waits on you (a link into the Inbox), Show finished, and Grid or Lanes;
// the rows below say who works. It is the window's title bar's, one bar not two: the switcher there names the workspace, and Tidy up
// and Pause or Resume are the bar's own. A pause says so in a line under it, in the shared pause
// words.

/**
 * Show finished, while the Board leaves any worker out: archived ones, and the lines whose work is
 * over, which Done lists. The workspace's choice.
 */
function FinishedToggle({ workspaceId, count }: { workspaceId: string; count: number }) {
  const shown = useLayoutStore((s) => s.boardArchivedShown.includes(workspaceId));
  if (count === 0) return null;
  const label = shown ? `Hide finished (${count})` : `Show finished (${count})`;
  return (
    <Hint
      label={label}
      side="bottom"
      render={
        <Button
          size="icon-xs"
          variant="ghost"
          data-testid="rail-show-archived"
          aria-pressed={shown}
          aria-label={`Show finished (${count})`}
          className="text-muted-foreground [-webkit-app-region:no-drag] aria-pressed:bg-accent aria-pressed:text-foreground"
          onClick={() => useLayoutStore.getState().toggleBoardArchived(workspaceId)}
        />
      }
    >
      <Archive aria-hidden />
    </Hint>
  );
}

const LAYOUTS: readonly {
  readonly layout: BoardLayout;
  readonly label: string;
  readonly hint: string;
  readonly icon: typeof Rows3;
}[] = [
  { layout: "grid", label: "Grid", hint: "A row per task", icon: Rows3 },
  { layout: "lanes", label: "Lanes", hint: "Tasks on their stations' lanes", icon: Columns3 },
];

/** Grid or Lanes, the user's choice for every Board, remembered; in a narrow bar, in its "…". */
function LayoutToggle() {
  const current = useLayoutStore((s) => s.boardLayout);
  return (
    <ButtonGroup
      aria-label="Board layout"
      data-testid="board-layout"
      className="shrink-0 [-webkit-app-region:no-drag]"
    >
      {LAYOUTS.map(({ layout, label, hint, icon: Icon }) => (
        <Hint
          key={layout}
          label={hint}
          side="bottom"
          render={
            <Button
              size="xs"
              variant={current === layout ? "secondary" : "ghost"}
              aria-pressed={current === layout}
              data-testid="board-layout-option"
              data-layout={layout}
              className={cn(current !== layout && "text-muted-foreground")}
              onClick={() => useLayoutStore.getState().setBoardLayout(layout)}
            />
          }
        >
          <Icon aria-hidden data-icon="inline-start" />
          {/* In a narrow bar, the icons alone; the hint and the name still say which. */}
          <span className="@max-2xl/titlebar:sr-only">{label}</span>
        </Hint>
      ))}
    </ButtonGroup>
  );
}

export function BoardHeader({
  state,
  hidden,
}: {
  state: WorkspaceState;
  /** Workers the Board leaves out until finished work is shown. */
  hidden: number;
}) {
  const { workspace, paused } = state;
  // The workspace's share of the Inbox, as its badge counts it (`needsYouCounts`).
  const waiting = useNeedsYouCounts().byWorkspace.get(workspace.id) ?? 0;
  const working = useThreadsStore((s) => midTurnWorkers(s.byId, workspace.id));
  const slot = useTitlebarSlot((s) => s.slot);
  // Leaving for Chat, Board stays a moment for its exit while the thread's header moves in.
  const shown = useViewStore((s) => s.view === "board");
  const header = (
    <header
      data-testid="board-header"
      className={cn(
        // In the bar, cut short rather than run under the window's buttons.
        "flex min-w-0 flex-1 items-center gap-3 overflow-x-clip",
        slot === null ? "h-12 shrink-0 px-4" : "pl-2",
      )}
    >
      {/* The Board's one way to what the workspace needs from you: the Inbox, on its first item. */}
      {waiting > 0 && (
        <button
          type="button"
          data-testid="rail-waiting-chip"
          data-count={waiting}
          aria-label={`${waiting} waiting. Open Inbox`}
          title="Open the Inbox on what this workspace needs from you"
          onClick={() => showInbox({ workspaceId: workspace.id })}
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-status-needs-mark/60 px-2 py-0.5 text-xs text-status-needs outline-none [-webkit-app-region:no-drag] hover:bg-status-needs-mark/10 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Hand aria-hidden className="size-3.5" />
          <span className="tabular-nums">{waiting}</span>
          <span className="@max-2xl/titlebar:sr-only">waiting · Open Inbox</span>
        </button>
      )}
      <span data-titlebar-room="0" className="flex-1" />
      {/* A narrow bar folds it into its "…" with Tidy up, the lesser buttons. */}
      <Foldable level={1} gap={12}>
        <LayoutToggle />
      </Foldable>
      <FinishedToggle workspaceId={workspace.id} count={hidden} />
    </header>
  );
  return (
    <>
      {/* Without the shell's bar (a test, say), the header is Board's own. */}
      {slot === null ? header : shown && createPortal(header, slot)}
      {paused !== undefined && (
        <p
          role="status"
          data-testid="rail-paused-line"
          className="mx-4 my-2 flex shrink-0 items-center gap-2 rounded-(--radius-md) border border-border px-2.5 py-1.5 text-xs"
        >
          <Pause aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            {pauseText(paused)} since {pauseClock(paused.at)}.{" "}
            <span className="text-muted-foreground">{pauseLeavesRunning(working, paused)}</span>
          </span>
        </p>
      )}
    </>
  );
}
