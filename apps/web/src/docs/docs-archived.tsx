import type { DocMeta, WorkspaceId } from "@gram/contracts";
import { Archive, ArchiveRestore, ChevronRight } from "lucide-react";
import { useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { useServes } from "@/api/use-serves";
import { QueryError } from "@/components/not-available";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PanelMessage } from "@/panels/panel-message";

import { useDocPane } from "./doc-pane-store";
import { matchesDocQuery, useArchivedDocs } from "./doc-queries";
import { DocRow } from "./docs-strip";

/** The most archived docs the section lists at once; past it, a search finds the rest. */
export const ARCHIVED_SHOWN_MAX = 50;

/**
 * Archive or Restore on a doc's row, as the user. A failure, such as a restore into a full set of
 * active docs, is told through `onError` in the server's words, which name the way out.
 */
export function DocArchiveButton({
  workspaceId,
  doc,
  restore = false,
  onError,
}: {
  workspaceId: WorkspaceId;
  doc: DocMeta;
  restore?: boolean;
  onError: (message: string | undefined) => void;
}) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const label = `${restore ? "Restore" : "Archive"} ${doc.title}`;
  const act = async () => {
    setBusy(true);
    onError(undefined);
    try {
      await (restore ? api.restoreDoc(workspaceId, doc.id) : api.archiveDoc(workspaceId, doc.id));
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const Icon = restore ? ArchiveRestore : Archive;
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      className="mt-1.5 shrink-0 text-muted-foreground"
      data-testid={restore ? "doc-restore" : "doc-archive"}
      aria-label={label}
      title={restore ? "Restore" : "Archive"}
      disabled={busy}
      onClick={() => void act()}
    >
      <Icon className="size-icon-row" />
    </Button>
  );
}

/**
 * The Docs tab's "Archived (N)" section, folded until opened: the archived docs matching the
 * search, each with Restore, at most `ARCHIVED_SHOWN_MAX` and the rest counted. Hidden on a server
 * older than the archive.
 */
export function ArchivedDocs({
  workspaceId,
  count,
  query,
  now,
  onError,
}: {
  workspaceId: WorkspaceId;
  count: number;
  query: string;
  now: number;
  onError: (message: string | undefined) => void;
}) {
  const serves = useServes("docs.listArchived");
  const restores = useServes("docs.restore");
  const [open, setOpen] = useState(false);
  const archived = useArchivedDocs(workspaceId, open && serves);
  const setDoc = useDocPane((s) => s.setOpen);
  if (!serves || count === 0) return null;
  const found = (archived.data?.docs ?? []).filter((doc) => matchesDocQuery(doc, query));
  const shown = found.slice(0, ARCHIVED_SHOWN_MAX);
  return (
    <section aria-label="Archived docs" data-testid="docs-archived" className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        data-testid="docs-archived-toggle"
        className="flex items-center gap-inset rounded-md px-0.5 pt-1 text-start text-body outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setOpen((was) => !was)}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-icon-chip text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="font-medium text-foreground">Archived</span>
        <span className="text-meta text-muted-foreground tabular-nums">{count}</span>
      </button>
      {open &&
        (archived.error ? (
          <QueryError error={archived.error} feature="Archived docs" />
        ) : archived.data === undefined ? (
          <PanelMessage loading>Reading archived docs…</PanelMessage>
        ) : found.length === 0 ? (
          <p className="px-0.5 text-meta text-muted-foreground">
            {query.trim() === "" ? "No archived docs." : "No archived doc matches."}
          </p>
        ) : (
          <>
            <ul className="flex flex-col gap-1">
              {shown.map((doc) => (
                <li key={doc.id} className="flex items-start gap-1">
                  <div className="min-w-0 flex-1">
                    <DocRow doc={doc} now={now} onOpen={() => setDoc(workspaceId, doc.id)} />
                  </div>
                  {restores && (
                    <DocArchiveButton
                      workspaceId={workspaceId}
                      doc={doc}
                      restore
                      onError={onError}
                    />
                  )}
                </li>
              ))}
            </ul>
            {found.length > shown.length && (
              <p className="px-0.5 text-meta text-muted-foreground">
                {found.length - shown.length} more. Search to find one.
              </p>
            )}
          </>
        ))}
    </section>
  );
}
