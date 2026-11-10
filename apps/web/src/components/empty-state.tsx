import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { drawOn } from "@/motion";

/**
 * The one thing to do from an empty state: a verb, and what it does. Its words alone: a glyph
 * beside them only said them again (History beside "Open History", a plus beside "New task").
 */
export interface EmptyAction {
  readonly label: ReactNode;
  readonly onClick: () => void;
  readonly testId?: string | undefined;
  /** The filled primary: only where it is the one way in to the whole app (home, nothing set up). */
  readonly primary?: boolean | undefined;
}

/**
 * What an empty view says, the same on every surface: its glyph drawn on, a short title (a fragment,
 * "No docs yet"), one line on what goes there, and at most one action, an outline button (filled
 * where it is the app's one way in: home with nothing set up). The
 * Board, the Inbox, History, the panel's Docs and Workers tabs and the home page all use it, so an
 * empty place always reads the same way.
 */
export function EmptyState({
  icon: Icon,
  title,
  line,
  action,
  testId,
  className,
  iconClassName,
  children,
}: {
  icon: LucideIcon;
  title: ReactNode;
  /** What goes here, in one sentence. */
  line?: ReactNode;
  action?: EmptyAction | undefined;
  testId?: string;
  className?: string;
  /** Only for a glyph whose colour means a status ("Nothing needs you" is a success). */
  iconClassName?: string;
  /** Anything after the action, such as a way to what is put away. */
  children?: ReactNode;
}) {
  return (
    <div
      role="status"
      data-testid={testId}
      className={cn(
        "flex flex-col items-center gap-1 px-6 py-10 text-center text-reading text-muted-foreground",
        className,
      )}
    >
      <Icon aria-hidden ref={drawOn} className={cn("mb-1 size-icon-empty", iconClassName)} />
      <p data-testid="empty-title" className="text-body-strong text-foreground">
        {title}
      </p>
      {line !== undefined && (
        <p data-testid="empty-line" className="max-w-(--description-measure) text-meta">
          {line}
        </p>
      )}
      {action !== undefined && (
        <Button
          type="button"
          size="sm"
          variant={action.primary ? "default" : "outline"}
          data-testid={action.testId ?? "empty-action"}
          className="mt-3"
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      )}
      {children}
    </div>
  );
}
