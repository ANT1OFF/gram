import type { MemoryFileInfo, WorkspaceId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { FileText, Pencil } from "lucide-react";
import { useRef, type ComponentProps } from "react";

import { useApi } from "@/api/context";
import { MessageResponse } from "@/components/ai-elements/message";
import { QueryError } from "@/components/not-available";
import { Button } from "@/components/ui/button";
import { agoText } from "@/lib/time";
import { useNow } from "@/lib/use-now";
import { PanelMessage } from "@/panels/panel-message";

/** How many files "Recently changed" lists. */
const RECENT = 3;

/** A file's name as a link to it in Files, where its size, cap and editor are. */
const FILE_LINK =
  "rounded-sm font-mono text-meta text-link underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring";

/**
 * A file's own headings, each a level under the file's name, so its `# Goals` doesn't stand as the
 * page's title beside "Memory · <workspace>".
 */
const HEADINGS = {
  h1: ({ children }: ComponentProps<"h1">) => (
    <h3 className="mt-4 mb-2 text-title first:mt-0">{children}</h3>
  ),
  h2: ({ children }: ComponentProps<"h2">) => (
    <h4 className="mt-4 mb-2 text-reading font-semibold first:mt-0">{children}</h4>
  ),
  h3: ({ children }: ComponentProps<"h3">) => (
    <h5 className="mt-3 mb-1.5 text-reading font-medium first:mt-0">{children}</h5>
  ),
  h4: ({ children }: ComponentProps<"h4">) => (
    <h6 className="mt-3 mb-1.5 text-reading font-medium first:mt-0">{children}</h6>
  ),
};

/**
 * The Memory view's first tab: what the orchestrator knows now, read as rendered Markdown, one file
 * after another, under the few files changed most recently. Each file's name opens it in Files,
 * and Edit beside it opens its editor there; sizes and caps are file details, kept to Files.
 */
export function MemoryOverview({
  workspaceId,
  files,
  onOpen,
}: {
  workspaceId: WorkspaceId;
  files: readonly MemoryFileInfo[];
  /** Opens `path` in Files, ready to edit. */
  onOpen: (path: string) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const now = useNow(true, ref, 60_000);
  const recent = files.toSorted((a, b) => b.modifiedAt - a.modifiedAt).slice(0, RECENT);
  return (
    <section
      ref={ref}
      aria-label="Current memory"
      data-testid="memory-overview"
      className="flex flex-col gap-4"
    >
      <h2 className="sr-only">Current memory</h2>
      <p className="text-meta text-muted-foreground">
        What the orchestrator starts every session from. It writes here as it learns; so can you.
      </p>
      {files.length === 0 ? (
        <p className="text-meta text-muted-foreground">Memory is empty.</p>
      ) : (
        <>
          <div
            data-testid="memory-recent"
            className="flex flex-col gap-1 rounded-(--radius-md) border border-border bg-card/40 p-3"
          >
            <h3 className="text-meta font-medium text-muted-foreground">Recently changed</h3>
            <ul className="flex flex-col gap-0.5">
              {recent.map((file) => (
                <li key={file.path} className="flex items-baseline gap-2 text-meta">
                  <button type="button" className={FILE_LINK} onClick={() => onOpen(file.path)}>
                    {file.path}
                  </button>
                  <span className="text-muted-foreground tabular-nums">
                    {agoText(file.modifiedAt, now)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          {files.map((file) => (
            <OverviewFile
              key={file.path}
              workspaceId={workspaceId}
              file={file}
              now={now}
              onOpen={() => onOpen(file.path)}
            />
          ))}
        </>
      )}
    </section>
  );
}

/** One memory file, rendered: its name and age, Edit, and its Markdown. */
function OverviewFile({
  workspaceId,
  file,
  now,
  onOpen,
}: {
  workspaceId: WorkspaceId;
  file: MemoryFileInfo;
  now: number;
  onOpen: () => void;
}) {
  const api = useApi();
  // The same query the editor reads, so opening a file to edit it shows what was read here.
  const content = useQuery({
    queryKey: ["memory", workspaceId, "file", file.path],
    queryFn: () => api.readMemory(workspaceId, file.path),
    retry: false,
  });
  return (
    <article
      aria-label={file.path}
      data-testid="memory-overview-file"
      data-path={file.path}
      className="flex flex-col gap-2 rounded-(--radius-md) border border-border bg-card/40 p-3"
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <FileText aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <button
          type="button"
          data-testid="memory-overview-source"
          aria-label={`Open ${file.path} in Files`}
          className={FILE_LINK}
          onClick={onOpen}
        >
          {file.path}
        </button>
        <span className="text-meta text-muted-foreground tabular-nums">
          changed {agoText(file.modifiedAt, now)}
        </span>
        <Button
          size="xs"
          variant="outline"
          data-testid="memory-overview-edit"
          aria-label={`Edit ${file.path}`}
          className="ms-auto"
          onClick={onOpen}
        >
          <Pencil data-icon="inline-start" />
          Edit
        </Button>
      </header>
      {content.error ? (
        <QueryError error={content.error} feature={file.path} />
      ) : content.data === undefined ? (
        <PanelMessage loading>Reading {file.path}…</PanelMessage>
      ) : content.data.content.trim() === "" ? (
        <p className="text-meta text-muted-foreground">Empty.</p>
      ) : (
        <div className="max-w-3xl text-reading leading-relaxed [&_ol]:list-decimal [&_ol]:ps-5 [&_ul]:list-disc [&_ul]:ps-5">
          <MessageResponse components={HEADINGS}>{content.data.content}</MessageResponse>
        </div>
      )}
    </article>
  );
}
