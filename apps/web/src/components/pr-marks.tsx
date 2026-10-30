import { cn } from "@/lib/utils";
import { Swap } from "@/motion";

import {
  BOT_DISPLAY,
  CHECKS_DISPLAY,
  MERGE_DISPLAY,
  PR_STATE_DISPLAY,
  REVIEW_DISPLAY,
  prRefText,
  type MarkGroup,
  type PrMark,
  type PrMarkDisplay,
  type PrMarks,
  type PrRefSource,
} from "./pr-marks-model";

// The PR vocabulary's marks as React: small glyphs that say one fact each, by shape and tone, with
// their words in a `title` and, unless the surrounding control already says them, their accessible
// name. See `pr-marks-model.ts` for what each mark means.

const DISPLAYS: Record<MarkGroup, Record<string, PrMarkDisplay>> = {
  state: PR_STATE_DISPLAY,
  checks: CHECKS_DISPLAY,
  review: REVIEW_DISPLAY,
  threads: REVIEW_DISPLAY,
  bot: BOT_DISPLAY,
  merge: MERGE_DISPLAY,
};

export const markDisplay = (group: MarkGroup, mark: PrMark): PrMarkDisplay =>
  DISPLAYS[group][mark.kind]!;

/**
 * One mark's glyph. `labelled` names it for screen readers (`role="img"`) and gives it the mark's
 * detail as its tooltip, for a glyph that stands alone; leave it off inside a control whose own
 * name and tooltip or card already say the mark. The words never join the text it sits in.
 */
export function PrMarkIcon({
  group,
  mark,
  labelled = false,
  className,
  ...data
}: {
  group: MarkGroup;
  mark: PrMark | undefined;
  labelled?: boolean;
  className?: string;
  /** `data-*` attributes for tests and styles. */
  [data: `data-${string}`]: string | number | undefined;
}) {
  if (mark === undefined) return null;
  const display = markDisplay(group, mark);
  return (
    <span title={labelled ? mark.detail : undefined} className="inline-flex shrink-0">
      <Swap swapKey={mark.kind} className="inline-flex shrink-0">
        <display.icon
          {...data}
          {...(labelled ? { role: "img", "aria-label": mark.detail } : { "aria-hidden": true })}
          data-pr-mark={group}
          data-kind={mark.kind}
          className={cn("size-3 shrink-0", display.tone, className)}
        />
      </Swap>
    </span>
  );
}

/**
 * The marks after a PR's number, in the vocabulary's order: checks, people, the bot, its merge.
 * No checks at all is left to the tooltip, where a row has no room to say nothing.
 */
export function PrMarkRow({
  marks,
  labelled = false,
  bot = true,
}: {
  marks: PrMarks;
  labelled?: boolean;
  /** False where the bot has a glyph of its own beside. */
  bot?: boolean;
}) {
  return (
    <>
      {marks.checks?.kind !== "none" && (
        <PrMarkIcon group="checks" mark={marks.checks} labelled={labelled} />
      )}
      <PrMarkIcon group="review" mark={marks.review} labelled={labelled} />
      <PrMarkIcon group="threads" mark={marks.threads} labelled={labelled} />
      {bot && <PrMarkIcon group="bot" mark={marks.bot} labelled={labelled} />}
      <PrMarkIcon group="merge" mark={marks.merge} labelled={labelled} />
    </>
  );
}

/** `repo#N` in mono, the owner and branch in its tooltip. */
export function PrRef({
  pr,
  branch,
  compact = true,
  className,
}: {
  pr: PrRefSource;
  branch?: string | undefined;
  compact?: boolean;
  className?: string;
}) {
  const full = prRefText(pr);
  return (
    <span
      title={branch === undefined ? full : `${full}\n${branch}`}
      className={cn("font-mono tabular-nums", className)}
    >
      {prRefText(pr, { compact })}
    </span>
  );
}

/** `+120 −14 · 6 files`, the lines in their diff colours; nothing when none is known. */
export function DiffStat({
  additions,
  deletions,
  changedFiles,
  className,
}: {
  additions?: number | undefined;
  deletions?: number | undefined;
  changedFiles?: number | undefined;
  className?: string;
}) {
  if (additions === undefined && deletions === undefined && changedFiles === undefined) {
    return null;
  }
  return (
    <span
      data-testid="pr-diff-stat"
      className={cn("flex shrink-0 items-center gap-1 font-mono tabular-nums", className)}
    >
      {additions !== undefined && (
        <span aria-label={`${additions} lines added`} className="text-success">
          +{additions.toLocaleString("en")}
        </span>
      )}
      {deletions !== undefined && (
        <span aria-label={`${deletions} lines deleted`} className="text-destructive">
          −{deletions.toLocaleString("en")}
        </span>
      )}
      {changedFiles !== undefined && (
        <span className="text-muted-foreground">
          {changedFiles.toLocaleString("en")} {changedFiles === 1 ? "file" : "files"}
        </span>
      )}
    </span>
  );
}

/**
 * The marks spelled out, one line each with its glyph: for a hover card, which has room for the
 * words the chip leaves to its tooltip. `cached`: they are from a status GitHub didn't refresh, so
 * each line says so and its glyph is faded, rather than implying a successful refresh.
 */
export function PrMarkLines({
  marks,
  cached = false,
  className,
}: {
  marks: PrMarks;
  cached?: boolean;
  className?: string;
}) {
  const lines = (
    [
      ["checks", marks.checks],
      ["review", marks.review],
      ["threads", marks.threads],
      ["bot", marks.bot],
      ...marks.mergeAll.map((mark) => ["merge", mark] as const),
    ] as const
  ).flatMap(([group, mark]) =>
    mark === undefined
      ? []
      : mark.detail
          .split("\n")
          .map((line, i) => ({ key: `${group}${mark.kind}${i}`, group, mark, line })),
  );
  if (lines.length === 0) return null;
  return (
    <ul data-testid="pr-mark-lines" className={cn("flex flex-col gap-0.5 text-[11px]", className)}>
      {lines.map(({ key, group, mark, line }) => {
        const display = markDisplay(group, mark);
        return (
          <li
            key={key}
            data-pr-mark={group}
            data-kind={mark.kind}
            className="flex items-start gap-1.5"
          >
            <display.icon
              aria-hidden
              className={cn("mt-px size-3 shrink-0", display.tone, cached && "opacity-50")}
            />
            <span className="min-w-0 text-muted-foreground">
              {cached ? `Cached: ${line}` : line}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
