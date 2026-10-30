import type { BabysitPhase, GitState, PrStatus, Thread, ThreadId } from "@gram/contracts";
import {
  ArrowRight,
  CloudOff,
  Shield,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { KeyboardEvent } from "react";

import { prFactsOfBadge } from "@/components/pr-facts";
import { prGlyphOf, prGlyphWords } from "@/components/pr-glyph-model";
import { markDisplay, PrMarkIcon } from "@/components/pr-marks";
import {
  CHECKS_DISPLAY,
  mergeMarksOf,
  PR_STATE_DISPLAY,
  prLifecycleOf,
  reviewMarkOf,
  type MergeMarkKind,
  type PrFacts,
  type PrMark,
  type PrMarkDisplay,
  type ReviewMarkKind,
} from "@/components/pr-marks-model";
import { ReviewGlyph } from "@/components/review-glyph";
import { formatRelative } from "@/lib/time";
import { Hint } from "@/components/hint";
import { cn } from "@/lib/utils";
import { PulseOnce, Swap } from "@/motion";
import { repoOfPrUrl, targetBadge } from "@/panels/pr-identity";
import { babysitBadgeLabel } from "@/panels/review/babysit-model";
import { usePrDetailPrewarm } from "@/panels/use-pr-detail-prewarm";
import { useLayoutStore, type RightPanelTab } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

/** The badge fields its two glyphs are drawn from. */
export type PrBadgeSource = Pick<PrStatus, "state" | "isDraft" | "checks" | "headMatches"> & {
  readonly requiredChecks?: PrStatus["requiredChecks"] | undefined;
};

/**
 * A red or amber checks glyph no required check accounts for is drawn dimmed, since GitHub would
 * merge past it.
 */
const checksTone = (tone: string, pr: PrBadgeSource): string =>
  pr.requiredChecks === undefined ? tone : cn(tone, "opacity-50");

/**
 * The badge's two glyphs, as GitHub draws a PR: its own state (`prLifecycleOf`) in GitHub's colour
 * for it, then every check beside the number. Its name is the one glyph's (`prGlyphOf`), which folds
 * both for places with room for one.
 */
export function prBadgeGlyphs(pr: PrBadgeSource): {
  state: PrMarkDisplay;
  checks: PrMarkDisplay | undefined;
} {
  const lifecycle = prLifecycleOf(pr);
  const state = PR_STATE_DISPLAY[lifecycle];
  if (lifecycle === "merged" || lifecycle === "closed" || pr.checks === "none") {
    return { state, checks: undefined };
  }
  const checks = CHECKS_DISPLAY[pr.checks];
  return { state, checks: { ...checks, tone: checksTone(checks.tone, pr) } };
}

/** Local commits past the PR head. Held back while diverged, where "ahead" describes a rewritten history. */
export const aheadOfPr = (git: GitState, pr: PrStatus): boolean =>
  pr.aheadOfPr && git.upstream !== "diverged";

export type PrBadgeThread = Pick<Thread, "checkout" | "currentCheckout" | "boundPr">;

/**
 * How the badge relates to where the work is. `followed`: the thread followed the
 * agent into another worktree and the badge moved with it. `elsewhere`: the thread is bound to a
 * different PR than this branch's, so the badge may not describe the work.
 */
export function prCue(
  thread: PrBadgeThread | undefined,
  pr: PrStatus,
): "followed" | "elsewhere" | undefined {
  if (!thread) return undefined;
  if (thread.boundPr !== undefined && thread.boundPr.number !== pr.number) return "elsewhere";
  if (
    thread.currentCheckout !== undefined &&
    thread.currentCheckout.path !== thread.checkout.path
  ) {
    return "followed";
  }
  return undefined;
}

/**
 * `git.pr` as the badge should paint it: anchored when the thread is bound to that very PR, by
 * repository as well as number, so its merge shows even after the branch moved on or was deleted.
 */
const painted = (git: GitState, pr: PrStatus, thread: PrBadgeThread | undefined): PrStatus =>
  targetBadge(git, thread?.boundPr) ?? pr;

/** The badge's PR as facts, with what the thread's binding adds, for its one glyph. */
const badgeFacts = (git: GitState, pr: PrStatus, thread: PrBadgeThread | undefined): PrFacts =>
  prFactsOfBadge(repoOfPrUrl(pr.url) ?? git.origin ?? "", pr.number, pr, thread?.boundPr);

const checkoutName = (checkout: Thread["checkout"]) => checkout.branch ?? checkout.path;

/** The server's actionable reason, as it gave it. */
export const staleReasonText = (reason: string): string => reason;

/** The badge tooltip: one short line per fact, so it doubles as the legend. */
export function prBadgeTitle(git: GitState, pr: PrStatus, thread?: PrBadgeThread): string {
  const lines = [
    pr.title ? `#${pr.number} ${pr.title}` : `#${pr.number}`,
    prGlyphWords(badgeFacts(git, painted(git, pr, thread), thread)),
  ];
  if (pr.stale) {
    lines.push(
      `Couldn't refresh from GitHub: ${staleReasonText(pr.stale.reason)}`,
      `Showing the state from before ${formatRelative(pr.stale.since)}; right-click to refresh`,
    );
  }
  if (aheadOfPr(git, pr)) lines.push("+  commits past the PR head, not in the PR");
  const cue = prCue(thread, pr);
  if (cue === "followed" && thread?.currentCheckout) {
    lines.push(
      `Dashed: followed the agent to ${checkoutName(thread.currentCheckout)}, launched on ${checkoutName(thread.checkout)}`,
    );
  }
  if (cue === "elsewhere" && thread?.boundPr) {
    lines.push(`→  this thread is bound to #${thread.boundPr.number}, not this branch's PR`);
  }
  if (git.workElsewhere) {
    lines.push(
      `⚠  uncommitted work on “${git.workElsewhere.branch}” in another worktree (${git.workElsewhere.path})`,
    );
  }
  lines.push("Opens the PR panel");
  return lines.join("\n");
}

const INTENT_KINDS = new Set(["refused", "held", "waiting", "armed"]);

/**
 * Where the thread's own `merge_when_ready` and `depends_on` stand, for the badge: refused, held,
 * waiting on a dependency, or armed. What GitHub says of the merge has the pane header's chip.
 */
function mergeIntentMarkOf(pr: PrStatus, thread: PrBadgeThread | undefined) {
  if (thread?.boundPr === undefined) return undefined;
  const facts = prFactsOfBadge(thread.boundPr.repo, pr.number, pr, thread.boundPr);
  const marks = mergeMarksOf(facts).filter((mark) => INTENT_KINDS.has(mark.kind));
  const first = marks[0];
  if (first === undefined) return undefined;
  return { ...first, detail: marks.map((mark) => mark.detail).join("\n") };
}

/** Focuses the thread's pane (the route follows it) and shows one panel tab, leaving focus mode. */
export function openThreadPanel(threadId: ThreadId, tab: RightPanelTab): void {
  const layout = useLayoutStore.getState();
  layout.openThread(threadId);
  layout.revealPanel(tab, { thread: true });
}

export const openPrPanel = (threadId: ThreadId): void => openThreadPanel(threadId, "pr");

/** The PR panel on its Review tab, where the bot's rounds and findings are. */
export function openPrReview(threadId: ThreadId): void {
  useLayoutStore.getState().setPrPanelTab("review");
  openPrPanel(threadId);
}

/** The PR badge for the sidebar row and pane header: state, number, bot glyph; click opens the panel. */
export function PrBadge({
  threadId,
  git,
  thread,
  testId,
  className,
  bare = false,
  numbered = true,
  tabbable = true,
}: {
  threadId: ThreadId;
  git: GitState;
  /** Enables the followed / elsewhere cues. */
  thread?: PrBadgeThread;
  testId: string;
  className?: string;
  /** No chip outline, for the sidebar row; a cue still draws its dashed one. */
  bare?: boolean;
  /** False keeps the number for the tooltip and screen readers only, where one PR needs no telling apart. */
  numbered?: boolean;
  /** False where the enclosing row is the Tab stop. */
  tabbable?: boolean;
}) {
  const prewarm = usePrDetailPrewarm(threadId);
  const pr = git.pr;
  if (!pr) return null;
  const shown = painted(git, pr, thread);
  const facts = badgeFacts(git, shown, thread);
  const glyph = prGlyphOf(facts);
  const { state, checks } = prBadgeGlyphs(shown);
  const cue = prCue(thread, pr);
  const ahead = aheadOfPr(git, pr);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    openPrPanel(threadId);
  };
  return (
    <span
      role="button"
      tabIndex={tabbable ? 0 : -1}
      data-testid={testId}
      data-state={glyph.kind}
      data-cue={cue}
      data-stale={pr.stale ? true : undefined}
      title={prBadgeTitle(git, pr, thread)}
      onClick={() => openPrPanel(threadId)}
      onKeyDown={onKeyDown}
      {...prewarm}
      className={cn(
        "flex shrink-0 cursor-pointer items-center gap-1 rounded-sm hover:bg-accent/40",
        (!bare || cue !== undefined) && "border border-border px-1",
        cue !== undefined && "border-dashed",
        cue === "followed" && "border-muted-foreground",
        cue === "elsewhere" && "border-warning",
        className,
      )}
    >
      {/* Merging is the one change here worth a small celebration; it plays once, as it happens. */}
      <PulseOnce trigger={glyph.kind} when={glyph.kind === "merged"} tone="merged" burst>
        <Swap swapKey={glyph.kind}>
          <state.icon
            role="img"
            aria-label={prGlyphWords(facts)}
            className={cn("size-3", state.tone)}
          />
        </Swap>
      </PulseOnce>
      <span className={cn("tabular-nums", !numbered && !ahead && "sr-only")}>
        <span className={cn(!numbered && "sr-only")}>#{pr.number}</span>
        {ahead ? "+" : ""}
      </span>
      {checks && (
        <PulseOnce trigger={shown.checks} when={shown.checks === "passing"} tone="success">
          <Swap swapKey={shown.checks}>
            <checks.icon
              aria-hidden
              data-testid="pr-checks-glyph"
              data-checks={shown.checks}
              className={cn("size-3", checks.tone)}
            />
          </Swap>
        </PulseOnce>
      )}
      <ReviewGlyph review={pr.review} />
      <PrBadgeMarks threadId={threadId} git={git} thread={thread} />
    </span>
  );
}

/**
 * What the thread does about its PR beside the PR's own state: an armed merge, babysitting, a stale
 * badge and where the work went. The header's badge carries them, and the PR strip's row while it
 * stands in for the badge.
 */
export function PrBadgeMarks({
  threadId,
  git,
  thread,
}: {
  threadId: ThreadId;
  git: GitState;
  thread?: PrBadgeThread | undefined;
}) {
  const pr = git.pr;
  if (!pr) return null;
  const shown = painted(git, pr, thread);
  const cue = prCue(thread, pr);
  return (
    <>
      <PrMarkIcon
        group="merge"
        mark={mergeIntentMarkOf(shown, thread)}
        labelled
        data-testid="pr-merge-intent-glyph"
      />
      {pr.stale && (
        <CloudOff
          role="img"
          aria-label="Couldn't refresh from GitHub"
          data-testid="pr-stale-glyph"
          className="size-3 text-muted-foreground"
        />
      )}
      {cue === "followed" && (
        <span className="sr-only">followed the agent into another worktree</span>
      )}
      {cue === "elsewhere" && (
        <ArrowRight
          role="img"
          aria-label={`bound to #${thread?.boundPr?.number}`}
          className="size-3 text-warning"
        />
      )}
      {git.workElsewhere && (
        <TriangleAlert
          role="img"
          aria-label={`uncommitted work on ${git.workElsewhere.branch} in another worktree`}
          className="size-3 text-warning"
        />
      )}
      <BabysitGlyph threadId={threadId} />
    </>
  );
}

const BABYSIT_DISPLAY: Record<BabysitPhase, { icon: LucideIcon; tone: string }> = {
  watching: { icon: Shield, tone: "text-muted-foreground" },
  done: { icon: ShieldCheck, tone: "text-success" },
  stopped: { icon: ShieldAlert, tone: "text-status-needs" },
};

/** A shield beside the PR number while babysit mode is on; its label carries the phase. */
function BabysitGlyph({ threadId }: { threadId: ThreadId }) {
  const babysit = useThreadsStore((s) => s.byId[threadId]?.thread.babysit);
  if (!babysit) return null;
  const display = BABYSIT_DISPLAY[babysit.phase];
  const label = babysitBadgeLabel(babysit);
  return (
    <Swap swapKey={babysit.phase} className="shrink-0">
      <display.icon
        role="img"
        aria-label={label}
        data-testid="babysit-glyph"
        data-phase={babysit.phase}
        className={cn("size-3", display.tone)}
      >
        <title>{label}</title>
      </display.icon>
    </Swap>
  );
}

/** What GitHub's `mergeStateStatus` puts between an open PR and its merge. */
const GITHUB_MERGE_KINDS: ReadonlySet<MergeMarkKind> = new Set([
  "conflicts",
  "behind",
  "blocked",
  "unstable",
]);

/**
 * What GitHub says stands between the open PR and merging, for the pane header and the PR panel:
 * the first of its merge marks (`mergeMarksOf`) that GitHub's merge state gives, so blocked is left
 * out where the thread's merge is armed, as there. The thread's own `merge_when_ready` and
 * `depends_on` have the badge's glyph (`mergeIntentMarkOf`).
 */
export function mergeStateMarkOf(
  pr: PrStatus | undefined,
  bound?: PrBadgeThread["boundPr"],
): PrMark<MergeMarkKind> | undefined {
  if (pr === undefined) return undefined;
  // The bound PR itself is anchored, as `targetBadge` has it, so its merge or close stands.
  const shown = bound?.number === pr.number ? { ...pr, headMatches: true } : pr;
  const facts = prFactsOfBadge(repoOfPrUrl(pr.url) ?? "", pr.number, shown, bound);
  return mergeMarksOf(facts).find((mark) => GITHUB_MERGE_KINDS.has(mark.kind));
}

/** People's review of the PR (`reviewMarkOf`), for the pane header; none once merged or closed. */
export function reviewDecisionMarkOf(pr: PrStatus | undefined): PrMark<ReviewMarkKind> | undefined {
  if (pr === undefined) return undefined;
  const state = prLifecycleOf(pr);
  return state === "merged" || state === "closed" ? undefined : reviewMarkOf(pr);
}

/**
 * One PR mark as a chip: icon plus its word, never colour alone. `iconOnly` keeps the words for the
 * tooltip and screen readers, for the pane header, where the PR row above the composer has room.
 */
export function PrChip({
  group,
  mark,
  testId,
  iconOnly = false,
  className,
}: {
  group: "merge" | "review";
  mark: PrMark | undefined;
  testId: string;
  iconOnly?: boolean;
  className?: string;
}) {
  if (!mark) return null;
  const display = markDisplay(group, mark);
  if (iconOnly) {
    return (
      <Hint
        label={mark.detail === mark.word ? mark.word : `${mark.word}: ${mark.detail}`}
        side="bottom"
        render={
          <span
            data-testid={testId}
            data-state={mark.kind}
            className={cn("flex shrink-0 items-center", display.tone, className)}
          />
        }
      >
        <display.icon aria-hidden className="size-3.5" />
        <span className="sr-only">{mark.word}</span>
      </Hint>
    );
  }
  return (
    <span
      data-testid={testId}
      data-state={mark.kind}
      title={mark.detail}
      className={cn(
        "flex shrink-0 items-center gap-0.5 rounded-sm border border-border px-1",
        display.tone,
        className,
      )}
    >
      <display.icon aria-hidden className="size-3" />
      <span>{mark.word}</span>
    </span>
  );
}
