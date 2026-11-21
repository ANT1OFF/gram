import { PreviewCard } from "@base-ui/react/preview-card";
import { ledgerPrsOf, type FeatureCardPr, type ThreadId } from "@gram/contracts";
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type Ref,
} from "react";

import { useApi } from "@/api/context";
import { openExternalUrl } from "@/api/open-external";
import { openPrPanel } from "@/components/git-badges";
import { PrGlyphCardEntry, threadPrEntries } from "@/components/pr-glyph";
import { PrMarkIcon } from "@/components/pr-marks";
import { cn } from "@/lib/utils";
import { CARD_SURFACE } from "@/reviews/pr-display";
import { useThreadsStore } from "@/stores/threads";

import {
  foldMergedChips,
  MAX_PR_CHIPS,
  prChipsOf,
  type PrChip,
  type PrChipTone,
} from "./overview-pr-chips-model";
import { WorkerRunChip } from "./overview-run-chip";
import type { WatchedRun } from "./overview-run-chip-model";
import { useOrchestratorLedger } from "./use-orchestration";

const TONE: Record<PrChipTone, string> = {
  danger: "bg-transparent text-foreground ring-1 ring-border-strong ring-inset",
  warning: "bg-transparent text-foreground ring-1 ring-border-strong ring-inset",
  merged: "bg-transparent text-muted-foreground",
  plain: "bg-sidebar-row-hover text-muted-foreground",
};

/**
 * A worker's PR chips in the order its row shows them, from its thread, its card and its ledger
 * row: what `WorkerPrChips` draws, for a view that says what they don't.
 */
export function useWorkerPrChips(
  threadId: ThreadId,
  cardPrs: readonly FeatureCardPr[],
): readonly PrChip[] {
  const thread = useThreadsStore((s) => s.byId[threadId]?.thread);
  const git = useThreadsStore((s) => s.byId[threadId]?.git);
  const { data: ledger } = useOrchestratorLedger(thread?.workspaceId);
  const worker = useMemo(
    () =>
      ledger?.features
        .flatMap((feature) => feature.workers)
        .find((entry) => entry.threadId === threadId),
    [ledger, threadId],
  );
  const chips = useMemo(
    () =>
      prChipsOf(
        thread === undefined ? [] : threadPrEntries(thread, git),
        cardPrs,
        worker === undefined ? undefined : { prs: ledgerPrsOf(worker), worker },
      ),
    [thread, git, cardPrs, worker],
  );
  return chips;
}

/**
 * The PR numbers a worker's chips show, the first `MAX_PR_CHIPS`; with `foldMerged`, the merged
 * ones its "N merged" count stands for too.
 */
export const shownPrNumbers = (
  chips: readonly PrChip[],
  foldMerged = false,
): readonly { number: number }[] => {
  const folded = foldMerged ? foldMergedChips(chips) : undefined;
  const drawn = (folded?.chips ?? chips).slice(0, MAX_PR_CHIPS);
  const counted =
    folded !== undefined && folded.merged > 0 ? chips.filter((chip) => chip.kind === "merged") : [];
  return [...drawn, ...counted].map((chip) => ({ number: chip.entry.number }));
};

/**
 * `card={false}` in the compact rail's flyout, itself a card: a chip's own card would sit outside it
 * and close it, so there the chip's name carries what its card would say. `dense`, on an overview
 * row's status line, 16 px tall, so the line keeps its height. `ghost` draws them unseen and
 * inert, to hold their room inside a row's button while the real ones sit over it; `ghostRef` is
 * that room's, for `useChipsFit`. `foldMerged` folds a run of merged PRs into one "N merged"
 * (`foldMergedChips`). `runs`, the workflow runs it watches while it waits, follow as one chip.
 */
export function WorkerPrChips({
  threadId,
  cardPrs,
  chips: given,
  card = true,
  dense = false,
  ghost = false,
  ghostRef,
  foldMerged = false,
  runs = NO_RUNS,
  className = "pr-1.5 pb-1 pl-6",
  style,
  onOpenOwn,
  numberless,
}: {
  threadId: ThreadId;
  cardPrs: readonly FeatureCardPr[];
  /** The chips, when the caller already has them (`useWorkerPrChips`). */
  chips?: readonly PrChip[] | undefined;
  card?: boolean;
  dense?: boolean;
  ghost?: boolean;
  ghostRef?: Ref<HTMLSpanElement> | undefined;
  foldMerged?: boolean;
  runs?: readonly WatchedRun[];
  /** Where the chips sit: under an overview row's name by default. */
  className?: string;
  /** Where they sit when it is measured: over their room in a wide row. */
  style?: CSSProperties | undefined;
  /**
   * What a click on its own PR does in place of opening its PR panel in the main view: in the
   * worker pane, its own PR tool, so the orchestrator stays.
   */
  onOpenOwn?: (() => void) | undefined;
  /**
   * Its own PR whose number something beside the chips already says (the worker pane's PR tab):
   * that chip keeps its marks and its name to a screen reader, and leaves the number out.
   */
  numberless?: number | undefined;
}) {
  const own = useWorkerPrChips(threadId, cardPrs);
  const chips = given ?? own;
  if (chips.length === 0 && runs.length === 0) return null;
  const folded = foldMerged ? foldMergedChips(chips) : undefined;
  const open = folded?.chips ?? chips;
  const shown = open.slice(0, MAX_PR_CHIPS);
  const more = open.length - shown.length;
  const mergedCount = folded?.mergedChip !== undefined && (
    <span
      data-testid={ghost ? undefined : "overview-pr-merged"}
      role={ghost ? undefined : "img"}
      aria-label={ghost ? undefined : `${folded.merged} merged pull requests`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 px-0.5 text-meta text-muted-foreground tabular-nums",
        dense ? "h-4" : "h-5",
      )}
    >
      <PrMarkIcon group="state" mark={folded.mergedChip.marks.state} />
      {folded.merged} merged
    </span>
  );
  const moreText = more > 0 && (
    <span
      data-testid={ghost ? undefined : "overview-pr-more"}
      role={ghost ? undefined : "img"}
      aria-label={ghost ? undefined : `${more} more pull ${more === 1 ? "request" : "requests"}`}
      className={cn(
        "inline-flex items-center px-1 text-meta text-muted-foreground tabular-nums",
        dense ? "h-4" : "h-5",
      )}
    >
      +{more}
    </span>
  );
  if (ghost) {
    return (
      <span ref={ghostRef} aria-hidden className={cn("invisible flex shrink-0 gap-1", className)}>
        {shown.map((chip) => (
          <span key={chip.entry.key} className={chipClass(chip, dense)}>
            <PrChipFace chip={chip} />
          </span>
        ))}
        {moreText}
        {mergedCount}
        <WorkerRunChip runs={runs} dense={dense} ghost />
      </span>
    );
  }
  return (
    <div
      role="group"
      aria-label={
        chips.length === 0
          ? "Workflow runs"
          : runs.length === 0
            ? "Pull requests"
            : "Pull requests and workflow runs"
      }
      data-testid="overview-pr-chips"
      data-thread-id={threadId}
      className={cn("flex gap-1", dense ? "flex-nowrap" : "flex-wrap", className)}
      style={style}
    >
      {shown.map((chip) => (
        <PrChipButton
          key={chip.entry.key}
          chip={chip}
          threadId={threadId}
          card={card}
          dense={dense}
          onOpenOwn={onOpenOwn}
          numbered={!(chip.entry.own && chip.entry.number === numberless)}
        />
      ))}
      {moreText}
      {mergedCount}
      <WorkerRunChip runs={runs} dense={dense} />
    </div>
  );
}

const NO_RUNS: readonly WatchedRun[] = [];

const chipClass = (chip: PrChip, dense: boolean) =>
  cn(
    "inline-flex cursor-default items-center gap-1 rounded-(--radius-sm) px-1.5 text-meta outline-none focus-visible:ring-2 focus-visible:ring-ring",
    dense ? "h-4" : "h-5",
    TONE[chip.tone],
    chip.kind === "merged" && "px-0.5",
  );

function PrChipFace({ chip, numbered = true }: { chip: PrChip; numbered?: boolean }) {
  const { entry, marks } = chip;
  return (
    <>
      <PrMarkIcon group="state" mark={marks.state} data-state-glyph={marks.state.kind} />
      {numbered && (
        <span
          className={cn("font-mono text-meta tabular-nums", chip.kind === "draft" && "opacity-60")}
        >
          #{entry.number}
        </span>
      )}
      {marks.checks !== undefined &&
        marks.checks.kind !== "none" &&
        marks.checks.kind !== "unknown" && (
          <PrMarkIcon group="checks" mark={marks.checks} data-checks={marks.checks.kind} />
        )}
      <PrMarkIcon group="review" mark={marks.review} data-people-review={marks.review?.kind} />
      {chip.bot !== undefined && marks.bot !== undefined && (
        <PrMarkIcon group="bot" mark={marks.bot} data-review={chip.bot} />
      )}
      {chip.people > 0 && (
        <PrMarkIcon group="threads" mark={marks.threads} data-people={chip.people} />
      )}
      <PrMarkIcon group="merge" mark={marks.merge} />
    </>
  );
}

function PrChipButton({
  chip,
  threadId,
  card,
  dense,
  onOpenOwn,
  numbered,
}: {
  chip: PrChip;
  threadId: ThreadId;
  card: boolean;
  dense: boolean;
  onOpenOwn: (() => void) | undefined;
  numbered: boolean;
}) {
  const api = useApi();
  const { entry } = chip;
  const open = (event: MouseEvent) => {
    event.preventDefault();
    if (entry.own) (onOpenOwn ?? (() => openPrPanel(threadId)))();
    else void openExternalUrl(api, entry.url);
  };
  const { marks } = chip;
  const props = {
    "data-testid": "overview-pr-chip",
    "data-pr": entry.number,
    "data-tone": chip.tone,
    "data-state": chip.kind,
    "data-merge": marks.merge?.kind,
    "aria-label": chip.label,
    onClick: open,
    className: chipClass(chip, dense),
  };
  const body = <PrChipFace chip={chip} numbered={numbered} />;
  if (!card) {
    return (
      <button type="button" {...props}>
        {body}
      </button>
    );
  }
  return (
    <PreviewCard.Root>
      <PreviewCard.Trigger delay={250} render={<button type="button" />} {...props}>
        {body}
      </PreviewCard.Trigger>
      <PreviewCard.Portal>
        <PreviewCard.Positioner side="right" align="start" sideOffset={8} className="isolate z-50">
          <PreviewCard.Popup
            data-testid="overview-pr-card"
            data-surface="overlay"
            className={cn(
              CARD_SURFACE,
              "flex w-80 max-w-[calc(100vw-24px)] flex-col p-1 text-reading",
            )}
          >
            <PrGlyphCardEntry entry={entry} marks={chip.marks} onOpen={open} />
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}

/**
 * Whether a row's PR chips fit beside its status words. The status line is one line that wraps
 * what doesn't fit out of sight: its words come first and take what they need, and the chips' unseen
 * room (`ghost`) follows them, wrapping to the hidden line when they can't sit beside the words.
 * There, the real chips aren't drawn: the status wins, and the row's hover card names the PR.
 * `count` is how many chips there are, so their room is measured again as they come and go.
 */
export function useChipsFit(count: number): {
  line: Ref<HTMLSpanElement>;
  words: Ref<HTMLSpanElement>;
  ghost: Ref<HTMLSpanElement>;
  fits: boolean;
} {
  const line = useRef<HTMLSpanElement>(null);
  const words = useRef<HTMLSpanElement>(null);
  const ghost = useRef<HTMLSpanElement>(null);
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    const at = line.current;
    if (at === null || count === 0) return setFits(true);
    const measure = () => {
      const room = ghost.current;
      if (room === null) return setFits(true);
      const outer = at.getBoundingClientRect();
      setFits(room.getBoundingClientRect().top - outer.top < Math.max(1, outer.height / 2));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(at);
    if (words.current !== null) observer.observe(words.current);
    if (ghost.current !== null) observer.observe(ghost.current);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [count]);
  return { line, words, ghost, fits };
}
