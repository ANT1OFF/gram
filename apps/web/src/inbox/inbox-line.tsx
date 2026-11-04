import type { WorkspaceId } from "@gram/contracts";
import { ArrowRight, Hand } from "lucide-react";

import { useShortcutHint } from "@/keyboard/use-shortcut-hint";
import { DrawnCheck } from "@/motion";
import { useAskStackStore } from "@/orchestration/ask-stack-store";
import { useNeedsYouCounts } from "@/orchestration/use-needs-you";

import { showInbox } from "./inbox-store";

// Where the Asks dock was, above the orchestrator's composer: one slim line saying how much of the
// workspace's share of the Inbox waits, and the way there. The workspace's answers are given in the
// Inbox, or in the card of the thread that asked; the newest still held keeps its Undo here, so an
// answer given anywhere can be taken back from the chat it concerns.

export function InboxLine({ workspaceId }: { workspaceId: WorkspaceId | undefined }) {
  const { byWorkspace } = useNeedsYouCounts();
  const count = workspaceId === undefined ? 0 : (byWorkspace.get(workspaceId) ?? 0);
  const last = useAskStackStore((s) => s.held.at(-1));
  const undo = useAskStackStore((s) => s.undo);
  const hint = useShortcutHint("inbox.open");
  if (count === 0 && last === undefined) return null;
  return (
    <div className="shrink-0 bg-thread px-3 pt-2" data-testid="inbox-line-dock">
      <div
        data-testid="inbox-line"
        data-count={count}
        className="mx-auto flex w-full max-w-(--thread-max-width) items-center gap-2 rounded-(--radius-md) border border-border px-3 py-1 text-xs text-muted-foreground"
      >
        {count > 0 && (
          <button
            type="button"
            data-testid="inbox-line-open"
            aria-label={`${count} waiting. Open Inbox${hint === undefined ? "" : ` (${hint})`}`}
            title={hint === undefined ? "Open Inbox" : `Open Inbox (${hint})`}
            onClick={() => showInbox({ workspaceId })}
            className="flex min-w-0 items-center gap-2 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Hand aria-hidden className="size-3.5 shrink-0 text-status-needs-mark" />
            <span className="font-medium text-status-needs tabular-nums">{count} waiting</span>
            <span aria-hidden>·</span>
            <span className="text-foreground">Open Inbox</span>
            <ArrowRight aria-hidden className="size-3.5 shrink-0" />
          </button>
        )}
        {last !== undefined && (
          <span
            key={last.key}
            data-testid="inbox-line-undo"
            className="ml-auto flex min-w-0 items-center gap-1 text-foreground"
          >
            <DrawnCheck className="size-3.5 text-success-text" />
            <span className="truncate">{last.done}</span>
            <button
              type="button"
              data-testid="inbox-line-undo-button"
              onClick={() => undo(last.key)}
              className="ml-0.5 rounded-sm px-1 text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              Undo
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
