import type { GramUIMessage, TurnId, TurnUndoData } from "@gram/contracts";
import { Undo2 } from "lucide-react";

import { formatStamp } from "@/lib/time";
import { useNow } from "@/lib/use-now";

/**
 * The receipt's line: `Undid edits to 3 files at 14:32`, with the date before the time when it
 * wasn't today (`formatStamp`). `intl` pins the zone, for tests.
 */
export const turnUndoLabel = (
  undo: TurnUndoData,
  now: number,
  intl: { readonly timeZone?: string } = {},
): string => {
  const files = `${undo.files} ${undo.files === 1 ? "file" : "files"}`;
  const at = formatStamp(undo.at, now, intl);
  if (undo.failed !== undefined) return `Undo failed at ${at}: check ${files} with View changes`;
  return `Undid edits to ${files} at ${at}`;
};

/** Each turn's undo receipt, by the turn it undid; the latest wins. */
export function turnUndos(messages: readonly GramUIMessage[]): ReadonlyMap<TurnId, TurnUndoData> {
  const undos = new Map<TurnId, TurnUndoData>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "data-turn-undo") undos.set(part.data.turnId, part.data);
    }
  }
  return undos;
}

/** A message that is only undo receipts: no reply to copy, rewind to or fork from. */
export const isUndoReceipt = (message: GramUIMessage): boolean =>
  message.parts.length > 0 && message.parts.every((part) => part.type === "data-turn-undo");

/**
 * Where the user undid a turn's file edits, as a quiet divider like a session restart's. One that
 * failed partway also lists, as text, the files that may have changed.
 */
export function TurnUndoMarker({ undo }: { undo: TurnUndoData }) {
  // Only to tell today from another day, so read once rather than on a clock.
  const now = useNow(false);
  const label = turnUndoLabel(undo, now);
  const divider = (
    <div
      role="separator"
      aria-label={label}
      title={
        undo.failed === undefined
          ? "The files that turn changed were put back as they were before it. The agent wasn't told."
          : "Git failed partway through reversing that turn, so some of its files may have changed and others not."
      }
      data-testid="turn-undo-receipt"
      className="my-3 flex w-full items-center gap-3 text-meta text-muted-foreground"
    >
      <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
      <span className="flex min-w-0 items-center gap-1.5">
        <Undo2 aria-hidden className="size-3.5 shrink-0" />
        <span className="text-center">{label}</span>
      </span>
      <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
    </div>
  );
  if (undo.failed === undefined) return divider;
  return (
    <div>
      {divider}
      <ul
        data-testid="turn-undo-failed"
        aria-label="Files that may have changed"
        className="-mt-1 mb-3 text-center font-mono text-meta text-muted-foreground select-text"
      >
        {undo.failed.map((path) => (
          <li key={path}>{path}</li>
        ))}
      </ul>
    </div>
  );
}
