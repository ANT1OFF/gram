import {
  VOCABULARY_ENTRIES_MAX,
  VOCABULARY_SOUNDS_LIKE_MAX,
  type VocabularyEntry,
} from "@gram/contracts";

/** Longest term or spelling the list keeps, as the schema does. */
const TEXT_MAX = 80;

export const PROJECT_NAMES_HELP =
  "Spell the thread's file names, symbols and branches the way the code does.";

export const PROJECT_NAMES_MORE =
  "“use dictation dot ts” becomes use-dictation.ts. Read from git on this computer and never sent anywhere. Names made only of everyday words, like setState, are left as spoken.";

export const YOUR_WORDS_HELP = "Words dictation should write your way, with what it hears instead.";

export const YOUR_WORDS_MORE =
  "A spelling you list is always replaced; the word itself only when it isn't an everyday word.";

/** The spellings typed into one field, split at commas, each once. */
export const parseSoundsLike = (text: string): string[] => [
  ...new Set(
    text
      .split(",")
      .map((part) => part.trim().replace(/\s+/g, " "))
      .filter((part) => part !== "" && part.length <= TEXT_MAX),
  ),
];

export type VocabularyEdit =
  | { readonly ok: true; readonly entries: VocabularyEntry[] }
  | { readonly ok: false; readonly message: string };

/**
 * `entries` with `term` added, or its spellings merged into the entry already there. Says why
 * when it can't be added.
 */
export const withVocabularyEntry = (
  entries: readonly VocabularyEntry[],
  term: string,
  soundsLikeText: string,
): VocabularyEdit => {
  const word = term.trim().replace(/\s+/g, " ");
  if (word === "") return { ok: false, message: "Type the word as it should be written." };
  if (word.length > TEXT_MAX) return { ok: false, message: `Keep it to ${TEXT_MAX} characters.` };
  const heard = parseSoundsLike(soundsLikeText).filter((spelling) => spelling !== word);
  const at = entries.findIndex((entry) => entry.term === word);
  if (at === -1) {
    if (entries.length >= VOCABULARY_ENTRIES_MAX)
      return { ok: false, message: `The list holds ${VOCABULARY_ENTRIES_MAX} words at most.` };
    const added: VocabularyEntry =
      heard.length === 0
        ? { term: word }
        : { term: word, soundsLike: heard.slice(0, VOCABULARY_SOUNDS_LIKE_MAX) };
    return { ok: true, entries: [...entries, added] };
  }
  const held = entries[at]!;
  const merged = [...new Set([...(held.soundsLike ?? []), ...heard])];
  if (merged.length > VOCABULARY_SOUNDS_LIKE_MAX)
    return {
      ok: false,
      message: `A word keeps ${VOCABULARY_SOUNDS_LIKE_MAX} spellings at most.`,
    };
  const next = [...entries];
  next[at] = merged.length === 0 ? { term: word } : { term: word, soundsLike: merged };
  return { ok: true, entries: next };
};
