// The caps every row menu and palette command keeps (docs/design "Menu cap test"): a menu shows at
// most `MENU_CAP` items before its final More…, and a label says what it does in a few words.

/** Items a context menu shows before its final More…. */
export const MENU_CAP = 7;

/** Words a menu item's or a command's label may have. */
export const LABEL_WORD_CAP = 4;

/** Names of things in Gram that are one word however they are spelled. */
const PROPER_NAMES: readonly string[] = ["Waiting on you"];

/** A label's words: a proper name counts once, and marks such as "/" or "×" are not words. */
export function labelWords(label: string): number {
  let text = label;
  for (const name of PROPER_NAMES) text = text.replaceAll(name, "Name");
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}
