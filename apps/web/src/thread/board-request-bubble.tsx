import { ChevronRight, Sparkles, Telescope } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { MessageContent } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import type { BoardRequest } from "@/orchestration/board-model";

const ICON = { discover: Telescope, tidyUp: Sparkles } as const;

/**
 * A request the workspace's menu sent for the user (Discover workspace, Tidy up), in the user's
 * bubble: its name and what it asks in a line. The instructions it sent the orchestrator are a
 * page of prompt nobody typed; they stay one click away under "What was sent".
 */
export function BoardRequestBubble({
  request,
  text,
  children,
}: {
  request: BoardRequest;
  text: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const sentId = useId();
  const Icon = ICON[request.kind];
  return (
    <MessageContent data-testid="board-request" data-kind={request.kind} className="max-w-xl">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-background/60 text-muted-foreground">
          <Icon aria-hidden className="size-icon-row" />
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="font-medium">{request.label}</span>
          <span className="text-meta text-muted-foreground">{request.line}</span>
        </div>
      </div>
      <button
        type="button"
        data-testid="board-request-toggle"
        aria-expanded={open}
        aria-controls={sentId}
        onClick={() => setOpen((was) => !was)}
        className="-mx-1 flex w-fit items-center gap-1 rounded-2xs px-1 text-meta text-muted-foreground outline-none hover:text-foreground focus-visible:focus-ring"
      >
        <ChevronRight aria-hidden className={cn("size-3.5", open && "rotate-90")} />
        What was sent
      </button>
      {open && (
        <p
          id={sentId}
          data-testid="board-request-sent"
          className="border-t border-border pt-2 text-meta whitespace-pre-wrap text-muted-foreground"
        >
          {text}
        </p>
      )}
      {children}
    </MessageContent>
  );
}
