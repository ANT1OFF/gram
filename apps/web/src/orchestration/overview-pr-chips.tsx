import { PreviewCard } from "@base-ui/react/preview-card";
import { ledgerPrsOf, type FeatureCardPr, type ThreadId } from "@gram/contracts";
import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type Ref } from "react";

import { useApi } from "@/api/context";
import { openExternalUrl } from "@/api/open-external";
import { openPrPanel } from "@/components/git-badges";
import { PrGlyphCardEntry, threadPrEntries } from "@/components/pr-glyph";
import { PrMarkIcon } from "@/components/pr-marks";
import { cn } from "@/lib/utils";
import { CARD_SURFACE } from "@/reviews/pr-display";
import { useThreadsStore } from "@/stores/threads";

import { MAX_PR_CHIPS, prChipsOf, type PrChip, type PrChipTone } from "./overview-pr-chips-model";
import { useOrchestratorLedger } from "./use-orchestration";

// A worker's pull requests under its overview row:
// a chip per PR in the PR vocabulary (pr-marks-model.ts): its state's glyph and number, then its
// checks, people's review, the review bot and where its merge stands. A click opens the PR: the
// thread's own in its PR panel, one it follows on GitHub. Hovering or focusing one shows its card.

const TONE: Record<PrChipTone, string> = {
  danger: "bg-destructive/12 text-destructive",
  // Something for someone to look at: outlined, not amber, which is for what needs you.
  warning: "bg-transparent text-foreground ring-1 ring-border-strong ring-inset",
  merged: "bg-transparent text-merged",
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
  // The thread and its git state only, so a worker's activity ticks don't rebuild its chips.
  const thread = useThreadsStore((s) => s.byId[threadId]?.thread);
  const git = useThreadsStore((s) => s.byId[threadId]?.git);
  // The worker's ledger row: its PRs' merge intents and dependencies, and who fixes its CI.
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

/** The PR numbers a worker's chips show, the first `MAX_PR_CHIPS`. */
export const shownPrNumbers = (chips: readonly PrChip[]): readonly { number: number }[] =>
  chips.slice(0, MAX_PR_CHIPS).map((chip) => ({ number: chip.entry.number }));

/**
 * `card={false}` in the compact rail's flyout, itself a card: a chip's own card would sit outside it
 * and close it, so there the chip's name carries what its card would say. `dense`, on an overview
 * row's status line, 16 px tall, so the line keeps its height. `ghost` draws them unseen and
 * inert, to hold their room inside a row's button while the real ones sit over it; `ghostRef` is
 * that room's, for `useChipsFit`.
 */
export function WorkerPrChips({
  threadId,
  cardPrs,
  chips: given,
  card = true,
  dense = false,
  ghost = false,
  ghostRef,
  className = "pr-1.5 pb-1 pl-6",
}: {
  threadId: ThreadId;
  cardPrs: readonly FeatureCardPr[];
  /** The chips, when the caller already has them (`useWorkerPrChips`). */
  chips?: readonly PrChip[] | undefined;
  card?: boolean;
  dense?: boolean;
  ghost?: boolean;
  ghostRef?: Ref<HTMLSpanElement> | undefined;
  /** Where the chips sit: under an overview row's name by default. */
  className?: string;
}) {
  const own = useWorkerPrChips(threadId, cardPrs);
  const chips = given ?? own;
  if (chips.length === 0) return null;
  const shown = chips.slice(0, MAX_PR_CHIPS);
  const more = chips.length - shown.length;
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
      </span>
    );
  }
  return (
    <div
      role="group"
      aria-label="Pull requests"
      data-testid="overview-pr-chips"
      data-thread-id={threadId}
      className={cn("flex gap-1", dense ? "flex-nowrap" : "flex-wrap", className)}
    >
      {shown.map((chip) => (
        <PrChipButton
          key={chip.entry.key}
          chip={chip}
          threadId={threadId}
          card={card}
          dense={dense}
        />
      ))}
      {moreText}
    </div>
  );
}

/** A chip's box: its tone, and 16 px tall on a row's status line or 20 px elsewhere. */
const chipClass = (chip: PrChip, dense: boolean) =>
  cn(
    "inline-flex cursor-default items-center gap-1 rounded-(--radius-sm) px-1.5 text-meta outline-none focus-visible:ring-2 focus-visible:ring-ring",
    dense ? "h-4" : "h-5",
    TONE[chip.tone],
    chip.kind === "merged" && "px-0.5",
  );

/** What a chip shows: its state's glyph, its number, then its checks, reviews and merge. */
function PrChipFace({ chip }: { chip: PrChip }) {
  const { entry, marks } = chip;
  // The state's glyph keeps GitHub's colour for it, whatever tints the chip.
  return (
    <>
      <PrMarkIcon group="state" mark={marks.state} data-state-glyph={marks.state.kind} />
      <span
        className={cn("font-mono text-meta tabular-nums", chip.kind === "draft" && "opacity-60")}
      >
        #{entry.number}
      </span>
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
}: {
  chip: PrChip;
  threadId: ThreadId;
  card: boolean;
  dense: boolean;
}) {
  const api = useApi();
  const { entry } = chip;
  const open = (event: MouseEvent) => {
    event.preventDefault();
    if (entry.own) openPrPanel(threadId);
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
  const body = <PrChipFace chip={chip} />;
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
    // No chips, nothing to fit.
    if (at === null || count === 0) return setFits(true);
    const measure = () => {
      const room = ghost.current;
      if (room === null) return setFits(true);
      const outer = at.getBoundingClientRect();
      // On the line's own row, or wrapped below it into the hidden one.
      setFits(room.getBoundingClientRect().top - outer.top < Math.max(1, outer.height / 2));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    // Measured on the next frame, never inside the observer's own delivery.
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
