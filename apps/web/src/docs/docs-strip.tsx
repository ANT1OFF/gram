import type { DocMeta, WorkspaceId } from "@gram/contracts";
import { useId, useRef, useState } from "react";

import { QueryError } from "@/components/not-available";
import { agoText, formatRelative, formatStamp } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useNow } from "@/lib/use-now";
import { GroupHeading, ROW_GRID, ROW_NOTE } from "@/orchestration/workers-group";

import { showAllDocs, showDoc } from "./doc-pane-store";
import { useDocs } from "./doc-queries";
import { DocThumbnail } from "./doc-thumbnail";

/** How many docs the strip shows before "N more". */
export const DOCS_STRIP_LIMIT = 3;

/**
 * The workspace's latest docs as a section of a status panel, in its groups' shape: a heading that
 * folds, with the count of them all, then one line a doc (its title and age), and "N more" into
 * the Docs tab's whole list. Each opens in the Docs tab. Nothing while the workspace has none,
 * unless `empty` asks for its line. `fold` lets the panel keep the fold; else it is the strip's.
 */
export function DocsStrip({
  workspaceId,
  limit = DOCS_STRIP_LIMIT,
  empty = false,
  fold,
  className,
}: {
  workspaceId: WorkspaceId;
  limit?: number;
  /** Say "No docs yet" rather than render nothing. */
  empty?: boolean;
  fold?: { readonly folded: boolean; readonly onToggle: () => void };
  className?: string;
}) {
  const docs = useDocs(workspaceId);
  const ref = useRef<HTMLElement>(null);
  const now = useNow(true, ref, 60_000);
  const [own, setOwn] = useState(false);
  const body = useId();
  const folded = fold?.folded ?? own;
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
  const more = list.length - limit;
  return (
    <section
      ref={ref}
      aria-label="Docs"
      data-testid="docs-strip"
      data-count={list.length}
      className={cn("flex flex-col gap-tight", className)}
    >
      <GroupHeading
        label="Docs"
        count={list.length}
        folded={folded}
        controls={body}
        onToggle={fold?.onToggle ?? (() => setOwn((was) => !was))}
      />
      <div id={body} hidden={folded} className="flex flex-col">
        {list.length === 0 ? (
          <p className={cn(ROW_GRID, "text-meta text-muted-foreground")}>
            <span className="col-start-2">No docs yet</span>
          </p>
        ) : (
          <ul className="flex flex-col">
            {list.slice(0, limit).map((doc) => (
              <li key={doc.id}>
                <DocLine doc={doc} now={now} onOpen={() => showDoc(workspaceId, doc.id)} />
              </li>
            ))}
          </ul>
        )}
        {more > 0 && (
          <button
            type="button"
            data-testid="docs-view-all"
            aria-label={`${more} more docs: view all ${list.length}`}
            onClick={() => showAllDocs(workspaceId)}
            className={ROW_NOTE}
          >
            <span className="col-start-2">{more} more</span>
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * One doc on one line, as a worker's row is drawn but without a second line: its title, cut at its
 * end, and its age. Who saved it last, and when, is on its hover.
 */
function DocLine({ doc, now, onOpen }: { doc: DocMeta; now: number; onOpen: () => void }) {
  const who = doc.updatedBy === "user" ? "You" : doc.authorTitle;
  return (
    <button
      type="button"
      data-testid="doc-row"
      data-doc-id={doc.id}
      aria-label={`Open ${doc.title}`}
      title={`${doc.title}\n${who} · updated ${formatStamp(doc.updatedAt, now)}`}
      className={cn(
        ROW_GRID,
        "items-center rounded-xs py-1 text-left text-body outline-none hover:bg-accent focus-visible:focus-ring",
      )}
      onClick={onOpen}
    >
      <span className="col-start-2 min-w-0 truncate text-foreground">{doc.title}</span>
      <span data-testid="doc-row-age" className="text-meta text-muted-foreground tabular-nums">
        {formatRelative(doc.updatedAt, now)}
      </span>
    </button>
  );
}

/**
 * A doc's line under its title: who saved it last and when, and which version it is once it has
 * been saved again ("cp-artifacts · 5m ago · version 3"). Under its author's own heading
 * (`grouped`) the author is left out, and only your own edit is named.
 */
export const docByline = (doc: DocMeta, now: number, grouped = false): string =>
  [
    doc.updatedBy === "user" ? "You" : grouped ? undefined : doc.authorTitle,
    agoText(doc.updatedAt, now),
    doc.revision > 1 ? `version ${doc.revision}` : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" · ");

/** One doc as a row: its thumbnail, title, and who saved it last and when. */
export function DocRow({
  doc,
  now,
  onOpen,
  excerpt = false,
  grouped = false,
}: {
  doc: DocMeta;
  now: number;
  onOpen: () => void;
  /** Show its opening words under the title, as the full list does. */
  excerpt?: boolean;
  /** Under its author's heading, which names who wrote it. */
  grouped?: boolean;
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
          {docByline(doc, now, grouped)}
        </span>
        {excerpt && doc.excerpt !== "" && (
          <span className="mt-0.5 line-clamp-2 text-meta text-muted-foreground">{doc.excerpt}</span>
        )}
      </span>
    </button>
  );
}
