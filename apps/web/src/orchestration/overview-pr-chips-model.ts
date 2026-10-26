import type { ChecksRollup, CiFixWorker, FeatureCardPr, WorkerPr } from "@gram/contracts";

import { ledgerPrFacts, prFactsOfCard } from "@/components/pr-facts";
import type { PrGlyphEntry } from "@/components/pr-glyph";
import { prGlyphLabel, prGlyphOf, type PrGlyphKind } from "@/components/pr-glyph-model";
import { prMarksOf, prUrlOf, type PrMarks } from "@/components/pr-marks-model";
import type { ReviewGlyphKind } from "@/components/review-glyph";

// A worker's pull requests as the overview's chips:
// one per PR with its number, its checks and the review bot, grey while nothing needs anyone and
// tinted when something does. No React.

/** How many chips a row shows before the rest fold into a count. */
export const MAX_PR_CHIPS = 3;

/** A chip's tint: red for what blocks the merge, amber for what someone has to look at. */
export type PrChipTone = "danger" | "warning" | "merged" | "plain";

export interface PrChip {
  readonly entry: PrGlyphEntry;
  readonly kind: PrGlyphKind;
  /** The checks that gate the merge, else all of them. */
  readonly checks: ChecksRollup | undefined;
  /** The review bot's mark, when the bot has something to say. */
  readonly bot: BotKind | undefined;
  /** People's unresolved threads. */
  readonly people: number;
  readonly tone: PrChipTone;
  /** The PR vocabulary's marks for it, with what the worker's ledger row adds. */
  readonly marks: PrMarks;
  /** The chip's accessible name: the PR's state, its checks and what the bot and people say. */
  readonly label: string;
}

export type BotKind = Exclude<ReviewGlyphKind, "reviewerThreads">;

const DANGER_BOT = new Set<BotKind>(["blockers", "changesRequested"]);

/**
 * Failing checks its worker is fixing (`fixing`) are its worker's to act on, not the user's, so they
 * don't tint the chip on their own.
 */
export const prChipTone = (
  kind: PrGlyphKind,
  bot: BotKind | undefined,
  people = 0,
  fixing = false,
): PrChipTone => {
  if (kind === "merged") return "merged";
  if ((kind === "failing" && !fixing) || (bot !== undefined && DANGER_BOT.has(bot))) {
    return "danger";
  }
  if (kind === "changes" || kind === "conflicts" || bot === "findings" || people > 0) {
    return "warning";
  }
  return "plain";
};

const lower = (text: string) => `${text[0]!.toLowerCase()}${text.slice(1)}`;

/**
 * What the chip shows, in words: the glyph's name (`prGlyphLabel`), saying failing CI its worker
 * fixes, then people's decision, the bot and people's threads, and where its merge stands, unless
 * merged.
 */
const chipLabel = (entry: PrGlyphEntry, settled: boolean, marks: PrMarks) => {
  const fixing = marks.checks?.kind === "fixing";
  const parts = [prGlyphLabel(entry.number, entry.facts, { fixing })];
  if (settled) return parts.join(", ");
  if (marks.review !== undefined) parts.push(lower(marks.review.detail));
  parts.push(...(entry.review?.label.split("\n") ?? []));
  if (marks.merge !== undefined) parts.push(...marks.merge.detail.split("\n").map(lower));
  return parts.join(", ");
};

/**
 * The card's PRs as entries, for a worker whose thread the window hasn't read: state and checks
 * only, since the card has no review. The first is the worker's own, as the card orders them.
 */
const cardEntries = (prs: readonly FeatureCardPr[]): PrGlyphEntry[] =>
  prs.map((pr, index) => {
    const facts = prFactsOfCard(pr);
    return {
      key: `${pr.repo}#${pr.number}`,
      number: pr.number,
      repo: pr.repo,
      title: undefined,
      url: prUrlOf(pr),
      glyph: prGlyphOf(facts),
      label: prGlyphLabel(pr.number, facts),
      additions: undefined,
      deletions: undefined,
      notes: [],
      stale: false,
      own: index === 0,
      checks: pr.checks,
      review: undefined,
      peopleThreads: 0,
      facts,
    };
  });

/** The worker's ledger row, for what only the server knows of its PRs. */
export interface ChipLedger {
  readonly prs: readonly WorkerPr[];
  readonly worker: CiFixWorker | undefined;
}

const samePr = (pr: WorkerPr, entry: PrGlyphEntry) =>
  pr.number === entry.number && pr.repo.toLowerCase() === (entry.repo ?? "").toLowerCase();

/**
 * A worker's chips in its card's order, its own PR first: from the thread's PRs, else its card's.
 * A closed PR is left out; a merged one stays, as the work it shipped, its checks and review done.
 * The ledger adds each PR's merge intent and dependencies, and whether its worker is fixing its CI.
 */
export function prChipsOf(
  entries: readonly PrGlyphEntry[],
  cardPrs: readonly FeatureCardPr[],
  ledger?: ChipLedger,
): readonly PrChip[] {
  const from = entries.length > 0 ? entries : cardEntries(cardPrs);
  return from
    .filter((entry) => entry.glyph.kind !== "closed")
    .map((entry) => {
      const settled = entry.glyph.kind === "merged";
      const kind = entry.review?.kind;
      const bot = settled || kind === undefined || kind === "reviewerThreads" ? undefined : kind;
      const people = settled ? 0 : entry.peopleThreads;
      const checks = settled ? undefined : entry.checks;
      const row = ledger?.prs.find((pr) => samePr(pr, entry));
      const more = row === undefined ? undefined : ledgerPrFacts(row, ledger?.worker);
      const marks = prMarksOf({
        ...entry.facts,
        ...(more === undefined
          ? {}
          : {
              ciFixing: more.ciFixing,
              // The binding's own read wins; the ledger speaks for a worker the window hasn't read.
              intent: entry.facts.intent ?? more.intent,
              dependsOn: more.dependsOn ?? entry.facts.dependsOn,
              mergeState: entry.facts.mergeState ?? more.mergeState,
            }),
      });
      const fixing = marks.checks?.kind === "fixing";
      return {
        entry,
        kind: entry.glyph.kind,
        checks,
        bot,
        people,
        tone: prChipTone(entry.glyph.kind, bot, people, fixing),
        marks,
        label: chipLabel(entry, settled, marks),
      };
    });
}
