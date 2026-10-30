import type { DiffFile, DiffFileStatus } from "@gram/contracts";
import {
  ChevronRight,
  FileMinus,
  FilePen,
  FilePlus,
  FileQuestionMark,
  FileSymlink,
  FolderOpen,
  FolderSearch,
  SquareArrowOutUpRight,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { revealLabel } from "@/editor/use-open-in-editor";
import { cn } from "@/lib/utils";
import { Expand, NumberTicker } from "@/motion";
import type { DiffLayout } from "@/stores/layout";

import { PatchView } from "./patch-view";

/** Changed lines past which a file starts collapsed, however few files there are. */
const LARGE_FILE_LINES = 400;

/** A request to open a file, and bring it (or one of its hunks) into view; `key` tells requests apart. */
export interface DiffFocus {
  path: string;
  key: number;
  hunk?: number | undefined;
}

/**
 * Glyph, letter and label per file status, so status never relies on colour alone. A row shows
 * the letter, git's own, with the label on hover and for a screen reader.
 */
export const FILE_STATUS: Record<
  DiffFileStatus,
  { icon: LucideIcon; letter: string; label: string; tone: string }
> = {
  added: { icon: FilePlus, letter: "A", label: "Added", tone: "text-success" },
  modified: { icon: FilePen, letter: "M", label: "Modified", tone: "text-info" },
  deleted: { icon: FileMinus, letter: "D", label: "Deleted", tone: "text-destructive" },
  renamed: { icon: FileSymlink, letter: "R", label: "Renamed", tone: "text-highlight" },
  untracked: { icon: FileQuestionMark, letter: "U", label: "Untracked", tone: "text-warning" },
};

/** A file's own actions, over the row's end while it is hovered or one of them has focus. */
const ROW_ACTIONS =
  "absolute inset-y-0 right-0 flex items-center bg-panel opacity-0 focus-within:opacity-100 group-hover/file:opacity-100";
const ROW_ACTION =
  "me-2 shrink-0 rounded-sm p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

/** ↑ / ↓ on a file header move to the previous / next file's header, past any open patch. */
function moveBetweenHeaders(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const list = event.currentTarget.closest("ul");
  if (!list) return;
  const headers = [...list.querySelectorAll<HTMLElement>("[data-diff-file-header]")];
  const next = headers[headers.indexOf(event.currentTarget) + (event.key === "ArrowDown" ? 1 : -1)];
  if (!next) return;
  event.preventDefault();
  next.focus();
}

/**
 * Files with collapsible patches; small change sets start expanded, except a file with more than
 * `LARGE_FILE_LINES` changed lines. Each file that still exists gets "Show in Files" with `onReveal`,
 * "Open in editor" with `onOpenInEditor` and "Reveal in Finder" with `onRevealInFileManager` (`path`
 * is relative to the checkout). `focus` expands and scrolls to the file at `focus.path`, or to its
 * hunk `focus.hunk`, again whenever `focus.key` changes.
 */
export function DiffFileList({
  files,
  layout = "unified",
  onReveal,
  onOpenInEditor,
  onRevealInFileManager,
  focus,
}: {
  files: readonly DiffFile[];
  layout?: DiffLayout;
  onReveal?: (path: string) => void;
  onOpenInEditor?: (path: string) => void;
  onRevealInFileManager?: (path: string) => void;
  focus?: DiffFocus | undefined;
}) {
  const expanded = files.length <= 3;
  return (
    <ul className="divide-y divide-border">
      {files.map((file) => {
        const exists = file.status !== "deleted";
        return (
          <DiffFileRow
            key={file.path}
            file={file}
            layout={layout}
            defaultOpen={expanded && file.additions + file.deletions <= LARGE_FILE_LINES}
            {...(onReveal && exists ? { onReveal } : {})}
            {...(onOpenInEditor && exists ? { onOpenInEditor } : {})}
            {...(onRevealInFileManager && exists ? { onRevealInFileManager } : {})}
            {...(focus?.path === file.path ? { focusKey: focus.key, focusHunk: focus.hunk } : {})}
          />
        );
      })}
    </ul>
  );
}

function DiffFileRow({
  file,
  layout,
  defaultOpen,
  onReveal,
  onOpenInEditor,
  onRevealInFileManager,
  focusKey,
  focusHunk,
}: {
  file: DiffFile;
  layout: DiffLayout;
  defaultOpen: boolean;
  onReveal?: (path: string) => void;
  onOpenInEditor?: (path: string) => void;
  onRevealInFileManager?: (path: string) => void;
  focusKey?: number;
  focusHunk?: number | undefined;
}) {
  const [open, setOpen] = useState(defaultOpen || focusKey !== undefined);
  // A patch renders while open, and until its collapse has animated: a closed row costs nothing,
  // which matters for a lockfile's thousands of lines.
  const [rendered, setRendered] = useState(open);
  const [focusedKey, setFocusedKey] = useState(focusKey);
  const bodyId = useId();
  const rowRef = useRef<HTMLLIElement>(null);
  const status = FILE_STATUS[file.status];

  if (focusKey !== focusedKey) {
    setFocusedKey(focusKey);
    if (focusKey !== undefined) setOpen(true);
  }
  if (open && !rendered) setRendered(true);

  useEffect(() => {
    const body = rowRef.current?.querySelector<HTMLElement>(".gram-expand");
    if (open || !rendered || !body) return;
    // Only the height transition ends the collapse: Reduced motion still fades, but at once.
    const style = getComputedStyle(body);
    const properties = style.transitionProperty.split(",").map((p) => p.trim());
    const durations = style.transitionDuration.split(",");
    const at = properties.findIndex((p) => p === "height" || p === "all");
    const still = at === -1 || !(Number.parseFloat(durations[at % durations.length] ?? "") > 0);
    if (still) return setRendered(false);
    const closed = (event: TransitionEvent) => {
      if (event.target === body && event.propertyName === "height") setRendered(false);
    };
    body.addEventListener("transitionend", closed);
    return () => body.removeEventListener("transitionend", closed);
  }, [open, rendered]);

  useEffect(() => {
    const row = rowRef.current;
    if (focusKey === undefined || !row) return;
    const reveal = () =>
      (focusHunk === undefined
        ? row
        : row.querySelector(`[data-hunk="${focusHunk}"]`)
      )?.scrollIntoView({ block: "start" });
    reveal();
    // A row that was closed is still growing, and the list may be too short to scroll that far until
    // it has: look again once it has opened.
    const body = row.querySelector<HTMLElement>(".gram-expand");
    if (!body || body.getBoundingClientRect().height >= body.scrollHeight - 1) return;
    const grown = (event: TransitionEvent) => {
      if (event.target === body && event.propertyName === "height") reveal();
    };
    body.addEventListener("transitionend", grown);
    return () => body.removeEventListener("transitionend", grown);
  }, [focusKey, focusHunk]);

  return (
    <li ref={rowRef} data-testid="diff-file" data-path={file.path}>
      <div className="group/file relative flex items-center hover:bg-muted/50">
        <button
          type="button"
          data-diff-file-header
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((o) => !o)}
          onKeyDown={moveBetweenHeaders}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--dur-fast)",
              open && "rotate-90",
            )}
          />
          <status.icon aria-hidden className={cn("size-3.5 shrink-0", status.tone)} />
          <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>
            {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
          </span>
          <span
            title={status.label}
            className={cn("shrink-0 font-mono font-semibold", status.tone)}
          >
            <span aria-hidden>{status.letter}</span>
            <span className="sr-only">{status.label}</span>
          </span>
          <span className="shrink-0 font-mono tabular-nums">
            <span className="text-success">
              +<NumberTicker value={file.additions} />
            </span>{" "}
            <span className="text-destructive">
              −<NumberTicker value={file.deletions} />
            </span>
          </span>
        </button>
        <div className={ROW_ACTIONS}>
          {onReveal && (
            <button
              type="button"
              aria-label={`Show ${file.path} in Files`}
              title="Show in Files"
              onClick={() => onReveal(file.path)}
              className={ROW_ACTION}
            >
              <FolderSearch aria-hidden className="size-3.5" />
            </button>
          )}
          {onOpenInEditor && (
            <button
              type="button"
              aria-label={`Open ${file.path} in editor`}
              title="Open in editor"
              onClick={() => onOpenInEditor(file.path)}
              className={ROW_ACTION}
            >
              <SquareArrowOutUpRight aria-hidden className="size-3.5" />
            </button>
          )}
          {onRevealInFileManager && (
            <button
              type="button"
              aria-label={revealLabel(file.path)}
              title={revealLabel()}
              onClick={() => onRevealInFileManager(file.path)}
              className={ROW_ACTION}
            >
              <FolderOpen aria-hidden className="size-3.5" />
            </button>
          )}
        </div>
      </div>
      <Expand open={open} id={bodyId}>
        {rendered && (
          <div className="border-t border-border bg-card/40">
            <PatchView
              file={file}
              layout={layout}
              current={focusHunk}
              revealKey={focusHunk === undefined ? undefined : focusKey}
            />
          </div>
        )}
      </Expand>
    </li>
  );
}
