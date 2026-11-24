import type { FsFile, ThreadId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { FileCode, FolderOpen, History, SquareArrowUpRightExit, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { BundledLanguage } from "shiki";

import { useApi } from "@/api/context";
import { CodeBlockContent } from "@/components/ai-elements/code-block";
import { Button } from "@/components/ui/button";
import {
  revealLabel,
  useOpenInEditor,
  useOpensLocally,
  useRevealInFileManager,
} from "@/editor/use-open-in-editor";
import { SegmentSlab, Shimmer } from "@/motion";
import { PanelMessage } from "@/panels/panel-message";

import { revealInFiles } from "./files-store";
import { filesProblem } from "./files-problem";
import { formatSize } from "./format";
import { ImagePreview } from "./image-preview";
import { MarkdownPreview } from "./markdown-preview";
import { isImagePath, isMarkdownPath } from "./relative-path";

const errorTag = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "_tag" in error ? error._tag : undefined;

const writtenFileRead = (path: string, content: string): FsFile => ({
  path,
  size: new TextEncoder().encode(content).length,
  binary: false,
  tooLarge: false,
  content,
  ...(/\.html?$/i.test(path) ? { language: "html" } : {}),
});

const keepWhileRereading =
  (path: string) =>
  <T,>(previous: T | undefined, previousQuery: { queryKey: readonly unknown[] } | undefined) =>
    previousQuery?.queryKey[2] === path ? previous : undefined;

const VIEWS = [
  { value: "preview", label: "Preview" },
  { value: "source", label: "Source" },
] as const;

/**
 * The selected file: images as a picture, markdown rendered (with a Source toggle), everything else
 * highlighted with line numbers, or why it can't be shown. A file `elsewhere`, outside the thread's
 * checkouts, is one the thread's messages named; the server reads only those, so its markdown
 * neither links nor loads what it points at.
 */
export function FilePreview({
  threadId,
  root,
  path,
  line,
  end,
  reveals,
  elsewhere = false,
  writes,
  written,
  actions,
  onClose,
}: {
  threadId: ThreadId;
  root: string;
  path: string;
  elsewhere?: boolean | undefined;
  /** Highlighted and scrolled into view; markdown shows its source so the line exists. */
  line?: number | undefined;
  /** With `line`, the last line of the highlighted range. */
  end?: number | undefined;
  /** A new value scrolls back to `line` even when it hasn't changed. */
  reveals?: number | undefined;
  /**
   * How many times the thread has written the file: a new count reads it again, keeping what was
   * shown until the new text is in, so a preview follows the agent's edits.
   */
  writes?: number | undefined;
  /**
   * The text the thread last wrote to it, from its transcript: shown, and said to be, when the file
   * can't be read (the agent switched branch or deleted it, or its machine is away).
   */
  written?: string | undefined;
  /** Before the size and Close: what the place showing the file adds (where it is, a pop out). */
  actions?: ReactNode;
  onClose: () => void;
}) {
  const api = useApi();
  const image = isImagePath(path);
  const markdown = isMarkdownPath(path);
  const [view, setView] = useState<"preview" | "source">(line === undefined ? "preview" : "source");
  const [revealed, setRevealed] = useState(reveals);
  const slab = useId();
  if (revealed !== reveals) {
    setRevealed(reveals);
    if (line !== undefined) setView("source");
  }
  const scroller = useRef<HTMLDivElement>(null);
  const openInEditor = useOpenInEditor();
  const revealInFileManager = useRevealInFileManager();
  const local = useOpensLocally();
  const query = useQuery({
    queryKey:
      writes === undefined ? ["fs.file", threadId, path] : ["fs.file", threadId, path, writes],
    queryFn: () => api.fsFile(path, { threadId }),
    enabled: !image,
    retry: false,
    placeholderData: keepWhileRereading(path),
  });
  const failed = query.status === "error";
  const gone = failed && errorTag(query.error) === "NotFound";
  const fallback = failed && written !== undefined;
  const relative = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  const scope = elsewhere ? {} : { threadId };
  const file = image ? undefined : fallback ? writtenFileRead(path, written) : query.data;
  const reveal = revealLabel();
  const content = file?.content;

  useEffect(() => {
    if (line === undefined || content === undefined || (markdown && view !== "source")) return;
    scroller.current
      ?.querySelector(`[data-line="${line}"]`)
      ?.scrollIntoView({ block: "center", behavior: "auto" });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `reveals` is a signal to scroll again, not an input
  }, [line, content, markdown, view, reveals]);

  let body;
  if (image) {
    body = <ImagePreview threadId={threadId} path={path} />;
  } else if (query.status === "pending") {
    body = (
      <PanelMessage>
        <Shimmer>Loading…</Shimmer>
      </PanelMessage>
    );
  } else if (failed && !fallback) {
    body = <PanelMessage>{filesProblem(query.error)}</PanelMessage>;
  } else if (file?.binary) {
    body = <PanelMessage>Binary file · {formatSize(file.size)}</PanelMessage>;
  } else if (file?.tooLarge || file?.content === undefined) {
    body = <PanelMessage>Too large to preview · {formatSize(file?.size ?? 0)}</PanelMessage>;
  } else if (markdown && view === "preview") {
    body = (
      <MarkdownPreview
        key={path}
        threadId={threadId}
        root={root}
        path={path}
        elsewhere={elsewhere}
        content={file.content}
        onOpen={(target) => revealInFiles(threadId, root, target)}
      />
    );
  } else {
    body = (
      <CodeBlockContent
        code={file.content}
        language={(file.language ?? "text") as BundledLanguage}
        showLineNumbers
        highlightLine={line}
        highlightEnd={end}
      />
    );
  }

  if (fallback) {
    body = (
      <>
        <p
          data-testid="file-preview-written"
          className="m-2 flex items-start gap-2 rounded-md border border-dashed border-edge px-3 py-2 text-meta text-muted-foreground"
        >
          <History aria-hidden className="mt-0.5 size-icon-row shrink-0" />
          <span>
            {gone
              ? "No longer in the thread's folder: it may have switched branch or removed the file since."
              : filesProblem(query.error)}{" "}
            This is what it last wrote there, from the conversation.
          </span>
        </p>
        {body}
      </>
    );
  }

  return (
    <div
      data-testid="file-preview"
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1 text-meta">
        <FileCode aria-hidden className="size-icon-row shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono" title={path}>
          {relative}
        </span>
        {markdown && (
          <div
            role="radiogroup"
            aria-label="Markdown view"
            className="isolate flex shrink-0 gap-0.5"
          >
            {VIEWS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={view === option.value}
                onClick={() => setView(option.value)}
                className="relative rounded-sm px-1.5 py-0.5 text-muted-foreground transition-colors duration-(--dur-fast) outline-none focus-visible:ring-2 focus-visible:ring-ring aria-checked:text-foreground"
              >
                {view === option.value && <SegmentSlab group={slab} className="bg-muted" />}
                {option.label}
              </button>
            ))}
          </div>
        )}
        {actions}
        {file && <span className="shrink-0 text-muted-foreground">{formatSize(file.size)}</span>}
        {local && (
          <>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Open in editor"
              title="Open in editor"
              onClick={() =>
                void openInEditor(path, line === undefined ? scope : { ...scope, line })
              }
            >
              <SquareArrowUpRightExit />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={reveal}
              title={reveal}
              onClick={() => void revealInFileManager(path, scope)}
            >
              <FolderOpen />
            </Button>
          </>
        )}
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Close preview"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto text-meta">
        {body}
      </div>
    </div>
  );
}
