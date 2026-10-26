import { ChevronUp, Pencil, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

import { ExpandableError } from "./fields";
import { RowContextMenu, RowMenuButton, type RowAction } from "./row-menu";

/**
 * One item of a list that is edited as drafts and saved together: a single line with a ⋯ while
 * folded, and its form under that line while open. Removing only drops the draft, so it takes
 * effect, and can still be undone, until Save.
 */
export function DraftRow({
  label,
  summary,
  open,
  onOpenChange,
  onRemove,
  error,
  children,
}: {
  /** Names the row, such as "Custom model 2". */
  label: string;
  /** The line itself: what the item is, in a few words and marks. */
  summary: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemove: () => void;
  /** Why this item can't be saved yet, under its form. */
  error?: string | undefined;
  /** The form, shown while open. */
  children: ReactNode;
}) {
  const actions: RowAction[] = [
    open
      ? { label: "Close editor", icon: ChevronUp, onSelect: () => onOpenChange(false) }
      : { label: "Edit", icon: Pencil, onSelect: () => onOpenChange(true) },
    { label: "Remove", icon: Trash2, danger: true, onSelect: onRemove },
  ];
  return (
    <li aria-label={label} className="flex flex-col gap-3">
      <RowContextMenu
        actions={actions}
        render={<div className="flex min-h-7 min-w-0 items-center gap-2" />}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">{summary}</div>
        <RowMenuButton label={`${label} actions`} actions={actions} />
      </RowContextMenu>
      {open && <div className="flex flex-col gap-3">{children}</div>}
      {error && <ExpandableError message={error} />}
    </li>
  );
}
