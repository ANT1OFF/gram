import type { ThreadId } from "@gram/contracts";
import { Link } from "@tanstack/react-router";
import { MessagesSquare } from "lucide-react";
import { Fragment, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { useBesideLink } from "@/orchestration/beside-link";
import { useThreadsStore } from "@/stores/threads";

import { THREAD_REF_TAG, resolveThreadRef, splitThreadLinks } from "./thread-refs";

const CHIP =
  "inline-flex max-w-[28ch] items-center gap-1 rounded-sm border px-1 align-baseline text-code leading-snug font-medium";

function ThreadRefChip({
  id,
  label,
  fallback,
}: {
  id: string;
  label: string;
  fallback: ReactNode;
}) {
  const title = useThreadsStore((s) => s.byId[id]?.thread.title);
  const ready = useThreadsStore((s) => s.ready);
  const target = resolveThreadRef(id, () => title, ready);
  const beside = useBesideLink(id as ThreadId);
  if (target.kind === "none") return <>{fallback}</>;
  if (target.kind === "gone") {
    return (
      <span
        data-testid="thread-ref"
        data-gone="true"
        title="Thread not found"
        className={cn(CHIP, "border-dashed border-border text-muted-foreground")}
      >
        <MessagesSquare aria-hidden className="size-icon-row shrink-0" />
        <span className="truncate">{label}</span>
      </span>
    );
  }
  return (
    <Link
      to="/t/$threadId"
      params={{ threadId: id }}
      onClick={beside}
      data-testid="thread-ref"
      title={target.title}
      className={cn(
        CHIP,
        "border-border bg-muted/50 text-foreground no-underline hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
      )}
    >
      <MessagesSquare aria-hidden className="size-icon-row shrink-0 text-muted-foreground" />
      <span className="truncate">{target.title}</span>
    </Link>
  );
}

function ThreadRefElement({
  "data-thread-id": id,
  "data-label": label,
  children,
}: {
  "data-thread-id"?: string;
  "data-label"?: string;
  children?: ReactNode;
}) {
  if (id === undefined) return <>{children}</>;
  return <ThreadRefChip id={id} label={label ?? id} fallback={children} />;
}

export const THREAD_REF_COMPONENTS = { [THREAD_REF_TAG]: ThreadRefElement };

/**
 * Plain text with its `[title](#threadId)` links shown as thread chips, in one span so a flex
 * parent (a message bubble) keeps the chips in the line.
 */
export function ThreadLinkedText({ text }: { text: string }) {
  return (
    <span>
      {splitThreadLinks(text).map((segment, i) => (
        <Fragment key={i}>
          {segment.kind === "text" ? (
            segment.text
          ) : (
            <ThreadRefChip id={segment.id} label={segment.label} fallback={segment.raw} />
          )}
        </Fragment>
      ))}
    </span>
  );
}
