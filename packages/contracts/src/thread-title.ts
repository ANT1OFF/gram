/** The longest a starting title runs, in words and in characters. */
const TITLE_WORDS = 8;
const TITLE_CHARS = 60;

/** A clause boundary a long sentence is cut at, when what comes before it still says something. */
const CLAUSE = /[,;:–—]\s|\s(?:and|so|then|because|but)\s/i;

/** Openers that ask rather than name the work: "Please add…", "Can you fix…". */
const ASKING = /^(?:please|pls|hey|hi|ok|okay|so|can you|could you|would you|will you)[\s,]+/i;

const words = (text: string): string[] => text.split(/\s+/).filter((word) => word !== "");

/**
 * The title a thread starts with, from the first thing it was asked: the first sentence of its
 * first non-empty line, cut at a clause when that sentence runs long, then at a word boundary, with
 * no trailing full stop and its first letter upper case. A helper-written, agent-set or user-set
 * title replaces it; "New thread" when there is nothing to name it from.
 */
export const derivedTitle = (text: string | undefined): string => {
  const line = (text ?? "").split("\n").find((each) => each.trim() !== "") ?? "";
  let title = line.trim().replace(ASKING, "");
  // The first sentence, when one ends before the line does.
  const sentence = /^(.+?[.!?])\s+\S/.exec(title)?.[1];
  if (sentence !== undefined && words(sentence).length >= 2) title = sentence;
  if (words(title).length > TITLE_WORDS) {
    const clause = CLAUSE.exec(title);
    const head = clause === null ? "" : title.slice(0, clause.index);
    if (words(head).length >= 3) title = head;
  }
  let kept = words(title).slice(0, TITLE_WORDS);
  while (kept.length > 1 && kept.join(" ").length > TITLE_CHARS) kept = kept.slice(0, -1);
  title = kept.join(" ").slice(0, TITLE_CHARS);
  title = title.replace(/[\s.,;:!…]+$/u, "").trim();
  if (title === "") return "New thread";
  return title.charAt(0).toUpperCase() + title.slice(1);
};
