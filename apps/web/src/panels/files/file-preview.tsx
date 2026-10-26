import type { ThreadId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { FileCode, FolderOpen, SquareArrowOutUpRight, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
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
    queryKey: ["fs.file", threadId, path],
    queryFn: () => api.fsFile(path, { threadId }),
    enabled: !image,
    retry: false,
  });
  const relative = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  // Opened unscoped: `threadId` would hold the editor and the file manager to the checkouts.
  const scope = elsewhere ? {} : { threadId };
  const file = image ? undefined : query.data;
  const reveal = revealLabel();
  const content = file?.content;

  useEffect(() => {
    if (line === undefined || content === undefined || (markdown && view !== "source")) return;
    scroller.current
      ?.querySelector(`[data-line="${line}"]`)
      ?.scrollIntoView({ block: "center", behavior: "auto" });
    // `reveals` changes when the same line is opened again, which should scroll back to it.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
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
  } else if (query.status === "error") {
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
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1 text-xs">
        <FileCode aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
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
              <SquareArrowOutUpRight />
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
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto text-xs">
        {body}
      </div>
    </div>
  );
}
