import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * An inline confirmation in place of a dialog: what happens, the action named again on a destructive
 * button, and Keep. The message says the consequence, not "Are you sure?".
 */
export function ConfirmStrip({
  label,
  message,
  confirm,
  onConfirm,
  onKeep,
  busy = false,
  className,
}: {
  /** Names the strip for a screen reader, such as "Remove Staging". */
  label: string;
  message: ReactNode;
  /** The destructive button's words, such as "Remove gateway". */
  confirm: string;
  onConfirm: () => void;
  onKeep: () => void;
  /** While the action runs: both buttons wait. */
  busy?: boolean;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 p-2 text-sm",
        className,
      )}
    >
      <span className="min-w-0 flex-1">{message}</span>
      <Button size="sm" variant="destructive" disabled={busy} onClick={onConfirm}>
        {confirm}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={onKeep}>
        Keep
      </Button>
    </div>
  );
}
