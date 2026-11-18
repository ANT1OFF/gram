import { Popover } from "@base-ui/react/popover";
import type { WorkspaceState } from "@gram/contracts";
import { RefreshCw } from "lucide-react";
import { useState } from "react";

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
        "inline-flex shrink-0 items-center gap-1 text-meta text-muted-foreground",
        className,
      )}
    >
      <RefreshCw aria-hidden ref={spin} className="size-icon-row" />
      {compact ? <span className="sr-only">Handing off…</span> : <Shimmer>Handing off…</Shimmer>}
    </span>
  );
}

const SAVE_FIRST_ON = "The orchestrator writes down what it hasn't saved, then hands off.";
const SAVE_FIRST_OFF =
  "Its current turn stops now and any approval it waits on is declined. Anything not in memory is left behind; a later memory update can still read it from the transcript.";

/** Save to memory first, ticked by default; unticked, a hard cut. */
export function SaveFirst({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="grid grid-cols-[auto_1fr] items-start gap-x-2 gap-y-0.5">
      <input
        type="checkbox"
        data-testid="fresh-session-save-first"
        className="mt-1"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="text-reading">Save to memory first</span>
      <span
        data-testid="fresh-session-save-first-detail"
        className="col-start-2 text-meta text-muted-foreground"
      >
        {checked ? SAVE_FIRST_ON : SAVE_FIRST_OFF}
      </span>
    </label>
  );
}

/**
 * The orchestrator's Fresh session, always in its header: an icon that opens a popover with the
 * choice to save to memory first and the button that starts it. A fresh session is for dropping
 * what is in the conversation, whatever its size, so it says nothing about context.
 */
export function FreshSessionChip({
  state,
  inTitlebar = false,
  className,
}: {
  state: WorkspaceState;
  /** One of the title bar's icon buttons: its size, stroke and hover fill. */
  inTitlebar?: boolean;
  className?: string;
}) {
  const handoff = useHandoff(state);
  const [open, setOpen] = useState(false);
  const [saveFirst, setSaveFirst] = useState(true);
  const label = "Fresh session";
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setSaveFirst(true);
      }}
    >
      <Popover.Trigger
        data-testid="fresh-session-chip"
        aria-label={label}
        title={label}
        render={
          inTitlebar ? (
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn("text-muted-foreground aria-expanded:bg-muted", className)}
            />
          ) : (
            <button
              type="button"
              className={cn(
                "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-muted aria-expanded:text-foreground",
                className,
              )}
            />
          )
        }
      >
        <RefreshCw aria-hidden className={inTitlebar ? "shrink-0" : "size-icon-row shrink-0"} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} className="isolate z-50">
          <Popover.Popup
            data-testid="fresh-session-popup"
            className="flex w-80 max-w-[calc(100vw-2rem)] origin-(--transform-origin) flex-col gap-3 rounded-lg border border-edge bg-popover p-3 text-meta text-popover-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
          >
            <Popover.Title className="font-medium">Fresh session</Popover.Title>
            <Popover.Description className="text-muted-foreground">
              {FRESH_SESSION_EXPLANATION}
            </Popover.Description>
            <SaveFirst checked={saveFirst} onChange={setSaveFirst} />
            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                data-testid="fresh-session-start"
                disabled={!handoff.available || handoff.running}
                onClick={() => {
                  setOpen(false);
                  void handoff.start({ checkpoint: saveFirst });
                }}
              >
                Start fresh session
              </Button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ConfirmDialog({ state, onClose }: { state: WorkspaceState; onClose: () => void }) {
  const handoff = useHandoff(state);
  const [saveFirst, setSaveFirst] = useState(true);
  return (
    <DialogShell
      testId="fresh-session-dialog"
      title="Start a fresh session?"
      description={`${state.workspace.name}'s orchestrator`}
      onClose={onClose}
    >
      <p className="text-reading">{FRESH_SESSION_EXPLANATION}</p>
      <SaveFirst checked={saveFirst} onChange={setSaveFirst} />
      {!handoff.available && (
        <p role="status" className="text-meta text-muted-foreground">
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
            void handoff.start({ checkpoint: saveFirst });
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
