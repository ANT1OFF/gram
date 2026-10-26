import type { DiffFile } from "@gram/contracts";
import type { BundledLanguage } from "shiki";
import { MessageSquarePlus, Pencil, Trash2 } from "lucide-react";
import {
  Fragment,
  useMemo,
  useState,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { TokenSpan, useCodeTokens } from "@/components/ai-elements/code-block";
import { cn } from "@/lib/utils";
import { useDiffCommentsStore, type DiffComment } from "@/stores/diff-comments";
import type { DiffLayout } from "@/stores/layout";

import {
  CommentActionRow,
  CommentEditorRow,
  CommentNoteRow,
  linesLabel,
  useDiffReview,
  type DiffReview,
} from "./diff-review";
import {
  lineRange,
  parseHunks,
  splitRows,
  type Hunk,
  type PatchLine,
  type PatchLineKind,
  type SplitRow,
} from "./patch";

const ROW: Record<PatchLineKind, string> = {
  add: "bg-diff-add",
  del: "bg-diff-del",
  ctx: "",
  note: "text-muted-foreground italic",
};

const SIGN: Record<PatchLineKind, string> = { add: "+", del: "−", ctx: " ", note: " " };

const NUMBER = "w-10 pr-1 text-right align-top text-muted-foreground tabular-nums select-none";

/** A line number that picks its line when the patch takes comments. */
const GUTTER = "cursor-pointer hover:bg-accent hover:text-foreground";

/** A picked line's number stays marked, whatever the row's colour. */
const PICKED = "data-picked:bg-ring/25 data-picked:text-foreground";

/** The patch and hunk a pointer drag over the line numbers began in, while it lasts. */
let picking: { table: EventTarget; hunk: number } | undefined;

/** The line a `data-line="<hunk>:<index>"` element stands for. */
const lineAt = (target: EventTarget | null, attribute = "data-line") => {
  const raw =
    target instanceof Element ? target.closest(`[${attribute}]`)?.getAttribute(attribute) : null;
  if (!raw) return undefined;
  const [hunk, line] = raw.split(":").map(Number);
  return { hunk: hunk!, line: line! };
};

/** What a hunk's rows need from the review: the pick, and the rows that go after a line. */
interface HunkReview {
  /** Picked line indexes in this hunk, lowest first. */
  picked: readonly [number, number] | undefined;
  /** The rows under line `index`: its drafts, then the pick's action or editor if it ends there. */
  after(index: number, span: number): ReactNode;
}

/**
 * Rows a patch renders before it asks: a lockfile's thousands of rows would hold up the panel on
 * every expand, for lines nobody reads.
 */
export const ROW_BUDGET = 400;

/**
 * A file's patch as numbered rows, unified or side by side; binary, oversized and content-less files
 * get a short note. A long patch shows its first `budget` rows and offers the rest. `current`
 * marks a hunk, and each new `revealKey` renders it if it was past the budget.
 */
export function PatchView({
  file,
  layout = "unified",
  current,
  revealKey,
  budget: rowBudget = ROW_BUDGET,
  numbered = true,
  headers = true,
  language,
}: {
  file: DiffFile;
  layout?: DiffLayout;
  current?: number | undefined;
  revealKey?: number | undefined;
  /** Rows shown before "Show more". */
  budget?: number;
  /** Unified only: false hides line numbers that aren't the file's. */
  numbered?: boolean;
  /** Unified only: false runs the hunks on with a gap between them instead of `@@` headers. */
  headers?: boolean;
  /** Unified only: highlights the code as this language. */
  language?: BundledLanguage | undefined;
}) {
  const hunks = useMemo(() => parseHunks(file.patch), [file.patch]);
  const review = useDiffReview();
  const [menu, setMenu] = useState<MenuTarget>();
  const [showAll, setShowAll] = useState(false);
  // Unset at first, so a patch that mounts for a jump renders the hunk it was opened for.
  const [revealed, setRevealed] = useState<number>();
  const [pagedPatch, setPagedPatch] = useState(file.patch);
  // "Show more" was for the patch it was clicked on; a refreshed one starts within the budget again.
  if (file.patch !== pagedPatch) {
    setPagedPatch(file.patch);
    setShowAll(false);
  }

  const starts = useMemo(() => hunkStarts(hunks), [hunks]);
  const total = hunks.reduce((sum, hunk) => sum + 1 + hunk.lines.length, 0);

  if (revealKey !== revealed) {
    setRevealed(revealKey);
    if (current !== undefined && (starts[current] ?? 0) >= rowBudget) setShowAll(true);
  }

  if (file.binary) return <PatchNote>Binary file not shown</PatchNote>;
  if (file.tooLarge) return <PatchNote>Diff too large to display</PatchNote>;
  if (hunks.length === 0) return <PatchNote>No content changes</PatchNote>;

  const budget = showAll ? Infinity : rowBudget;
  const Rows = layout === "split" ? SplitHunk : UnifiedHunk;
  const hidden = total - Math.min(total, budget);
  const path = file.path;
  const commented = review?.comments.filter((comment) => comment.path === path) ?? [];

  const table = (
    <table
      className={cn("w-full border-collapse", layout === "split" && "table-fixed")}
      {...(review
        ? {
            onPointerDown: (event: PointerEvent) => {
              const at = event.button === 0 ? lineAt(event.target, "data-gutter") : undefined;
              if (!at) return;
              event.preventDefault();
              picking = { table: event.currentTarget, hunk: at.hunk };
              window.addEventListener("pointerup", () => (picking = undefined), { once: true });
              review.select(path, at.hunk, at.line, event.shiftKey);
            },
            onPointerOver: (event: PointerEvent) => {
              const at =
                picking?.table === event.currentTarget && event.buttons === 1
                  ? lineAt(event.target, "data-gutter")
                  : undefined;
              // A drag stretches the pick within its own hunk; other gutters it crosses don't count.
              if (at && at.hunk === picking?.hunk) review.select(path, at.hunk, at.line, true);
            },
            onContextMenu: (event: MouseEvent) => {
              const comment =
                event.target instanceof Element
                  ? event.target.closest("[data-comment]")?.getAttribute("data-comment")
                  : null;
              if (comment) return setMenu({ kind: "comment", id: comment });
              const at = lineAt(event.target);
              if (!at) return setMenu(undefined);
              const pick = review.selection;
              const inside =
                pick?.path === path &&
                pick.hunk === at.hunk &&
                at.line >= Math.min(pick.anchor, pick.head) &&
                at.line <= Math.max(pick.anchor, pick.head);
              if (!inside) review.select(path, at.hunk, at.line, false);
              setMenu({ kind: "lines" });
            },
          }
        : {})}
    >
      {layout === "split" && (
        <colgroup>
          <col className="w-10" />
          <col className="w-4" />
          <col />
          <col className="w-10" />
          <col className="w-4" />
          <col />
        </colgroup>
      )}
      {hunks.map((hunk, index) =>
        starts[index]! < budget ? (
          <Rows
            key={hunk.header}
            index={index}
            hunk={hunk}
            current={index === current}
            limit={budget - starts[index]! - 1}
            numbered={numbered}
            headers={headers}
            language={language}
            {...(review ? { review: hunkReview(review, path, index, hunk, commented) } : {})}
          />
        ) : null,
      )}
    </table>
  );

  return (
    <div
      data-testid="patch"
      data-layout={layout}
      className={cn("font-mono text-xs leading-5", layout === "unified" && "overflow-x-auto")}
    >
      {review ? (
        <ContextMenu>
          {/* The code stays selectable for copying; only the line numbers aren't. */}
          <ContextMenuTrigger className="select-text">{table}</ContextMenuTrigger>
          <PatchMenu review={review} path={path} hunks={hunks} target={menu} />
        </ContextMenu>
      ) : (
        table
      )}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="w-full border-t border-border px-3 py-1.5 text-left font-sans text-muted-foreground outline-none hover:bg-muted/50 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
        >
          Show {hidden.toLocaleString()} more {hidden === 1 ? "line" : "lines"}
        </button>
      )}
    </div>
  );
}

/** Each hunk's first row in the patch, counting a row for its header. */
function hunkStarts(hunks: readonly Hunk[]): number[] {
  const starts: number[] = [];
  let row = 0;
  for (const hunk of hunks) {
    starts.push(row);
    row += 1 + hunk.lines.length;
  }
  return starts;
}

/** The split rows that hold the first `limit` lines: the budget counts lines, and a row holds up to two. */
function takeLines(rows: readonly SplitRow[], limit: number): SplitRow[] {
  let lines = 0;
  let count = 0;
  while (count < rows.length && lines < limit) {
    const row = rows[count]!;
    lines += row.kind === "pair" && row.left && row.right && row.left !== row.right ? 2 : 1;
    count++;
  }
  return rows.slice(0, count);
}

/** What was right-clicked: lines (the pick, which the click moved there) or a draft comment. */
type MenuTarget = { kind: "lines" } | { kind: "comment"; id: string };

/** Hunk `index`'s share of the review: its part of the pick, and its drafts under their last line. */
function hunkReview(
  review: DiffReview,
  path: string,
  index: number,
  hunk: Hunk,
  commented: readonly DiffComment[],
): HunkReview {
  const pick = review.selection;
  const picked =
    pick?.path === path && pick.hunk === index
      ? ([Math.min(pick.anchor, pick.head), Math.max(pick.anchor, pick.head)] as const)
      : undefined;
  const range =
    picked && picked[1] < hunk.lines.length ? lineRange(hunk, picked[0], picked[1]) : undefined;
  const label = range ? linesLabel(range.start, range.end) : "";
  const notes = new Map<number, DiffComment[]>();
  for (const comment of commented) {
    // Under the last of its lines, only where they still read as they did: after a refresh or in
    // another scope, a draft whose excerpt is gone stays a chip rather than sitting under lines it
    // wasn't about.
    const span = comment.snippet.split("\n").length;
    const at = hunk.lines.findIndex((_, last) => {
      if (last + 1 < span) return false;
      const lines = lineRange(hunk, last + 1 - span, last);
      return (
        lines.snippet === comment.snippet &&
        lines.side === comment.side &&
        lines.start === comment.start &&
        lines.end === comment.end
      );
    });
    if (at !== -1) notes.set(at, [...(notes.get(at) ?? []), comment]);
  }
  return {
    picked,
    after: (line, span) => (
      <>
        {notes.get(line)?.map((comment) =>
          review.editing === comment.id ? (
            <CommentEditorRow
              key={comment.id}
              span={span}
              label={linesLabel(comment.start, comment.end)}
              initial={comment.note}
              submitLabel="Save"
              onSubmit={(note) => {
                useDiffCommentsStore.getState().setNote(review.threadId, comment.id, note);
                review.edit(undefined);
              }}
              onCancel={() => review.edit(undefined)}
            />
          ) : (
            <CommentNoteRow key={comment.id} span={span} comment={comment} />
          ),
        )}
        {range &&
          picked?.[1] === line &&
          (review.composing ? (
            <CommentEditorRow
              span={span}
              label={label}
              submitLabel="Add comment"
              onSubmit={(note) => review.add({ path, ...range, note })}
              onCancel={review.clear}
            />
          ) : (
            <CommentActionRow
              span={span}
              label={label}
              onCompose={review.compose}
              onClear={review.clear}
            />
          ))}
      </>
    ),
  };
}

/** The patch's right-click menu: comment on the picked lines, or edit or delete a draft. */
function PatchMenu({
  review,
  path,
  hunks,
  target,
}: {
  review: DiffReview;
  path: string;
  hunks: readonly Hunk[];
  target: MenuTarget | undefined;
}) {
  const pick = review.selection;
  const hunk = pick?.path === path ? hunks[pick.hunk] : undefined;
  const range = pick && hunk ? lineRange(hunk, pick.anchor, pick.head) : undefined;
  return (
    <ContextMenuContent>
      {target?.kind === "comment" ? (
        <>
          <ContextMenuItem onClick={() => review.edit(target.id)}>
            <Pencil aria-hidden className="size-3.5" />
            Edit comment
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => useDiffCommentsStore.getState().remove(review.threadId, target.id)}
          >
            <Trash2 aria-hidden className="size-3.5" />
            Delete comment
          </ContextMenuItem>
        </>
      ) : (
        <ContextMenuItem disabled={!range} onClick={review.compose}>
          <MessageSquarePlus aria-hidden className="size-3.5" />
          {range ? `Comment on ${linesLabel(range.start, range.end)}` : "Pick a line to comment"}
        </ContextMenuItem>
      )}
    </ContextMenuContent>
  );
}

interface HunkProps {
  index: number;
  hunk: Hunk;
  current: boolean;
  /** How many of the hunk's lines to render. */
  limit: number;
  review?: HunkReview | undefined;
  numbered?: boolean;
  headers?: boolean;
  language?: BundledLanguage | undefined;
}

const isPicked = (review: HunkReview | undefined, line: number) =>
  review?.picked !== undefined && line >= review.picked[0] && line <= review.picked[1];

function HunkHeader({
  index,
  hunk,
  current,
  span,
  headers = true,
}: Omit<HunkProps, "limit"> & { span: number }) {
  if (!headers) {
    // Without headers the first hunk needs nothing above it, and the others a gap for the lines
    // they skip.
    return index === 0 ? null : (
      <tr data-hunk={index} aria-hidden className="bg-muted/50 text-muted-foreground">
        <td colSpan={span} className="px-2 leading-4 select-none">
          ⋯
        </td>
      </tr>
    );
  }
  return (
    <tr
      data-hunk={index}
      data-current={current || undefined}
      className="bg-muted/50 text-muted-foreground data-current:bg-accent data-current:text-foreground"
    >
      <td colSpan={span} className="truncate px-2 py-0.5">
        {hunk.header}
      </td>
    </tr>
  );
}

/**
 * The hunk's lines as highlighted tokens, one array per line, or `undefined` while they aren't (no
 * language, not yet tokenized, or tokens that don't reproduce the lines). Old and new lines are
 * tokenized together, which reads right for the line-level edits a hunk holds.
 */
function useHunkTokens(hunk: Hunk, language: BundledLanguage | undefined) {
  const code = useMemo(() => hunk.lines.map((line) => line.text).join("\n"), [hunk.lines]);
  // The language is a placeholder when there is none: nothing is tokenized then.
  const { tokens } = useCodeTokens(code, language ?? "tsx", language !== undefined);
  if (language === undefined || tokens.length !== hunk.lines.length) return undefined;
  const same = tokens.every(
    (line, at) => line.map((token) => token.content).join("") === hunk.lines[at]!.text,
  );
  return same ? tokens : undefined;
}

function UnifiedHunk({
  index,
  hunk,
  current,
  limit,
  review,
  numbered = true,
  headers = true,
  language,
}: HunkProps) {
  const tokens = useHunkTokens(hunk, language);
  const span = numbered ? 4 : 2;
  return (
    <tbody>
      <HunkHeader index={index} hunk={hunk} current={current} span={span} headers={headers} />
      {hunk.lines.slice(0, limit).map((line, row) => {
        const at = `${index}:${row}`;
        const gutter = review && line.kind !== "note" ? { "data-gutter": at } : {};
        const picked = isPicked(review, row) || undefined;
        return (
          // Rows have no stable identity beyond their position within the hunk.
          // oxlint-disable-next-line react/no-array-index-key
          <Fragment key={row}>
            <tr
              data-kind={line.kind}
              data-line={line.kind === "note" ? undefined : at}
              className={ROW[line.kind]}
            >
              {numbered && (
                <>
                  <td
                    {...gutter}
                    data-picked={picked}
                    className={cn(NUMBER, review && GUTTER, PICKED)}
                  >
                    {line.oldNo ?? ""}
                  </td>
                  <td
                    {...gutter}
                    data-picked={picked}
                    className={cn(NUMBER, review && GUTTER, PICKED)}
                  >
                    {line.newNo ?? ""}
                  </td>
                </>
              )}
              <Sign kind={line.kind} />
              <td className="pr-3 whitespace-pre">
                {tokens && line.kind !== "note"
                  ? tokens[row]!.map((token, column) => (
                      // oxlint-disable-next-line react/no-array-index-key -- positions in this line
                      <TokenSpan key={column} token={token} />
                    ))
                  : line.text}
              </td>
            </tr>
            {review?.after(row, span)}
          </Fragment>
        );
      })}
    </tbody>
  );
}

function SplitHunk({ index, hunk, current, limit, review }: HunkProps) {
  const rows = useMemo(() => splitRows(hunk.lines), [hunk.lines]);
  const positions = useMemo(() => new Map(hunk.lines.map((line, at) => [line, at])), [hunk.lines]);
  const shown = takeLines(rows, limit);
  const at = (line: PatchLine | undefined) =>
    line === undefined ? undefined : positions.get(line);
  const side = (line: PatchLine | undefined) => {
    const position = at(line);
    return position === undefined
      ? {}
      : { lineKey: `${index}:${position}`, review, picked: isPicked(review, position) };
  };
  return (
    <tbody>
      <HunkHeader index={index} hunk={hunk} current={current} span={6} />
      {shown.map((row, position) =>
        row.kind === "note" ? (
          // oxlint-disable-next-line react/no-array-index-key
          <tr key={position} data-kind="note" className={ROW.note}>
            <td colSpan={6} className="px-2">
              {row.text}
            </td>
          </tr>
        ) : (
          // oxlint-disable-next-line react/no-array-index-key
          <Fragment key={position}>
            <tr data-kind={row.left === row.right ? "ctx" : "change"}>
              <Side line={row.left} number={row.left?.oldNo} {...side(row.left)} />
              <Side line={row.right} number={row.right?.newNo} divider {...side(row.right)} />
            </tr>
            {afterSplitRow(review, at(row.left), at(row.right))}
          </Fragment>
        ),
      )}
    </tbody>
  );
}

/** The rows under a split row: those of its old line, then of its new one when that's another line. */
function afterSplitRow(review: HunkReview | undefined, left?: number, right?: number) {
  if (!review) return null;
  return (
    <>
      {left !== undefined && review.after(left, 6)}
      {right !== undefined && right !== left && review.after(right, 6)}
    </>
  );
}

/** One half of a split row; a missing line is a blank, hatched so it doesn't read as an empty line. */
function Side({
  line,
  number,
  divider = false,
  lineKey,
  review,
  picked = false,
}: {
  line: PatchLine | undefined;
  number: number | undefined;
  divider?: boolean;
  /** `<hunk>:<index>` of the line, for picking it. */
  lineKey?: string | undefined;
  review?: HunkReview | undefined;
  picked?: boolean;
}) {
  const edge = divider && "border-l border-border";
  if (!line) {
    return (
      <td colSpan={3} data-side="blank" className={cn("bg-muted/40", edge)}>
        {" "}
      </td>
    );
  }
  return (
    <>
      <td
        data-kind={line.kind}
        data-line={lineKey}
        {...(review && lineKey ? { "data-gutter": lineKey } : {})}
        data-picked={picked || undefined}
        className={cn(NUMBER, ROW[line.kind], review && GUTTER, PICKED, edge)}
      >
        {number ?? ""}
      </td>
      <Sign kind={line.kind} className={ROW[line.kind]} />
      <td
        data-kind={line.kind}
        data-line={lineKey}
        className={cn("pr-2 whitespace-pre-wrap [overflow-wrap:anywhere]", ROW[line.kind])}
      >
        {line.text}
      </td>
    </>
  );
}

function Sign({ kind, className }: { kind: PatchLineKind; className?: string }) {
  return (
    <td
      aria-hidden
      className={cn(
        "w-4 text-center align-top select-none",
        kind === "add" && "text-diff-add-foreground",
        kind === "del" && "text-diff-del-foreground",
        className,
      )}
    >
      {SIGN[kind]}
    </td>
  );
}

function PatchNote({ children }: { children: string }) {
  return <p className="px-3 py-2 text-xs text-muted-foreground">{children}</p>;
}
