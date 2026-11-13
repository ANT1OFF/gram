import type { WorkspaceState } from "@gram/contracts";
import { Archive, Hand, Pause } from "lucide-react";
import { createPortal } from "react-dom";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { showInbox } from "@/inbox/inbox-store";
import { cn } from "@/lib/utils";
import { midTurnWorkers } from "@/orchestration/tree-model";
import { isErrorItem } from "@/orchestration/needs-you-items";
import { useNeedsYouIn } from "@/orchestration/use-needs-you";
import { useTitlebarSlot } from "@/shell/titlebar-slot";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { pauseClock, pauseLeavesRunning, pauseText } from "@/thread/orchestration-model";

import { useViewStore } from "./view-store";

// The Board's header: what waits on you (a link into the Inbox) and Show finished; the rows below
// say who works. It is the window's title bar's, one bar not two: the switcher there names the
// workspace, and Tidy up and Pause or Resume are the bar's own. A pause says so in a line under it,
// in the shared pause words.

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
          size="xs"
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
      {/* Named where the bar has room, as the action it is: an archive box alone read as nothing,
          and a count beside it repeated Done's. */}
      <span aria-hidden className="@max-2xl/titlebar:hidden">
        {shown ? "Hide finished" : "Show finished"}
      </span>
    </Hint>
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
  // What needs you here; amber only while some of it asks (an error alone keeps its one alarm).
  const { here } = useNeedsYouIn({ workspaceId: workspace.id });
  const waiting = here.length;
  const asking = here.some((item) => !isErrorItem(item));
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
          data-asks={asking || undefined}
          aria-label={`${waiting} waiting. Open Inbox`}
          title="Open the Inbox on what this workspace needs from you"
          onClick={() => showInbox({ workspaceId: workspace.id })}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-meta outline-none [-webkit-app-region:no-drag] focus-visible:ring-2 focus-visible:ring-ring",
            asking
              ? "border-status-needs-mark/60 text-status-needs hover:bg-status-needs-mark/10"
              : "border-border-strong text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <Hand aria-hidden className="size-icon-row" />
          <span className="tabular-nums">{waiting}</span>
          <span className="@max-2xl/titlebar:sr-only">waiting · Open Inbox</span>
        </button>
      )}
      <span data-titlebar-room="0" className="flex-1" />
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
          className="mx-4 my-2 flex shrink-0 items-center gap-2 rounded-(--radius-md) border border-border px-2.5 py-1.5 text-meta"
        >
          <Pause aria-hidden className="size-icon-row shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            {pauseText(paused)} since {pauseClock(paused.at)}.{" "}
            <span className="text-muted-foreground">{pauseLeavesRunning(working, paused)}</span>
          </span>
        </p>
      )}
    </>
  );
}
