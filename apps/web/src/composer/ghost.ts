import type { SuggestionEntry } from "@/stores/suggestions";

/** A suggestion as the composer draws it behind what's typed. */
export interface Ghost {
  readonly suggestion: string;
  /** What accepting it would add after the typed text. */
  readonly rest: string;
  /** Which of the fitting suggestions it is, and how many fit. */
  readonly position: number;
  readonly count: number;
  /** The suggestions what's typed fits, in order: what ⌥↓ / ⌥↑ step through. */
  readonly fitting: readonly string[];
}

export interface GhostInput {
  readonly text: string;
  readonly entry: SuggestionEntry | undefined;
  /** The caret sits at the end of the text, with nothing selected. */
  readonly caretAtEnd: boolean;
  /**
   * Something else has the keys or the box: a slash or @ menu, an IME composition, ↑ history,
   * a turn running, or the box not focused.
   */
  readonly blocked: boolean;
}

/**
 * The suggestion to show, if any: with the caret at the end, the chosen one or else the first of
 * those the typed text is a case-insensitive prefix of (all of them for an empty box), and only
 * while nothing else has the keys and Esc hasn't put them away.
 */
export const ghostOf = ({ text, entry, caretAtEnd, blocked }: GhostInput): Ghost | undefined => {
  if (entry === undefined || entry.dismissed || blocked || !caretAtEnd) return undefined;
  const typed = text.toLowerCase();
  const fitting = entry.replies.filter(
    (reply) => reply.length > text.length && reply.toLowerCase().startsWith(typed),
  );
  if (fitting.length === 0) return undefined;
  const position = Math.max(0, entry.chosen === undefined ? 0 : fitting.indexOf(entry.chosen));
  const suggestion = fitting[position]!;
  return {
    suggestion,
    rest: suggestion.slice(text.length),
    position,
    count: fitting.length,
    fitting,
  };
};

/** The suggestion `step` places from `ghost`'s among those that fit, round the ends. */
export const stepped = (ghost: Ghost, step: number): string =>
  ghost.fitting[(((ghost.position + step) % ghost.count) + ghost.count) % ghost.count]!;

/** The next word of `rest`, with the space before it: what ⌥→ takes. */
export const nextWord = (rest: string): string => /^\s*\S+/.exec(rest)?.[0] ?? rest;

/**
 * Types `text` at the caret as though the user had, so ⌘Z takes it back in one step: setting the
 * value instead would wipe the text area's undo history. False where the browser can't
 * (`execCommand` is deprecated, and absent from test DOMs), for the caller to set it another way.
 */
export const typeIntoField = (field: HTMLTextAreaElement, text: string): boolean => {
  field.focus();
  try {
    return document.execCommand("insertText", false, text);
  } catch {
    // Some test DOMs throw instead of returning false.
    return false;
  }
};
