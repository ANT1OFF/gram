import type { ThreadId } from "@gram/contracts";
import { Clock } from "lucide-react";

import { Hint } from "@/components/hint";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { useThreadsStore } from "@/stores/threads";

import { snoozedUntilText } from "./snooze-model";
import { useThreadActions } from "./use-thread-actions";

/**
 * "Snoozed until Fri 09:00" in the pane header while the thread is snoozed, with its Unsnooze: the
 * one place a snoozed thread opened from search or History says why the lists leave it out.
 */
export function SnoozeChip({ threadId, className }: { threadId: ThreadId; className?: string }) {
  const until = useThreadsStore((s) => s.byId[threadId]?.thread.snoozedUntil);
  const { snooze } = useThreadActions(threadId);
  const now = useNow(until !== undefined, undefined, 60_000);
  if (until === undefined) return null;
  return (
    <span
      data-testid="pane-snoozed"
      role="status"
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-sm border border-border pl-1 text-meta text-muted-foreground",
        className,
      )}
    >
      <Hint
        label="Out of the lists until then. It comes back unread, or sooner if it asks you something or fails."
        side="bottom"
        render={
          <span data-testid="pane-snoozed-words" className="inline-flex items-center gap-1" />
        }
      >
        <Clock aria-hidden className="size-icon-row" />
        <span className="tabular-nums">{snoozedUntilText(until, now)}</span>
      </Hint>
      {snooze !== undefined && (
        <button
          type="button"
          data-testid="pane-unsnooze"
          className="rounded-r-sm border-l border-border px-1 font-medium text-foreground/80 outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => snooze(undefined)}
        >
          Unsnooze
        </button>
      )}
    </span>
  );
}
