import type { ChecksRollup, GitState, Thread } from "@gram/contracts";
import type { MouseEvent } from "react";

import { aheadOfPr, prCue, staleReasonText, type PrBadgeThread } from "@/components/git-badges";
import {
  PR_GLYPH_DISPLAY,
  prGlyphLabel,
  prGlyphOf,
  type PrGlyphState,
} from "@/components/pr-glyph-model";
import { prFactsOfBadge } from "@/components/pr-facts";
import { DiffStat, PrMarkIcon, PrMarkLines, PrRef } from "@/components/pr-marks";
import { CHECKS_DISPLAY, prMarksOf, type PrFacts } from "@/components/pr-marks-model";
import { reviewGlyphOf, type ReviewGlyphState } from "@/components/review-glyph";
import { agoText } from "@/lib/time";
import { cn } from "@/lib/utils";
import { babysitBadgeLabel } from "@/panels/review/babysit-model";
import { repoOfPrUrl, targetBadge } from "@/panels/pr-identity";
import { extraRowsOf } from "@/thread/pr-strip-model";

/** One PR in a row's hover card. */
export interface PrGlyphEntry {
  /** `owner/repo#number`, unique within the row. */
  key: string;
  number: number;
  /** `owner/repo`. */
  repo: string | undefined;
  title: string | undefined;
  url: string;
  glyph: PrGlyphState;
  /** The glyph's accessible name for this PR alone. */
  label: string;
  additions: number | undefined;
  deletions: number | undefined;
  /** What else is true of it, a short line each: the bot's review, babysitting, a stale read. */
  notes: readonly string[];
  stale: boolean;
  /** The thread's own PR opens the PR panel; one it follows opens on GitHub. */
  own: boolean;
  /** The checks that gate the merge, else all of them; absent until a lookup lands. */
  checks: ChecksRollup | undefined;
  /** The review bot's and people's part, when either has something to say. */
  review: ReviewGlyphState | undefined;
  /** People's unresolved threads, which the review glyph names but its kind may not show. */
  peopleThreads: number;
  /** Everything known of it, for the PR vocabulary's marks. */
  facts: PrFacts;
}

export type PrGlyphThread = PrBadgeThread & Pick<Thread, "extraPrs" | "babysit">;

const checkoutName = (checkout: Thread["checkout"]) => checkout.branch ?? checkout.path;

/** Checks GitHub doesn't require are failing, which the glyph leaves out since it would merge. */
const optionalFailing = (pr: Pick<PrFacts, "checks" | "requiredChecks">) =>
  pr.checks === "failing" && pr.requiredChecks !== undefined && pr.requiredChecks !== "failing";

/**
 * The thread's PRs as its row's card lists them: its own (the bound one, else the branch's), then
 * those it follows, each with its facts.
 */
export function threadPrEntries(
  thread: PrGlyphThread,
  git: GitState | undefined,
): readonly PrGlyphEntry[] {
  const entries: PrGlyphEntry[] = [];
  const pr = git?.pr;
  if (git !== undefined && pr !== undefined) {
    const shown = targetBadge(git, thread.boundPr) ?? pr;
    const notes: string[] = [];
    const review = reviewGlyphOf(shown.review);
    if (review) notes.push(...review.label.split("\n"));
    if (optionalFailing(shown)) notes.push("Checks GitHub doesn't require are failing");
    if (thread.babysit) notes.push(babysitBadgeLabel(thread.babysit));
    if (pr.stale) {
      notes.push(
        `Couldn't refresh from GitHub (${staleReasonText(pr.stale.reason)}); showing the state from ${agoText(pr.stale.since)}`,
      );
    }
    if (aheadOfPr(git, pr)) notes.push("Local commits past the PR head, not in the PR");
    const cue = prCue(thread, pr);
    if (cue === "followed" && thread.currentCheckout) {
      notes.push(
        `Followed the agent to ${checkoutName(thread.currentCheckout)}, launched on ${checkoutName(thread.checkout)}`,
      );
    }
    if (cue === "elsewhere" && thread.boundPr) {
      notes.push(`This thread is bound to #${thread.boundPr.number}, not this branch's PR`);
    }
    if (git.workElsewhere) {
      notes.push(`Uncommitted work on “${git.workElsewhere.branch}” in another worktree`);
    }
    const repo = repoOfPrUrl(shown.url) ?? git.origin;
    const facts = prFactsOfBadge(repo ?? "", shown.number, shown, thread.boundPr);
    entries.push({
      key: `${repo ?? ""}#${shown.number}`,
      number: shown.number,
      repo,
      title: shown.title || undefined,
      url: shown.url,
      glyph: prGlyphOf(facts),
      label: prGlyphLabel(shown.number, facts),
      additions: shown.additions,
      deletions: shown.deletions,
      notes,
      stale: pr.stale !== undefined,
      own: true,
      checks: shown.requiredChecks ?? shown.checks,
      review,
      peopleThreads: shown.review?.threads.humanUnresolved ?? 0,
      facts,
    });
  }
  for (const extra of extraRowsOf(thread.extraPrs, git)) {
    const review = reviewGlyphOf(extra.status?.review);
    const facts =
      extra.status === undefined
        ? undefined
        : prFactsOfBadge(
            extra.fullRepo,
            extra.number,
            {
              ...extra.status,
              ...(extra.title === undefined ? {} : { title: extra.title }),
              ...(extra.changedFiles === undefined ? {} : { changedFiles: extra.changedFiles }),
            },
            thread.extraPrs?.find(
              (bound) =>
                bound.number === extra.number &&
                bound.repo.toLowerCase() === extra.fullRepo.toLowerCase(),
            ),
          );
    entries.push({
      key: `${extra.fullRepo}#${extra.number}`,
      number: extra.number,
      repo: extra.fullRepo,
      title: extra.title,
      url: extra.url,
      glyph: prGlyphOf(facts),
      label: prGlyphLabel(extra.number, facts),
      additions: extra.additions,
      deletions: extra.deletions,
      notes: review ? review.label.split("\n") : [],
      stale: false,
      own: false,
      checks: extra.status?.requiredChecks ?? extra.status?.checks,
      review,
      peopleThreads: extra.status?.review?.threads.humanUnresolved ?? 0,
      facts: facts ?? { repo: extra.fullRepo, number: extra.number, title: extra.title },
    });
  }
  return entries;
}

/**
 * Title, then the state's glyph and word · `repo#N` with the change size at the end; a line per mark
 * the PR vocabulary has for it (checks, review, bot, merge), then a note per other fact.
 */
export function PrGlyphCardEntry({
  entry,
  onOpen,
  marks = prMarksOf(entry.facts),
}: {
  entry: PrGlyphEntry;
  onOpen: (event: MouseEvent) => void;
  /** The entry's marks, when the caller knows more of it than the entry (a ledger row's). */
  marks?: ReturnType<typeof prMarksOf>;
}) {
  const display = PR_GLYPH_DISPLAY[entry.glyph.kind];
  // The review bot's and the stale read's notes are lines of their own below; keep the rest.
  const notes = entry.notes.filter(
    (note) => !note.startsWith("Review bot:") && !note.startsWith("Reviewers:"),
  );
  return (
    <button
      type="button"
      data-testid="pr-glyph-entry"
      data-state={entry.glyph.kind}
      title={entry.own ? "Opens the PR panel" : "Opens on GitHub"}
      onClick={onOpen}
      className="flex w-full min-w-0 flex-col gap-0.5 rounded-sm px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex w-full min-w-0 items-center gap-1.5">
        <PrMarkIcon group="state" mark={marks.state} className="size-3.5" />
        <span className="min-w-0 truncate text-[13px] font-medium">
          {entry.title ?? `#${entry.number}`}
        </span>
      </span>
      <span className="flex w-full min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        {/* Failing CI its worker is fixing is the worker's to act on: the working tone, not red. */}
        <span
          className={cn(
            "shrink-0",
            marks.checks?.kind === "fixing" && entry.glyph.kind === "failing"
              ? CHECKS_DISPLAY.fixing.tone
              : display.tone,
          )}
        >
          {entry.glyph.word}
        </span>
        <span aria-hidden>·</span>
        {entry.repo === undefined ? (
          <span className="font-mono tabular-nums">#{entry.number}</span>
        ) : (
          <PrRef
            pr={{ repo: entry.repo, number: entry.number }}
            branch={entry.facts.branch}
            compact={false}
            className="min-w-0 truncate"
          />
        )}
        <DiffStat
          additions={entry.additions}
          deletions={entry.deletions}
          changedFiles={entry.facts.changedFiles}
          className="ml-auto"
        />
      </span>
      <PrMarkLines marks={marks} className="mt-0.5" />
      {notes.map((note) => (
        <span key={note} className="w-full text-[11px] text-muted-foreground">
          {note}
        </span>
      ))}
    </button>
  );
}
