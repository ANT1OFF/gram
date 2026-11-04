import type { ThreadId } from "@gram/contracts";
import { useParams } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
import { cn } from "@/lib/utils";
import { REVIEW_STRIP_WIDTH, useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

/**
 * What a review in focus leaves of the chat: a strip over it, with the conversation one click (or
 * Esc) away and the thread's title down its length.
 */
export function ReviewStrip({ side }: { side: "left" | "right" }) {
  const setReviewFocus = useLayoutStore((s) => s.setReviewFocus);
  const hint = useShortcutHint("panel.restore");
  const threadId = useParams({ strict: false }).threadId as ThreadId | undefined;
  const title = useThreadsStore((s) =>
    threadId === undefined ? undefined : s.byId[threadId]?.thread.title,
  );
  const label = "Back to the conversation";
  return (
    <div
      data-testid="review-strip"
      className={cn(
        "absolute inset-y-0 z-20 flex flex-col bg-thread",
        side === "left" ? "left-0" : "right-0",
      )}
      style={{ width: REVIEW_STRIP_WIDTH }}
    >
      <div className="h-(--titlebar-height) w-full shrink-0 [-webkit-app-region:drag]" />
      <div className="flex min-h-0 flex-1 flex-col items-center gap-3 border-t border-border py-2">
        <Hint
          label={withHint(label, hint)}
          side="right"
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={label}
              className="shrink-0 text-muted-foreground"
              onClick={() => setReviewFocus(false)}
            />
          }
        >
          <MessageSquare />
        </Hint>
        {title && (
          <span className="min-h-0 truncate text-xs text-muted-foreground [writing-mode:vertical-rl]">
            {title}
          </span>
        )}
      </div>
    </div>
  );
}
