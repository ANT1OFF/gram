import { PreviewCard } from "@base-ui/react/preview-card";
import { ledgerPrsOf, type FeatureCardPr, type ThreadId } from "@gram/contracts";
import { useMemo, type MouseEvent } from "react";

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
  warning: "bg-status-needs/12 text-status-needs",
  merged: "bg-transparent text-merged",
  plain: "bg-sidebar-row-hover text-muted-foreground",
};

/**
 * `card={false}` in the compact rail's flyout, itself a card: a chip's own card would sit outside it
 * and close it, so there the chip's name carries what its card would say.
 */
export function WorkerPrChips({
  threadId,
  cardPrs,
  card = true,
}: {
  threadId: ThreadId;
  cardPrs: readonly FeatureCardPr[];
  card?: boolean;
}) {
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
  if (chips.length === 0) return null;
  const shown = chips.slice(0, MAX_PR_CHIPS);
  const more = chips.length - shown.length;
  return (
    <div
      role="group"
      aria-label="Pull requests"
      data-testid="overview-pr-chips"
      data-thread-id={threadId}
      className="flex flex-wrap gap-1 pr-1.5 pb-1 pl-6"
    >
      {shown.map((chip) => (
        <PrChipButton key={chip.entry.key} chip={chip} threadId={threadId} card={card} />
      ))}
      {more > 0 && (
        <span
          data-testid="overview-pr-more"
          role="img"
          aria-label={`${more} more pull ${more === 1 ? "request" : "requests"}`}
          className="inline-flex h-5 items-center px-1 text-[11px] text-muted-foreground tabular-nums"
        >
          +{more}
        </span>
      )}
    </div>
  );
}

function PrChipButton({
  chip,
  threadId,
  card,
}: {
  chip: PrChip;
  threadId: ThreadId;
  card: boolean;
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
    className: cn(
      "inline-flex h-5 cursor-default items-center gap-1 rounded-(--radius-sm) px-1.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
      TONE[chip.tone],
      chip.kind === "merged" && "px-0.5",
    ),
  };
  // The state's glyph keeps GitHub's colour for it, whatever tints the chip.
  const body = (
    <>
      <PrMarkIcon group="state" mark={marks.state} data-state-glyph={marks.state.kind} />
      <span
        className={cn(
          "font-mono text-[10.5px] tabular-nums",
          chip.kind === "draft" && "opacity-60",
        )}
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
            className={cn(CARD_SURFACE, "flex w-80 max-w-[calc(100vw-24px)] flex-col p-1 text-sm")}
          >
            <PrGlyphCardEntry entry={entry} marks={chip.marks} onOpen={open} />
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}
