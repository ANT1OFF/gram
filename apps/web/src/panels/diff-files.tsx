import { generatedKind, type DiffFile, type DiffFileStatus } from "@gram/contracts";
import {
  ChevronRight,
  Copy,
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

import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { revealLabel } from "@/editor/use-open-in-editor";
import { cn } from "@/lib/utils";
import { Expand, NumberTicker } from "@/motion";
import { copyText } from "@/settings/copy-text";
import type { DiffLayout } from "@/stores/layout";

import { ChunkedPatch, useDiffChunkSource } from "./diff-chunks";
import { PatchView } from "./patch-view";

/**
 * Changed lines past which a file starts collapsed, however few files there are; a diff with fewer in
 * all starts with every file open, however many there are.
 */
const LARGE_FILE_LINES = 400;
/** Files a diff may have and still start open, whatever their size in all (each under the cap). */
const FEW_FILES = 3;

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
  untracked: {
    icon: FileQuestionMark,
    letter: "U",
    label: "Untracked",
    tone: "text-muted-foreground",
  },
};

/**
 * A file's own actions, in place of its status and counts while the row is hovered or one of them
 * has focus. The panel is translucent, so they are never drawn over text: the counts give way
 * (`ROW_FACTS`) to a gap as wide as the actions (`ACTIONS_ROOM`), which the path ends before.
 */
const ROW_ACTIONS =
  "absolute inset-y-0 right-0 flex items-center opacity-0 focus-within:opacity-100 group-hover/file:opacity-100";
const ROW_ACTION =
  "me-2 shrink-0 rounded-sm p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";
/** A row's status letter and counts, gone while its actions show in their place. */
const ROW_FACTS =
  "flex shrink-0 items-center gap-2 group-hover/file:hidden group-has-[[data-row-actions]:focus-within]/file:hidden";
/** The gap under the actions while they show: one, two or three of them (`ROW_ACTION` is 2 rem). */
const ACTIONS_ROOM = ["", "w-6", "w-14", "w-22"] as const;
const ROOM_SHOWN =
  "hidden shrink-0 group-hover/file:block group-has-[[data-row-actions]:focus-within]/file:block";

/**
 * A path as a row shows it: its folders, which give way first, and the file's name, which is what
 * tells two rows of one folder apart. A rename keeps its old path with the folders.
 */
export function pathParts(file: Pick<DiffFile, "path" | "oldPath">): {
  folders: string;
  name: string;
} {
  const shown = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  const cut = shown.lastIndexOf("/") + 1;
  return { folders: shown.slice(0, cut), name: shown.slice(cut) };
}

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
 * Whether `file` waits behind its header until asked for: a patch too large to read here, a binary
 * one, one past `LARGE_FILE_LINES` changed lines, or a generated file (a lockfile, a bundle).
 */
export const gatedFile = (file: DiffFile): boolean =>
  file.tooLarge ||
  file.binary ||
  file.additions + file.deletions > LARGE_FILE_LINES ||
  generatedKind(file.path) !== undefined;

/**
 * Which of `files` start open: every one but a file past `LARGE_FILE_LINES` changed lines in a
 * small change set (`FEW_FILES` files, or under `LARGE_FILE_LINES` changed lines in all); in a
 * larger one, the first that isn't gated (`gatedFile`), so the diff never opens on a column of
 * folded headers over an empty pane.
 */
export function initiallyOpen(files: readonly DiffFile[]): boolean[] {
  const small =
    files.length <= FEW_FILES ||
    files.reduce((sum, file) => sum + file.additions + file.deletions, 0) < LARGE_FILE_LINES;
  if (small) return files.map((file) => file.additions + file.deletions <= LARGE_FILE_LINES);
  const first = files.findIndex((file) => !gatedFile(file));
  return files.map((_, at) => at === first);
}

/**
 * Files with collapsible patches, open as `initiallyOpen` says. `wrap` wraps long lines instead of
 * scrolling them. Each file that still exists gets "Show in Files" with `onReveal`, "Open in editor" with `onOpenInEditor` and "Reveal in Finder" with `onRevealInFileManager` (`path`
 * is relative to the checkout). `focus` expands and scrolls to the file at `focus.path`, or to its
 * hunk `focus.hunk`, again whenever `focus.key` changes.
 */
export function DiffFileList({
  files,
  layout = "unified",
  wrap = false,
  onReveal,
  onOpenInEditor,
  onRevealInFileManager,
  focus,
}: {
  files: readonly DiffFile[];
  layout?: DiffLayout;
  wrap?: boolean;
  onReveal?: (path: string) => void;
  onOpenInEditor?: (path: string) => void;
  onRevealInFileManager?: (path: string) => void;
  focus?: DiffFocus | undefined;
}) {
  // A file asked for as the list opens (an agent's target) is what opens, alone.
  const targeted = focus !== undefined && files.some((file) => file.path === focus.path);
  const open = initiallyOpen(files);
  return (
    <ul className="divide-y divide-border">
      {files.map((file, at) => {
        const exists = file.status !== "deleted";
        return (
          <DiffFileRow
            key={file.path}
            file={file}
            layout={layout}
            wrap={wrap}
            defaultOpen={!targeted && open[at] === true}
            {...(onReveal && exists ? { onReveal } : {})}
            {...(onOpenInEditor && exists ? { onOpenInEditor } : {})}
            {...(onRevealInFileManager && exists ? { onRevealInFileManager } : {})}
            {...(focus?.path === file.path ? { focusKey: focus.key, focusHunk: focus.hunk } : {})}
            reviewable={files.length - files.filter((f) => f.tooLarge || f.binary).length}
          />
        );
      })}
    </ul>
  );
}

function DiffFileRow({
  file,
  layout,
  wrap,
  defaultOpen,
  onReveal,
  onOpenInEditor,
  onRevealInFileManager,
  focusKey,
  focusHunk,
  reviewable,
}: {
  file: DiffFile;
  layout: DiffLayout;
  wrap: boolean;
  defaultOpen: boolean;
  /** Files in the list whose patch shows here, for a too-large file's note. */
  reviewable: number;
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
  const path = pathParts(file);
  const actions = [onReveal, onOpenInEditor, onRevealInFileManager].filter(
    (action) => action !== undefined,
  ).length as 0 | 1 | 2 | 3;

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
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-meta outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-icon-chip shrink-0 text-muted-foreground transition-transform duration-(--dur-fast)",
              open && "rotate-90",
            )}
          />
          <status.icon aria-hidden className={cn("size-icon-row shrink-0", status.tone)} />
          {/* Short of room the folders are cut, never the name: the name shrinks only once they
              are down to their ellipsis. Their share of the shrinking is a million to one, so the
              name's rounds to nothing; at a thousand to one it lost a fraction of a pixel, which
              is enough to cut its last letters. */}
          <span className="flex min-w-0 flex-1 font-mono" title={file.path}>
            {path.folders !== "" && (
              <span data-testid="diff-file-folders" className="min-w-4 shrink-[1000000] truncate">
                {path.folders}
              </span>
            )}
            <span data-testid="diff-file-name" className="min-w-0 truncate">
              {path.name}
            </span>
          </span>
          <span className={ROW_FACTS}>
            <span title={status.label} className={cn("font-mono font-semibold", status.tone)}>
              <span aria-hidden>{status.letter}</span>
              <span className="sr-only">{status.label}</span>
            </span>
            {/* A count of nothing is left out, as the file tree leaves it: "+52", never "+52 −0",
                and a binary file, which has no lines to count, shows its letter alone. */}
            {(file.additions > 0 || file.deletions > 0) && (
              <span data-testid="diff-file-counts" className="font-mono tabular-nums">
                {file.additions > 0 && (
                  <span className="text-success">
                    +<NumberTicker value={file.additions} />
                  </span>
                )}
                {file.additions > 0 && file.deletions > 0 && " "}
                {file.deletions > 0 && (
                  <span className="text-destructive">
                    −<NumberTicker value={file.deletions} />
                  </span>
                )}
              </span>
            )}
          </span>
          {actions > 0 && <span aria-hidden className={cn(ROOM_SHOWN, ACTIONS_ROOM[actions])} />}
        </button>
        <div data-row-actions className={ROW_ACTIONS}>
          {onReveal && (
            <button
              type="button"
              aria-label={`Show ${file.path} in Files`}
              title="Show in Files"
              onClick={() => onReveal(file.path)}
              className={ROW_ACTION}
            >
              <FolderSearch aria-hidden className="size-icon-row" />
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
              <SquareArrowOutUpRight aria-hidden className="size-icon-row" />
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
              <FolderOpen aria-hidden className="size-icon-row" />
            </button>
          )}
        </div>
      </div>
      <Expand open={open} id={bodyId}>
        {rendered && (
          <div className="border-t border-edge bg-card/40">
            {file.tooLarge ? (
              <TooLargeNote
                file={file}
                reviewable={reviewable}
                layout={layout}
                wrap={wrap}
                {...(onOpenInEditor ? { onOpenInEditor } : {})}
                {...(onReveal ? { onReveal } : {})}
              />
            ) : (
              <PatchView
                file={file}
                layout={layout}
                wrap={wrap}
                current={focusHunk}
                revealKey={focusHunk === undefined ? undefined : focusKey}
              />
            )}
          </div>
        )}
      </Expand>
    </li>
  );
}

/** `path` quoted for a POSIX shell. */
const shellQuote = (path: string) =>
  /^[\w./@+-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;

/** The command that prints `file`'s patch from its checkout, as the Diff panel would show it. */
export const diffCommand = (file: DiffFile) =>
  file.status === "untracked" || file.status === "added"
    ? `git diff --no-index -- /dev/null ${shellQuote(file.path)}`
    : `git diff -- ${shellQuote(file.path)}`;

/**
 * A patch past the view limit: what it changed, what is still reviewable here, and the ways to read
 * it: here a chunk of hunks at a time (or summarized, when generated) where the list knows its
 * source, else in the editor, Files, or with the `git diff` command for a terminal.
 */
function TooLargeNote({
  file,
  reviewable,
  layout,
  wrap,
  onOpenInEditor,
  onReveal,
}: {
  file: DiffFile;
  reviewable: number;
  layout: DiffLayout;
  wrap: boolean;
  onOpenInEditor?: (path: string) => void;
  onReveal?: (path: string) => void;
}) {
  const source = useDiffChunkSource();
  const [copied, setCopied] = useState<string>();
  const copy = async () => {
    try {
      await copyText(diffCommand(file));
      setCopied("Copied. Run it in the checkout to see the whole patch.");
    } catch (error) {
      setCopied(`Couldn't copy: ${errorMessage(error)}`);
    }
  };
  const lines = file.additions + file.deletions;
  const others =
    reviewable === 0
      ? ""
      : `${reviewable === 1 ? "The other file" : `The other ${reviewable} files`} in this diff ${reviewable === 1 ? "is" : "are"} reviewable here. `;
  const alternatives = (
    <>
      <p className="text-muted-foreground">
        {source
          ? `${others}To read this one whole, use your editor or a terminal.`
          : reviewable === 0
            ? "Read it in your editor or a terminal."
            : `${others}Read this one in your editor or a terminal.`}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {onOpenInEditor && (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => onOpenInEditor(file.path)}
          >
            <SquareArrowOutUpRight data-icon="inline-start" />
            Open in editor
          </Button>
        )}
        {onReveal && (
          <Button type="button" size="xs" variant="ghost" onClick={() => onReveal(file.path)}>
            <FolderSearch data-icon="inline-start" />
            Show in Files
          </Button>
        )}
        <Button type="button" size="xs" variant="ghost" onClick={() => void copy()}>
          <Copy data-icon="inline-start" />
          Copy git diff command
        </Button>
      </div>
      {copied && (
        <p role="status" className="text-muted-foreground">
          {copied}
        </p>
      )}
    </>
  );
  return (
    <div data-testid="diff-too-large" className="flex flex-col gap-2 px-3 py-2 text-meta">
      <p className="text-foreground">
        This patch is too large to show here{source ? " whole" : ""} (
        {lines.toLocaleString("en-US")} changed {lines === 1 ? "line" : "lines"}).
      </p>
      {source ? (
        <ChunkedPatch source={source} file={file} layout={layout} wrap={wrap}>
          {alternatives}
        </ChunkedPatch>
      ) : (
        alternatives
      )}
    </div>
  );
}
