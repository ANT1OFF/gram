import type { WorkspaceState } from "@gram/contracts";
import { ChartPie, RefreshCw } from "lucide-react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Shimmer, spin } from "@/motion";
import { Dialog, DialogShell } from "@/thread/dialog-shell";

import { FRESH_SESSION_EXPLANATION, useHandoff, useHandoffStore } from "./use-board-actions";
import { useWorkspaces } from "./use-orchestration";

/** What stands where the action was while the orchestrator is between two agent sessions. */
export function HandingOff({
  compact = false,
  className,
}: {
  /** Keeps only the turning icon, for a sidebar row with no room for the words. */
  compact?: boolean;
  className?: string;
}) {
  return (
    <span
      role="status"
      data-testid="handing-off"
      title={compact ? "Handing off to a fresh session" : undefined}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground",
        className,
      )}
    >
      <RefreshCw aria-hidden ref={spin} className="size-3.5" />
      {compact ? <span className="sr-only">Handing off…</span> : <Shimmer>Handing off…</Shimmer>}
    </span>
  );
}

/**
 * A gauge in the warning colour, shown once the orchestrator's context is nearly full; it opens the
 * fresh session's confirmation. An icon only: the agent compacts by
 * itself, so this is an option, not a warning, and the percent is in its label.
 */
export function ContextChip({
  pct,
  onAct,
  className,
}: {
  pct: number;
  onAct: () => void;
  className?: string;
}) {
  const label = `Context ${pct} % — start a fresh session`;
  return (
    <Hint
      label={`${label}\nIt starts again from the orchestrator's memory and the ledger.`}
      side="bottom"
      render={
        <button
          type="button"
          data-testid="context-chip"
          data-pct={pct}
          aria-label={label}
          onClick={onAct}
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
        />
      }
    >
      <ChartPie aria-hidden className="size-4 shrink-0" />
    </Hint>
  );
}

function ConfirmDialog({ state, onClose }: { state: WorkspaceState; onClose: () => void }) {
  const handoff = useHandoff(state);
  return (
    <DialogShell
      testId="fresh-session-dialog"
      title="Start a fresh session?"
      description={`${state.workspace.name}'s orchestrator`}
      onClose={onClose}
    >
      <p className="text-sm">{FRESH_SESSION_EXPLANATION}</p>
      {!handoff.available && (
        <p role="status" className="text-xs text-muted-foreground">
          This workspace has no orchestrator open, so there is no session to replace.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
          Cancel
        </Dialog.Close>
        <Button
          type="button"
          size="sm"
          data-testid="fresh-session-start"
          disabled={!handoff.available || handoff.running}
          onClick={() => {
            onClose();
            void handoff.start();
          }}
        >
          Start fresh session
        </Button>
      </div>
    </DialogShell>
  );
}

/**
 * Mount once: the confirmation for a fresh session asked for from a thread's menu, the palette or
 * a banner, where there is no room to confirm in place.
 */
export function FreshSessionDialog() {
  const confirming = useHandoffStore((s) => s.confirming);
  const workspaces = useWorkspaces();
  const state = workspaces.find((candidate) => candidate.workspace.id === confirming);
  if (state === undefined) return null;
  return (
    <ConfirmDialog state={state} onClose={() => useHandoffStore.getState().confirm(undefined)} />
  );
}
