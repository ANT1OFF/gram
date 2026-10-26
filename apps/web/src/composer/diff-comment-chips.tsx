import type { ThreadId } from "@gram/contracts";
import { MessageSquare, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { useArrivals } from "@/motion";
import { commentLabel, useDiffComments, useDiffCommentsStore } from "@/stores/diff-comments";
import { useLayoutStore } from "@/stores/layout";

/**
 * The thread's draft diff comments waiting for the next message, one chip each: file and lines,
 * the note on hover. A chip opens its file in the Diff panel; × drops the comment.
 */
export function DiffCommentChips({
  threadId,
  className,
}: {
  threadId: ThreadId;
  className?: string;
}) {
  const comments = useDiffComments(threadId);
  const arrivals = useArrivals(
    comments.map((comment) => comment.id),
    true,
  );
  if (comments.length === 0) return null;
  return (
    <ul aria-label="Diff comments" className={cn("flex flex-wrap gap-1", className)}>
      {comments.map((comment) => {
        const label = commentLabel(comment);
        return (
          <li
            key={comment.id}
            data-testid="diff-comment-chip"
            className={cn(
              "flex max-w-full min-w-0 items-center gap-1 rounded-md border border-border text-xs",
              arrivals.has(comment.id) && "gram-swap",
            )}
          >
            <button
              type="button"
              title={comment.note}
              onClick={() =>
                useLayoutStore
                  .getState()
                  .requestPanel({ threadId, panel: "diff", target: comment.path }, threadId)
              }
              className="flex min-w-0 items-center gap-1.5 rounded-md py-0.5 ps-1.5 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <MessageSquare aria-hidden className="size-3 shrink-0 text-info" />
              <span className="truncate font-mono">{label}</span>
            </button>
            <button
              type="button"
              aria-label={`Remove the comment on ${label}`}
              className="me-1.5 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => useDiffCommentsStore.getState().remove(threadId, comment.id)}
            >
              <X className="size-3" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
