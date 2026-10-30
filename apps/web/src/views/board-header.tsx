import type { WorkspaceState } from "@gram/contracts";
import { Archive, Inbox, Pause } from "lucide-react";
import { createPortal } from "react-dom";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { NumberTicker } from "@/motion";
import { WAITING_BAND } from "@/orchestration/board-waiting";
import { midTurnWorkers } from "@/orchestration/tree-model";
import { useTitlebarSlot } from "@/shell/titlebar-slot";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { pauseClock, pauseLeavesRunning, pauseText } from "@/thread/orchestration-model";

import { useViewStore } from "./view-store";

// The Board's header: what waits on you, and Show archived; the stations below say who works. It
// is the window's title bar's, one bar not two: the switcher there names the workspace, and Tidy up
// and Pause or Resume are the bar's own. A pause says so in a line under it, in the shared pause
// words.

/** Show archived, while there is any: the workspace's choice. */
function ArchivedToggle({ workspaceId, count }: { workspaceId: string; count: number }) {
  const shown = useLayoutStore((s) => s.boardArchivedShown.includes(workspaceId));
  if (count === 0) return null;
  const label = shown ? `Hide archived (${count})` : `Show archived (${count})`;
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
          aria-label={`Show archived (${count})`}
          className="text-muted-foreground [-webkit-app-region:no-drag] aria-pressed:bg-accent aria-pressed:text-foreground"
          onClick={() => useLayoutStore.getState().toggleBoardArchived(workspaceId)}
        />
      }
    >
      <Archive aria-hidden />
    </Hint>
  );
}

export function BoardHeader({
  state,
  archived,
  waiting,
  waitingOpen,
  onWaiting,
}: {
  state: WorkspaceState;
  /** Archived workers the lines leave out until shown. */
  archived: number;
  /** What Waiting on you holds. */
  waiting: number;
  waitingOpen: boolean;
  onWaiting: () => void;
}) {
  const { workspace, paused } = state;
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
      {waiting > 0 && (
        <button
          type="button"
          data-testid="rail-waiting-chip"
          aria-expanded={waitingOpen}
          aria-controls={WAITING_BAND}
          // The ticker's digit reels can't be read back from the DOM.
          aria-label={`${waiting} waiting on you`}
          title="What the orchestrator and its workers left for you: drafts, links, steps, decisions and questions"
          onClick={onWaiting}
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-status-needs/50 bg-status-needs/10 px-2 py-0.5 text-xs text-status-needs outline-none [-webkit-app-region:no-drag] hover:bg-status-needs/20 focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-status-needs/20"
        >
          <Inbox aria-hidden className="size-3" />
          <NumberTicker value={waiting} className="tabular-nums" />
          <span className="@max-2xl/titlebar:sr-only">waiting on you</span>
        </button>
      )}
      <span data-titlebar-room="0" className="flex-1" />
      <ArchivedToggle workspaceId={workspace.id} count={archived} />
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
          className="mx-4 my-2 flex shrink-0 items-center gap-2 rounded-(--radius-md) border border-status-needs/40 bg-status-needs/5 px-2.5 py-1.5 text-xs"
        >
          <Pause aria-hidden className="size-3.5 shrink-0 text-status-needs" />
          <span className="min-w-0">
            {pauseText(paused)} since {pauseClock(paused.at)}.{" "}
            <span className="text-muted-foreground">{pauseLeavesRunning(working, paused)}</span>
          </span>
        </p>
      )}
    </>
  );
}
