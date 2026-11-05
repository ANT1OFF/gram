import type { DocMeta, ThreadId } from "@gram/contracts";
import { FileText } from "lucide-react";
import { useRef } from "react";

import { agoText, formatStamp } from "@/lib/time";
import { useNow } from "@/lib/use-now";

import { showDoc } from "./doc-pane-store";
import { useDocs, useThreadWorkspace } from "./doc-queries";

/** The doc `threadId` last published or updated, newest first by its last save; else none. */
export const pinnedDocOf = (
  docs: readonly DocMeta[] | undefined,
  threadId: ThreadId,
): DocMeta | undefined =>
  docs
    ?.filter((doc) => doc.authorThreadId === threadId)
    .toSorted((a, b) => b.updatedAt - a.updatedAt)[0];

/**
 * Above the composer of a thread that has published a doc: "<title> · updated <age>", which opens
 * it in the Docs tab, so the doc it is working on stays one click away however far the transcript
 * has scrolled past its card.
 */
export function PinnedDocChip({ threadId }: { threadId: ThreadId }) {
  const workspaceId = useThreadWorkspace(threadId);
  const docs = useDocs(workspaceId);
  const ref = useRef<HTMLDivElement>(null);
  const now = useNow(true, ref, 60_000);
  const doc = pinnedDocOf(docs.data?.docs, threadId);
  if (workspaceId === undefined || doc === undefined) return null;
  return (
    <div ref={ref} className="flex w-full thread-column shrink-0 px-6 pb-2">
      <button
        type="button"
        data-testid="pinned-doc"
        data-doc-id={doc.id}
        title={`Open ${doc.title} · updated ${formatStamp(doc.updatedAt, now)}`}
        className="flex max-w-full min-w-0 items-center gap-1.5 rounded-full border border-edge bg-card px-2.5 py-1 text-meta outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => showDoc(workspaceId, doc.id)}
      >
        <FileText aria-hidden className="size-icon-chip shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-medium">{doc.title}</span>
        <span className="shrink-0 text-muted-foreground">
          · updated {agoText(doc.updatedAt, now)}
        </span>
      </button>
    </div>
  );
}
