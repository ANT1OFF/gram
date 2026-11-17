import { useMemo, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

import { foldUnchanged, lineDiff, type DiffLine, type DiffSpan } from "./text-diff";

const ROW = "grid grid-cols-[auto_auto_1.25rem_minmax(0,1fr)] whitespace-pre";
const NUMBER = "min-w-10 pr-2 text-right text-muted-foreground tabular-nums select-none";

/**
 * A line diff of two texts, unified: removed lines over the lines that replaced them, each with its
 * number on the side it is on. `words` also marks what changed within a pair of changed lines.
 * Unchanged lines more than `context` from a change fold into a row that opens them; `"all"`
 * shows every line. Past `maxLines` on either side the texts are not compared and `tooLarge` is
 * shown instead.
 */
export function Diff({
  before,
  after,
  words = false,
  context = 3,
  maxLines,
  label = "Changes",
  tooLarge = "Too large to compare.",
  unchanged = "No changes.",
  className,
  testId,
}: {
  before: string;
  after: string;
  words?: boolean | undefined;
  /** Unchanged lines kept around each change, or `"all"`. Default 3. */
  context?: number | "all" | undefined;
  /** Lines on either side past which the texts are not compared. Default 5000. */
  maxLines?: number | undefined;
  /** The diff's name for a screen reader. */
  label?: string | undefined;
  tooLarge?: ReactNode | undefined;
  unchanged?: ReactNode | undefined;
  className?: string | undefined;
  testId?: string | undefined;
}) {
  const lines = useMemo(
    () => lineDiff(before, after, { words, ...(maxLines === undefined ? {} : { maxLines }) }),
    [before, after, words, maxLines],
  );
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set());
  const [openedFor, setOpenedFor] = useState(lines);
  if (openedFor !== lines) {
    setOpenedFor(lines);
    setOpened(new Set());
  }
  const rows = useMemo(() => {
    if (lines === undefined || context === "all") return lines;
    return foldUnchanged(lines, context);
  }, [lines, context]);

  const frame = cn(
    "min-w-0 overflow-auto font-mono text-meta [font-variant-ligatures:none]",
    className,
  );
  if (lines === undefined || rows === undefined)
    return (
      <p className={cn(frame, "p-3 font-sans text-muted-foreground")} data-testid={testId}>
        {tooLarge}
      </p>
    );
  if (!lines.some((line) => line.kind !== "same"))
    return (
      <p className={cn(frame, "p-3 font-sans text-muted-foreground")} data-testid={testId}>
        {unchanged}
      </p>
    );

  return (
    <div role="region" aria-label={label} className={frame} data-testid={testId} data-slot="diff">
      <div className="min-w-max">
        {rows.map((row) => {
          if (row.kind !== "fold") return <Line key={key(row)} line={row} />;
          if (!opened.has(row.from))
            return (
              <button
                key={`fold-${row.from}`}
                type="button"
                className="block w-full bg-surface-2 py-0.5 pl-24 text-left font-sans text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
                onClick={() => setOpened(new Set(opened).add(row.from))}
              >
                {row.count === 1 ? "Show 1 unchanged line" : `Show ${row.count} unchanged lines`}
              </button>
            );
          return lines
            .slice(row.from, row.from + row.count)
            .map((line) => <Line key={key(line)} line={line} />);
        })}
      </div>
    </div>
  );
}

const key = (line: DiffLine) =>
  line.kind === "same"
    ? `s${line.before}`
    : line.kind === "add"
      ? `a${line.after}`
      : `d${line.before}`;

function Line({ line }: { line: DiffLine }) {
  const before = line.kind === "add" ? "" : line.before;
  const after = line.kind === "del" ? "" : line.after;
  return (
    <div
      className={cn(
        ROW,
        line.kind === "add" && "bg-diff-add",
        line.kind === "del" && "bg-diff-del",
      )}
      data-kind={line.kind}
    >
      <span className={NUMBER} aria-hidden>
        {before}
      </span>
      <span className={NUMBER} aria-hidden>
        {after}
      </span>
      <span
        aria-hidden
        className={cn(
          "select-none",
          line.kind === "add" && "text-diff-add-foreground",
          line.kind === "del" && "text-diff-del-foreground",
        )}
      >
        {line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}
      </span>
      {line.kind === "same" ? (
        <span className="pr-3 text-foreground">{line.text}</span>
      ) : line.kind === "add" ? (
        <ins className="pr-3 text-foreground no-underline">
          <span className="sr-only">Added line {line.after}: </span>
          <Spans text={line.text} spans={line.spans} tone="add" />
        </ins>
      ) : (
        <del className="pr-3 text-foreground no-underline">
          <span className="sr-only">Removed line {line.before}: </span>
          <Spans text={line.text} spans={line.spans} tone="del" />
        </del>
      )}
    </div>
  );
}

function Spans({
  text,
  spans,
  tone,
}: {
  text: string;
  spans: readonly DiffSpan[] | undefined;
  tone: "add" | "del";
}) {
  if (spans === undefined) return text;
  return spans.map((span, index) =>
    span.changed ? (
      <span
        key={index}
        data-word={tone}
        className={cn(tone === "add" ? "bg-diff-add-foreground/25" : "bg-diff-del-foreground/25")}
      >
        {span.text}
      </span>
    ) : (
      span.text
    ),
  );
}
