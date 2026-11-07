import type { DocMeta, WorkspaceId } from "@gram/contracts";
import { useRef } from "react";

import { QueryError } from "@/components/not-available";
import { Button } from "@/components/ui/button";
import { agoText, formatStamp } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useNow } from "@/lib/use-now";

import { showAllDocs, showDoc } from "./doc-pane-store";
import { useDocs } from "./doc-queries";
import { DocThumbnail } from "./doc-thumbnail";

/** How many docs the strip shows before View all. */
export const DOCS_STRIP_LIMIT = 3;

/**
 * The workspace's latest docs as cards, with View all, for a status panel to embed: each opens in
 * the Docs tab, and View all shows the whole list there. Nothing while the workspace has none,
 * unless `empty` asks for its line.
 */
export function DocsStrip({
  workspaceId,
  limit = DOCS_STRIP_LIMIT,
  empty = false,
  className,
}: {
  workspaceId: WorkspaceId;
  limit?: number;
  /** Say "No docs yet" rather than render nothing. */
  empty?: boolean;
  className?: string;
}) {
  const docs = useDocs(workspaceId);
  const ref = useRef<HTMLElement>(null);
  const now = useNow(true, ref, 60_000);
  const list = docs.data?.docs ?? [];
  if (docs.error)
    return (
      <QueryError
        error={docs.error}
        feature="Docs"
        {...(className === undefined ? {} : { className })}
      />
    );
  if (list.length === 0 && !empty) return null;
  return (
    <section
      ref={ref}
      aria-label="Docs"
      data-testid="docs-strip"
      className={cn("flex flex-col gap-2", className)}
    >
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-body-strong">Docs</h3>
        {list.length > 0 && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="text-muted-foreground"
            data-testid="docs-view-all"
            onClick={() => showAllDocs(workspaceId)}
          >
            View all{list.length > limit ? ` ${list.length}` : ""}
          </Button>
        )}
      </header>
      {list.length === 0 ? (
        <p className="text-meta text-muted-foreground">No docs yet</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {list.slice(0, limit).map((doc) => (
            <li key={doc.id}>
              <DocRow doc={doc} now={now} onOpen={() => showDoc(workspaceId, doc.id)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One doc as a row: its thumbnail, title, and who saved it last and when. */
export function DocRow({
  doc,
  now,
  onOpen,
  excerpt = false,
}: {
  doc: DocMeta;
  now: number;
  onOpen: () => void;
  /** Show its opening words under the title, as the full list does. */
  excerpt?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid="doc-row"
      data-doc-id={doc.id}
      aria-label={`Open ${doc.title}`}
      className="flex w-full items-start gap-3 rounded-md border border-edge bg-card px-2.5 py-2 text-start outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onOpen}
    >
      <DocThumbnail className="h-10 w-8 p-1" />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-body-strong">{doc.title}</span>
        <span
          className="block truncate text-meta text-muted-foreground"
          title={`Updated ${formatStamp(doc.updatedAt, now)}`}
        >
          {doc.updatedBy === "user" ? "You" : doc.authorTitle} · {agoText(doc.updatedAt, now)}
        </span>
        {excerpt && doc.excerpt !== "" && (
          <span className="mt-0.5 line-clamp-2 text-meta text-muted-foreground">{doc.excerpt}</span>
        )}
      </span>
    </button>
  );
}
