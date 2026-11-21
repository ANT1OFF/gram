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
  const { here } = useNeedsYouIn({ workspaceId: workspace.id });
  const waiting = here.length;
  const asking = here.some((item) => !isErrorItem(item));
  const working = useThreadsStore((s) => midTurnWorkers(s.byId, workspace.id));
  const slot = useTitlebarSlot((s) => s.slot);
  const shown = useViewStore((s) => s.view === "board");
  const header = (
    <header
      data-testid="board-header"
      className={cn(
        "flex min-w-0 flex-1 items-center gap-3 overflow-x-clip",
        slot === null ? "h-12 shrink-0 px-4" : "pl-2",
      )}
    >
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
