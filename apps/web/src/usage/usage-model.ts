import type {
  UsageLimitObservation,
  UsageModelShare,
  UsageOverview,
  UsageProvider,
  UsageTotals,
} from "@gram/contracts";

import { dateTimeFormat } from "@/lib/intl";

/**
 * A model's family, the one thing the Usage page colours by. Families stay put when a filter or a
 * new period changes which models are biggest, so a colour always means the same thing.
 */
export const FAMILIES = ["opus", "sonnet", "haiku", "codex", "other"] as const;
export type Family = (typeof FAMILIES)[number];

export const FAMILY_LABEL: Readonly<Record<Family, string>> = {
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  codex: "Codex",
  other: "Other",
};

/** Each provider's brand colour (palette.ts `provider-*`): Anthropic's orange, OpenAI's black or white. */
export const PROVIDER_COLOR: Readonly<Record<UsageProvider, string>> = {
  claude: "var(--provider-anthropic)",
  codex: "var(--provider-openai)",
};

/**
 * A family's colour. Claude's models are shades of its orange: Opus the full colour, Sonnet and
 * Haiku mixed toward the text colour (lighter on a dark page, darker on a light one, so they keep
 * contrast in both), and Other, a model the name doesn't recognise, faded toward the muted text.
 */
export const FAMILY_COLOR: Readonly<Record<Family, string>> = {
  opus: PROVIDER_COLOR.claude,
  sonnet: "color-mix(in oklch, var(--provider-anthropic) 75%, var(--fg))",
  haiku: "color-mix(in oklch, var(--provider-anthropic) 50%, var(--fg))",
  codex: PROVIDER_COLOR.codex,
  other: "color-mix(in oklch, var(--provider-anthropic) 40%, var(--fg-muted))",
};

/** Codex's models are one family; Claude's go by the name in their model id. */
export function familyOf(provider: UsageProvider, model: string | null): Family {
  if (provider === "codex") return "codex";
  const name = model?.toLowerCase() ?? "";
  if (name.includes("opus")) return "opus";
  if (name.includes("sonnet")) return "sonnet";
  if (name.includes("haiku")) return "haiku";
  return "other";
}

export type FamilyTotals = Readonly<Record<Family, number>>;
const noFamilies = (): Record<Family, number> => ({
  opus: 0,
  sonnet: 0,
  haiku: 0,
  codex: 0,
  other: 0,
});

/** A breakdown row's models summed by family. */
export function familiesOf(models: readonly UsageModelShare[]): FamilyTotals {
  const sums = noFamilies();
  for (const share of models) sums[familyOf(share.provider, share.model)] += share.totalTokens;
  return sums;
}

/** Input tokens of every kind: cached, written to cache, uncached and unsplit. */
const inputOf = (t: UsageTotals): number =>
  t.uncachedInputTokens + t.cacheReadTokens + t.cacheWriteTokens + t.unclassifiedInputTokens;

/** Cache reads as a share of input, from 0 to 1; undefined with no input. */
export const cacheShare = (t: UsageTotals): number | undefined => {
  const input = inputOf(t);
  return input === 0 ? undefined : t.cacheReadTokens / input;
};

export interface UsageDay {
  /** `YYYY-MM-DD`, UTC, as the server groups. */
  readonly day: string;
  readonly total: number;
  readonly families: FamilyTotals;
  readonly cacheRead: number;
  readonly input: number;
}

const DAY_MS = 86_400_000;

/** Every UTC day of the period, with nothing counted on a day that had none. */
export function usageDays(data: Pick<UsageOverview, "from" | "to" | "rows">): UsageDay[] {
  const days = new Map<
    string,
    { total: number; families: Record<Family, number>; cacheRead: number; input: number }
  >();
  for (let at = Math.floor(data.from / DAY_MS) * DAY_MS; at < data.to; at += DAY_MS)
    days.set(new Date(at).toISOString().slice(0, 10), {
      total: 0,
      families: noFamilies(),
      cacheRead: 0,
      input: 0,
    });
  for (const row of data.rows) {
    const day = days.get(row.day);
    if (day === undefined) continue;
    day.total += row.totals.totalTokens;
    day.families[familyOf(row.provider, row.model)] += row.totals.totalTokens;
    day.cacheRead += row.totals.cacheReadTokens;
    day.input += inputOf(row.totals);
  }
  return [...days].map(([day, d]) => ({ day, ...d }));
}

/** The families with any tokens, in their fixed order. */
export const familiesIn = (days: readonly UsageDay[]): Family[] =>
  FAMILIES.filter((family) => days.some((day) => day.families[family] > 0));

/** A round top for a y-axis at or above `max`, with a round half for the midline. */
export function niceCeiling(max: number): number {
  if (max <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 1.2, 1.6, 2, 3, 4, 5, 6, 8, 10])
    if (step * power >= max) return step * power;
  return 10 * power;
}

const COMPACT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const WHOLE = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });
/** "57M", "3.6M", "820K", "940". */
export const compactTokens = (n: number): string => COMPACT.format(n);
/** "57,012,334". */
export const wholeTokens = (n: number): string => WHOLE.format(n);

/** "Fri 16 Oct" for a `YYYY-MM-DD` UTC day. */
export const dayLabel = (day: string, { weekday = false } = {}): string =>
  dateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    ...(weekday ? { weekday: "short" } : {}),
  }).format(Date.parse(`${day}T00:00:00Z`));

/** The local limit history for one provider's window, oldest first, within the last `span` ms. */
export function limitHistory(
  observations: readonly UsageLimitObservation[] | undefined,
  provider: UsageProvider,
  window: "five_hour" | "seven_day",
  now: number,
  span: number,
): UsageLimitObservation[] {
  return (observations ?? [])
    .filter(
      (o) => o.provider === provider && o.window === window && o.at <= now && o.at >= now - span,
    )
    .toSorted((a, b) => a.at - b.at);
}
