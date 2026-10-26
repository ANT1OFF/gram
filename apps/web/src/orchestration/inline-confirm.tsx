import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { ExpandPresence } from "@/motion";

/** One inline "are you sure" under the thing it is about: what will happen, then the two buttons. */
export function InlineConfirm({
  open,
  label,
  children,
  confirmLabel,
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  label: string;
  children: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ExpandPresence open={open}>
      <div
        role="alertdialog"
        aria-label={label}
        data-testid="inline-confirm"
        className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-(--radius-md) border border-border bg-card px-2 py-1.5 text-xs"
      >
        <p className="min-w-0 flex-1 basis-64">{children}</p>
        <span className="flex shrink-0 gap-2">
          <Button
            size="xs"
            variant={destructive ? "destructive" : "default"}
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
          <Button size="xs" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </span>
      </div>
    </ExpandPresence>
  );
}
