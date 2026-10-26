import type { ThreadId } from "@gram/contracts";
import { Link } from "@tanstack/react-router";
import { MessagesSquare } from "lucide-react";
import { Fragment, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { useThreadsStore } from "@/stores/threads";

import { THREAD_REF_TAG, resolveThreadRef, splitThreadLinks } from "./thread-refs";

const CHIP =
  "inline-flex max-w-[28ch] items-center gap-1 rounded-sm border px-1 align-baseline text-[0.92em] leading-snug font-medium";

/**
 * A link to another thread, as a compact chip under that thread's current title; muted, and not a
 * link, when the id has a thread's shape but no thread has it any more. Anything else renders as
 * `fallback`, the link as it was written.
 */
function ThreadRefChip({
  id,
  label,
  fallback,
}: {
  id: string;
  /** The title as the link was written, for a thread that is gone. */
  label: string;
  fallback: ReactNode;
}) {
  const title = useThreadsStore((s) => s.byId[id]?.thread.title);
  const ready = useThreadsStore((s) => s.ready);
  const target = resolveThreadRef(id, () => title, ready);
  if (target.kind === "none") return <>{fallback}</>;
  if (target.kind === "gone") {
    return (
      <span
        data-testid="thread-ref"
        data-gone="true"
        title="Thread not found"
        className={cn(CHIP, "border-dashed border-border text-muted-foreground")}
      >
        <MessagesSquare aria-hidden className="size-3 shrink-0" />
        <span className="truncate">{label}</span>
      </span>
    );
  }
  return (
    <Link
      to="/t/$threadId"
      params={{ threadId: id as ThreadId }}
      data-testid="thread-ref"
      title={target.title}
      className={cn(
        CHIP,
        "border-border bg-muted/50 text-foreground no-underline hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
      )}
    >
      <MessagesSquare aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      <span className="truncate">{target.title}</span>
    </Link>
  );
}

/** The `thread-ref` element `rehypeThreadRefs` marks, wrapping the link as written. */
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
