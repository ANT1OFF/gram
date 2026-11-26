import type { DocMeta, ThreadId, WorkspaceId } from "@gram/contracts";
import { FileText } from "lucide-react";
import { useRef, useState } from "react";

import { EmptyState } from "@/components/empty-state";
import { QueryError } from "@/components/not-available";
import { useNow } from "@/lib/use-now";
import { useMessageOrchestrator } from "@/orchestration/message-orchestrator";
import { PanelMessage } from "@/panels/panel-message";

import { useServes } from "@/api/use-serves";

import { ArchivedDocs, DocArchiveButton } from "./docs-archived";
import { useDocPane } from "./doc-pane-store";
import { matchesDocQuery, useDocs } from "./doc-queries";
import { DocView } from "./doc-view";
import { DocRow } from "./docs-strip";

/**
 * The right panel's Docs tab: the active docs of the workspace the window is on (its
 * orchestrator's, or the viewed thread's), newest first, searchable by title, each with Archive,
 * and its archived docs folded below; or the one a card, the chip above the composer or a row
 * opened. Docs live in Gram's own state on this machine.
 */
export function DocsPanel({ workspaceId }: { workspaceId: WorkspaceId | undefined }) {
  const open = useDocPane((s) => (workspaceId === undefined ? undefined : s.open[workspaceId]));
  const setOpen = useDocPane((s) => s.setOpen);
  if (workspaceId === undefined) {
    return (
      <PanelMessage>
        Docs belong to a workspace. Open a workspace or one of its threads to see them.
      </PanelMessage>
    );
  }
  if (open !== undefined) {
    return (
      <DocView
        key={open}
        workspaceId={workspaceId}
        id={open}
        onBack={() => setOpen(workspaceId, undefined)}
      />
    );
  }
  return <DocsList workspaceId={workspaceId} />;
}

/** The docs one thread published, under its title as it was when it last published. */
export interface DocGroup {
  readonly authorThreadId: ThreadId;
  readonly authorTitle: string;
  readonly docs: readonly DocMeta[];
}

/**
 * A workspace's docs by the task (thread) that published them, in the order the list gives them:
 * a group stands where its newest doc does, and its docs keep their order.
 */
export const docsByAuthor = (docs: readonly DocMeta[]): readonly DocGroup[] => {
  const groups = new Map<ThreadId, { authorTitle: string; docs: DocMeta[] }>();
  for (const doc of docs) {
    const group = groups.get(doc.authorThreadId);
    if (group === undefined) {
      groups.set(doc.authorThreadId, { authorTitle: doc.authorTitle, docs: [doc] });
    } else group.docs.push(doc);
  }
  return [...groups].map(([authorThreadId, group]) => ({ authorThreadId, ...group }));
};

function DocsList({ workspaceId }: { workspaceId: WorkspaceId }) {
  const docs = useDocs(workspaceId);
  const setOpen = useDocPane((s) => s.setOpen);
  const ref = useRef<HTMLElement>(null);
  const now = useNow(true, ref, 60_000);
  const messageOrchestrator = useMessageOrchestrator();
  const archives = useServes("docs.archive");
  const [query, setQuery] = useState("");
  const [actionError, setActionError] = useState<string>();
  if (docs.error) return <QueryError error={docs.error} feature="Docs" />;
  if (docs.data === undefined) return <PanelMessage loading>Reading docs…</PanelMessage>;
  const all = docs.data.docs;
  const archivedCount = docs.data.archived ?? 0;
  const list = all.filter((doc) => matchesDocQuery(doc, query));
  const groups = docsByAuthor(list);
  const grouped = groups.length > 1;
  if (all.length === 0 && archivedCount === 0) {
    return (
      <EmptyState
        testId="docs-empty"
        icon={FileText}
        title="No docs yet"
        line="Reports, plans and analyses this workspace's threads publish land here. They stay on this computer, outside your repos."
        action={{
          label: "Message the orchestrator",
          onClick: () => messageOrchestrator(workspaceId),
        }}
      />
    );
  }
  return (
    <section
      ref={ref}
      aria-label="Docs"
      data-testid="docs-list"
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4"
    >
      <p className="text-meta text-muted-foreground">
        Reports, plans and analyses this workspace's threads published. They stay in Gram on this
        computer, outside your repos.
      </p>
      <input
        type="search"
        aria-label="Search docs"
        placeholder="Search by title"
        data-testid="docs-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="rounded-md border border-edge bg-transparent px-2.5 py-1.5 text-meta outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
      />
      {actionError !== undefined && (
        <p role="alert" data-testid="docs-action-error" className="text-meta text-destructive">
          {actionError}
        </p>
      )}
      {list.length === 0 && (
        <p className="text-meta text-muted-foreground">
          {all.length === 0 ? "Every doc here is archived." : "No doc matches."}
        </p>
      )}
      {groups.map((group) => (
        <section
          key={group.authorThreadId}
          aria-label={grouped ? group.authorTitle : "Docs"}
          data-testid="docs-group"
          className="flex flex-col gap-1"
        >
          {grouped && (
            <h3
              data-testid="docs-group-title"
              className="flex items-baseline gap-inset px-0.5 pt-1 text-body"
            >
              <span className="min-w-0 truncate font-medium text-foreground">
                {group.authorTitle}
              </span>
              <span className="text-meta text-muted-foreground tabular-nums">
                {group.docs.length}
              </span>
            </h3>
          )}
          <ul className="flex flex-col gap-1">
            {group.docs.map((doc) => (
              <li key={doc.id} className="flex items-start gap-1">
                <div className="min-w-0 flex-1">
                  <DocRow
                    doc={doc}
                    now={now}
                    excerpt
                    grouped={grouped}
                    onOpen={() => setOpen(workspaceId, doc.id)}
                  />
                </div>
                {archives && (
                  <DocArchiveButton workspaceId={workspaceId} doc={doc} onError={setActionError} />
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
      <ArchivedDocs
        workspaceId={workspaceId}
        count={archivedCount}
        query={query}
        now={now}
        onError={setActionError}
      />
    </section>
  );
}
