import * as Schema from "effect/Schema";

import { COMMON_WORDS as COMMON } from "./common-words.ts";
import { ThreadId } from "./ids.ts";

/**
 * Dictation vocabulary: the user's own word list and the names of the project a thread works in,
 * which dictation spells the way the project does ("use dictation" → `useDictation`). Everything
 * here stays on this computer; nothing logs a term, only counts.
 */

/** A term or a spelling of one: one line, short. */
const VocabularyText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
  Schema.isPattern(/^[^\n\r]*$/),
);

/** Spellings one entry may list. */
export const VOCABULARY_SOUNDS_LIKE_MAX = 8;

/** One word of the user's list, with what the recogniser writes instead of it. */
export const VocabularyEntry = Schema.Struct({
  /** As it should be written: `Parakeet`, `useDictation`, `k8s`. */
  term: VocabularyText,
  /** What dictation hears instead: "para keet", "parakeets". Each is replaced exactly. */
  soundsLike: Schema.optionalKey(
    Schema.Array(VocabularyText).check(Schema.isMaxLength(VOCABULARY_SOUNDS_LIKE_MAX)),
  ),
});
export type VocabularyEntry = typeof VocabularyEntry.Type;

/** Entries the user's list holds at most. */
export const VOCABULARY_ENTRIES_MAX = 500;

export const VocabularyList = Schema.Array(VocabularyEntry).check(
  Schema.isMaxLength(VOCABULARY_ENTRIES_MAX),
);

/** Where a project term came from; earlier kinds win when two spell the same spoken words. */
export const ProjectTermKind = Schema.Literals(["symbol", "file", "folder", "branch", "title"]);
export type ProjectTermKind = typeof ProjectTermKind.Type;

export const ProjectTerm = Schema.Struct({ term: Schema.String, kind: ProjectTermKind });
export type ProjectTerm = typeof ProjectTerm.Type;

/** Project terms `fs.vocabulary` returns at most. */
export const PROJECT_VOCABULARY_LIMIT = 3_000;

/** `fs.vocabulary`: the names in a thread's checkout that dictation should spell its way. */
export const ProjectVocabularyFields = { threadId: ThreadId };

export const ProjectVocabulary = Schema.Struct({
  /** Identifier-shaped names only, symbols first; at most `PROJECT_VOCABULARY_LIMIT`. */
  terms: Schema.Array(ProjectTerm),
  /** The project had more names than were kept. */
  truncated: Schema.Boolean,
});
export type ProjectVocabulary = typeof ProjectVocabulary.Type;

/** A piece of a term: a word, or a separator between two. */
export type TermPart = { readonly word: string } | { readonly separator: "." | "/" | "_" | "-" };

/**
 * `term` in pieces: separators, digit runs and case boundaries split it, so `useDictation`,
 * `use_dictation` and `use-dictation` are all the words "use dictation", and `HTMLParser` is
 * "HTML parser".
 */
export const termParts = (term: string): TermPart[] => {
  const parts: TermPart[] = [];
  for (const [piece] of term.matchAll(/[./_-]|\d+|\p{L}+|[^\p{L}\d./_-]+/gu)) {
    if (piece === "." || piece === "/" || piece === "_" || piece === "-") {
      parts.push({ separator: piece });
    } else if (/^\d+$/.test(piece)) {
      parts.push({ word: piece });
    } else if (/^\p{L}+$/u.test(piece)) {
      for (const [word] of piece.matchAll(/\p{Lu}+(?!\p{Ll})|\p{Lu}?\p{Ll}+|\p{L}+/gu))
        parts.push({ word });
    }
    // Anything else (spaces, `@`, `+`) leaves no piece, so it can't be spoken either way.
  }
  return parts;
};

/** The separators a speaker has to say ("dot", "slash"); the rest they may leave out. */
const HARD = new Set([".", "/"]);

/**
 * What a term sounds like, as one key: its words lower-cased and run together, with the
 * separators that must be said kept. `useDictation` and "use dictation" are both `usedictation`;
 * `dictation.ts` and "dictation dot TS" are both `dictation.ts`.
 */
export const termKey = (parts: readonly TermPart[]): string =>
  parts
    .map((part) =>
      "word" in part ? part.word.toLowerCase() : HARD.has(part.separator) ? part.separator : "",
    )
    .join("");

export const termWords = (parts: readonly TermPart[]): string[] =>
  parts.flatMap((part) => ("word" in part ? [part.word.toLowerCase()] : []));

/** Whether `parts` has a separator the speaker has to say. */
export const hasHardSeparator = (parts: readonly TermPart[]): boolean =>
  parts.some((part) => "separator" in part && HARD.has(part.separator));

/**
 * Whether a project name can be told from ordinary speech: two words or more and at least four
 * letters, and not only common words unless a "dot" or "slash" sets it apart. `README`, `Effect`
 * and `setState` are left out, `useDictation` and `index.ts` are kept.
 */
export const distinctiveTerm = (term: string): boolean => {
  const parts = termParts(term);
  const words = termWords(parts);
  if (words.length < 2 || termKey(parts).replace(/[./]/g, "").length < 4) return false;
  return hasHardSeparator(parts) || words.some((word) => !isCommonWord(word));
};

/** A common word, or one with a common ending on it: "files", "loaded", "loading". */
export const isCommonWord = (word: string): boolean => {
  const lower = word.toLowerCase();
  if (COMMON.has(lower)) return true;
  for (const ending of ["s", "es", "ed", "d", "ing", "er", "ly"]) {
    const stem = lower.slice(0, -ending.length);
    if (lower.endsWith(ending) && stem.length >= 2 && COMMON.has(stem)) return true;
  }
  return false;
};
