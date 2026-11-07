import type { DocId, WorkspaceId } from "@gram/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { useRef, useState, type ComponentProps } from "react";

import { useApi } from "@/api/context";
import { errorMessage, isNotFound } from "@/api/errors";
import { MessageResponse } from "@/components/ai-elements/message";
import { QueryError } from "@/components/not-available";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatStamp } from "@/lib/time";
import { useNow } from "@/lib/use-now";
import { PanelMessage } from "@/panels/panel-message";
import { copyText } from "@/settings/copy-text";

import { useDoc } from "./doc-queries";

/**
 * The doc's own headings on the pane's scale, as Memory's rendered files have them: its `# Title`
 * at the pane title's size rather than the transcript's largest, so it reads beside the panel.
 */
const HEADINGS = {
  h1: ({ children }: ComponentProps<"h1">) => (
    <h3 className="mt-5 mb-2 text-title first:mt-0">{children}</h3>
  ),
  h2: ({ children }: ComponentProps<"h2">) => (
    <h4 className="mt-5 mb-2 text-reading font-semibold first:mt-0">{children}</h4>
  ),
  h3: ({ children }: ComponentProps<"h3">) => (
    <h5 className="mt-4 mb-1.5 text-reading font-medium first:mt-0">{children}</h5>
  ),
  h4: ({ children }: ComponentProps<"h4">) => (
    <h6 className="mt-3 mb-1.5 text-reading font-medium first:mt-0">{children}</h6>
  ),
};

/**
 * The doc's Markdown without a leading `# Title` that only repeats the title its header shows, so
 * the reader says its title once.
 */
export function withoutRepeatedTitle(content: string, title: string): string {
  const match = /^\s*#[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/.exec(content);
  if (match === null) return content;
  return sameWords(match[1]!) === sameWords(title)
    ? content.slice(match[0].length).trimStart()
    : content;
}

const sameWords = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Its tables read in the page's own scroll at their full height, with no box of their own to
 * scroll and no toolbar: Copy Markdown already copies the doc, tables and all.
 */
const DOC_TABLES = { table: false } as const;

/**
 * One doc in the Docs tab: its title, who wrote it and when (24-hour, `formatStamp`), and its
 * Markdown rendered as the transcript renders a message, at the reading size and measure. Edit
 * turns the body into its Markdown source to change and Save; a save over a revision the agent
 * moved on since is refused by the server, and said here, so neither side's text is lost.
 */
export function DocView({
  workspaceId,
  id,
  onBack,
}: {
  workspaceId: WorkspaceId;
  id: DocId;
  onBack: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const doc = useDoc(workspaceId, id);
  const ref = useRef<HTMLElement>(null);
  const now = useNow(true, ref, 60_000);
  /** The Markdown being edited and the revision it was opened at; absent while reading. */
  const [draft, setDraft] = useState<{ text: string; revision: number } | undefined>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);

  const back = (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      className="-ms-1.5 self-start text-muted-foreground"
      data-testid="doc-back"
      onClick={onBack}
    >
      <ChevronLeft data-icon="inline-start" />
      All docs
    </Button>
  );

  if (doc.error) {
    return (
      <section ref={ref} className="flex flex-col gap-3 px-4 py-4">
        {back}
        {isNotFound(doc.error) ? (
          <PanelMessage>This doc is gone</PanelMessage>
        ) : (
          <QueryError error={doc.error} feature="This doc" />
        )}
      </section>
    );
  }
  if (doc.data === undefined) {
    return (
      <section ref={ref} className="flex flex-col gap-3 px-4 py-4">
        {back}
        <PanelMessage loading>Reading the doc…</PanelMessage>
      </section>
    );
  }
  const data = doc.data;
  const edited = data.updatedAt !== data.createdAt || data.revision > 1;
  const movedOn = draft !== undefined && draft.revision !== data.revision;

  const save = async () => {
    if (draft === undefined) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      await api.saveDoc(workspaceId, id, draft.text, draft.revision);
      await queryClient.invalidateQueries({ queryKey: ["docs", workspaceId] });
      setDraft(undefined);
    } catch (error) {
      setSaveError(errorMessage(error).replace(/^InvalidState: /, ""));
    } finally {
      setSaving(false);
    }
  };

  return (
    <article
      ref={ref}
      aria-label={data.title}
      data-testid="doc-view"
      data-doc-id={data.id}
      data-revision={data.revision}
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4"
    >
      {back}
      <header className="flex flex-col gap-1">
        <h2 data-testid="doc-title" className="text-title text-pretty">
          {data.title}
        </h2>
        <p data-testid="doc-meta" className="text-meta text-muted-foreground">
          By {data.authorTitle} · {formatStamp(data.createdAt, now)}
          {edited &&
            ` · updated ${formatStamp(data.updatedAt, now)}${data.updatedBy === "user" ? " by you" : ""}`}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant={draft === undefined ? "outline" : "secondary"}
            aria-pressed={draft !== undefined}
            data-testid="doc-edit"
            onClick={() => {
              setSaveError(undefined);
              setDraft(
                draft === undefined ? { text: data.content, revision: data.revision } : undefined,
              );
            }}
          >
            {draft === undefined ? "Edit" : "Editing"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-testid="doc-copy"
            onClick={() => {
              void copyText(draft?.text ?? data.content).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? "Copied" : "Copy Markdown"}
          </Button>
        </div>
      </header>
      {draft === undefined ? (
        // Styled by the transcript's own rules (`data-transcript`): the reading size and measure
        // set in Settings → Appearance → Reading, and its scale of headings, code and tables.
        // Without its toolbar a table's frame is a box around a box: only the table's own edge
        // stays, and its cells pad by a list's step so a narrow panel wraps them less.
        <div
          data-transcript=""
          data-testid="doc-body"
          className={cn(
            "min-w-0",
            "[&_[data-streamdown=table-wrapper]]:border-0 [&_[data-streamdown=table-wrapper]]:bg-transparent [&_[data-streamdown=table-wrapper]]:p-0",
            "[&_[data-streamdown=table-cell]]:px-list [&_[data-streamdown=table-header-cell]]:px-list",
          )}
        >
          <div
            data-slot="message-content"
            className="text-reading [&_ol]:list-decimal [&_ol]:ps-5 [&_ul]:list-disc [&_ul]:ps-5"
          >
            <MessageResponse components={HEADINGS} controls={DOC_TABLES} tableMaxHeight={0}>
              {withoutRepeatedTitle(data.content, data.title)}
            </MessageResponse>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          {movedOn && (
            <p role="status" data-testid="doc-moved-on" className="text-meta text-muted-foreground">
              {data.authorTitle} updated this doc while you were editing. Saving will be refused;
              copy your edit, then reopen the doc.
            </p>
          )}
          <textarea
            aria-label={`Markdown of ${data.title}`}
            data-testid="doc-editor"
            value={draft.text}
            spellCheck
            className="min-h-80 flex-1 resize-none rounded-md border border-edge bg-background p-3 font-mono text-body outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => setDraft({ ...draft, text: event.target.value })}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "s") {
                event.preventDefault();
                void save();
              }
            }}
          />
          {saveError !== undefined && (
            <p role="alert" data-testid="doc-save-error" className="text-meta text-destructive">
              {saveError}
            </p>
          )}
          <div className="flex items-center justify-end gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(undefined);
                setSaveError(undefined);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="doc-save"
              disabled={saving || draft.text === data.content}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}
