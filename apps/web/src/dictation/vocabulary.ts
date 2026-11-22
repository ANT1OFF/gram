import {
  isCommonWord,
  termKey,
  termParts,
  termWords,
  type ProjectTerm,
  type ProjectTermKind,
  type VocabularyEntry,
} from "@gram/contracts";

const RANK: Readonly<Record<"alias" | "user" | ProjectTermKind, number>> = {
  alias: 0,
  user: 1,
  symbol: 2,
  file: 3,
  folder: 4,
  branch: 5,
  title: 6,
};

interface Candidate {
  readonly term: string;
  readonly rank: number;
  readonly guarded: boolean;
}

interface Slot extends Candidate {
  readonly ambiguous?: boolean;
}

export interface VocabularyIndex {
  readonly exact: ReadonlyMap<string, Slot>;
  /** Long keys for near misses, by their first letter. */
  readonly near: ReadonlyMap<string, readonly { key: string; candidate: Candidate }[]>;
  /** The most pieces any name has, to bound the spans tried. */
  readonly longest: number;
  readonly size: number;
}

export const EMPTY_VOCABULARY: VocabularyIndex = {
  exact: new Map(),
  near: new Map(),
  longest: 0,
  size: 0,
};

const NEAR_MIN_KEY = 8;
const NEAR_TWO_KEY = 12;
const SPAN_CAP = 12;

const nearAllowance = (length: number) => (length >= NEAR_TWO_KEY ? 2 : 1);

/**
 * The index `applyVocabulary` reads, from the user's list and the project's names. Build it when
 * either changes, not per utterance.
 */
export const buildVocabularyIndex = (
  user: readonly VocabularyEntry[],
  project: readonly ProjectTerm[],
): VocabularyIndex => {
  const exact = new Map<string, Slot>();
  const near = new Map<string, { key: string; candidate: Candidate }[]>();
  let longest = 0;

  const add = (spoken: string, candidate: Candidate) => {
    const parts = termParts(spoken);
    const key = termKey(parts);
    if (key === "") return;
    longest = Math.max(longest, parts.length);
    const held = exact.get(key);
    if (held === undefined || candidate.rank < held.rank) exact.set(key, candidate);
    else if (candidate.rank === held.rank && held.term !== candidate.term)
      exact.set(key, { ...held, ambiguous: true });
  };

  for (const entry of user) {
    const term = entry.term.trim();
    if (term === "") continue;
    add(term, { term, rank: RANK.user, guarded: termWords(termParts(term)).length < 2 });
    for (const alias of entry.soundsLike ?? []) {
      if (alias.trim() !== "") add(alias, { term, rank: RANK.alias, guarded: false });
    }
  }
  for (const { term, kind } of project) add(term, { term, rank: RANK[kind], guarded: true });

  for (const [key, slot] of exact) {
    if (slot.ambiguous === true || slot.rank === RANK.alias || key.length < NEAR_MIN_KEY) continue;
    const bucket = near.get(key[0]!) ?? [];
    bucket.push({ key, candidate: slot });
    near.set(key[0]!, bucket);
  }

  return { exact, near, longest, size: exact.size };
};

const SPOKEN_SEPARATORS: Readonly<Record<string, string>> = {
  dot: ".",
  slash: "/",
  underscore: "_",
  dash: "-",
  hyphen: "-",
};

interface Unit {
  readonly start: number;
  readonly end: number;
  readonly word?: string | undefined;
  readonly separator?: string | undefined;
}

const unitsOf = (text: string): Unit[] => {
  const units: Unit[] = [];
  const pattern = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*|[./_-]/gu;
  const found = [...text.matchAll(pattern)];
  for (const [index, match] of found.entries()) {
    const start = match.index;
    const end = start + match[0].length;
    if (/^[./_-]$/.test(match[0])) {
      const before = found[index - 1];
      const after = found[index + 1];
      const glued =
        before !== undefined &&
        after !== undefined &&
        before.index + before[0].length === start &&
        after.index === end &&
        !/^[./_-]$/.test(before[0]) &&
        !/^[./_-]$/.test(after[0]);
      if (glued) units.push({ start, end, separator: match[0] });
      else units.push({ start, end });
      continue;
    }
    const spoken = SPOKEN_SEPARATORS[match[0].toLowerCase()];
    units.push(
      spoken === undefined ? { start, end, word: match[0] } : { start, end, separator: spoken },
    );
  }
  return units;
};

const distance = (a: string, b: string, max: number): number => {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Uint16Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      current[j] = value;
      best = Math.min(best, value);
    }
    if (best > max) return max + 1;
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
};

const nearMatch = (index: VocabularyIndex, key: string): Candidate | undefined => {
  if (key.length < NEAR_MIN_KEY) return undefined;
  const bucket = index.near.get(key[0]!);
  if (bucket === undefined) return undefined;
  let best: Candidate | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  let tied = false;
  for (const { key: other, candidate } of bucket) {
    if (key.startsWith(other) || other.startsWith(key)) continue;
    const allowed = nearAllowance(other.length);
    const d = distance(key, other, allowed);
    if (d > allowed) continue;
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
      tied = false;
    } else if (d === bestDistance && best?.term !== candidate.term) {
      tied = true;
    }
  }
  return tied ? undefined : best;
};

const spanOf = (units: readonly Unit[], text: string, start: number, end: number) => {
  const first = units[start]!;
  const last = units[end]!;
  if (first.word === undefined || last.word === undefined) return undefined;
  let key = "";
  const words: string[] = [];
  let hard = false;
  for (let i = start; i <= end; i++) {
    const unit = units[i]!;
    if (i > start) {
      const gap = text.slice(units[i - 1]!.end, unit.start);
      if (gap !== "" && !/^[ \t]+$/.test(gap)) return undefined;
    }
    if (unit.word !== undefined) {
      key += unit.word.toLowerCase();
      words.push(unit.word);
    } else if (unit.separator === "." || unit.separator === "/") {
      key += unit.separator;
      hard = true;
    } else if (unit.separator === undefined) {
      return undefined;
    }
  }
  return { key, words, hard };
};

const allowed = (candidate: Candidate, words: readonly string[], hard: boolean) =>
  !candidate.guarded || hard || words.some((word) => !isCommonWord(word));

/** `text` with the names in `index` spelled their way. */
export const applyVocabulary = (text: string, index: VocabularyIndex): string => {
  if (index.size === 0 || text === "") return text;
  const units = unitsOf(text);
  const longest = Math.min(SPAN_CAP, index.longest + 2);
  let out = "";
  let copied = 0;
  let i = 0;
  while (i < units.length) {
    let replaced: { end: number; term: string } | undefined;
    for (const pass of ["exact", "near"] as const) {
      for (let end = Math.min(units.length - 1, i + longest - 1); end >= i; end--) {
        const span = spanOf(units, text, i, end);
        if (span === undefined) continue;
        let candidate: Candidate | undefined;
        if (pass === "exact") {
          const slot = index.exact.get(span.key);
          candidate = slot?.ambiguous === true ? undefined : slot;
        } else {
          candidate = nearMatch(index, span.key);
        }
        if (candidate === undefined || !allowed(candidate, span.words, span.hard)) continue;
        replaced = { end, term: candidate.term };
        break;
      }
      if (replaced !== undefined) break;
    }
    if (replaced === undefined) {
      i++;
      continue;
    }
    const from = units[i]!.start;
    const to = units[replaced.end]!.end;
    out += text.slice(copied, from) + replaced.term;
    copied = to;
    i = replaced.end + 1;
  }
  return out + text.slice(copied);
};
