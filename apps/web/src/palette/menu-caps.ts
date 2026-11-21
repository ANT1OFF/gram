/** Items a context menu shows before its final More…. */
export const MENU_CAP = 7;

/** Words a menu item's or a command's label may have. */
export const LABEL_WORD_CAP = 4;

const PROPER_NAMES: readonly string[] = ["Waiting on you"];

/** A label's words: a proper name counts once, and marks such as "/" or "×" are not words. */
export function labelWords(label: string): number {
  let text = label;
  for (const name of PROPER_NAMES) text = text.replaceAll(name, "Name");
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}
