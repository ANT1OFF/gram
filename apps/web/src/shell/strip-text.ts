// What the Focus review strip makes of a message's Markdown: its inline marks (links, code, bold,
// italics) as marks, never as their syntax, and its block marks (headings, list bullets, code
// fences) reduced to the line's words. Links read as their text, a long URL shortened. No React.

export type StripMark =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "strong"; readonly marks: readonly StripMark[] }
  | { readonly kind: "em"; readonly marks: readonly StripMark[] }
  | { readonly kind: "link"; readonly text: string; readonly href: string };

/** Link text past this many characters ends in an ellipsis. */
export const LINK_TEXT_MAX = 36;
/** A URL shown as text past this many characters keeps only its host and last part. */
const URL_TEXT_MAX = 28;

/** Only these open from the strip; any other link reads as its text. */
const OPENS = /^(?:https?:|mailto:)/i;

// In order of precedence at one position: a link, inline code, bold, italics, a bare URL. A bare
// URL leaves off the punctuation that ends a sentence around it.
const INLINE =
  /\[([^\]\n]+)\]\(([^)\s]+)\)|`([^`\n]+)`|\*\*([^\n]+?)\*\*|(?<![*\w])\*([^*\s](?:[^*\n]*?[^*\s])?)\*(?![*\w])|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])/g;

/**
 * A URL as a reader names it: no scheme or `www.`, and when long, its host and last part with what
 * lies between left out (`github.com/…/pull/142`).
 */
export const shortUrl = (url: string): string => {
  const bare = url
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/$/, "");
  if (bare.length <= URL_TEXT_MAX) return bare;
  const parts = bare.split("/");
  const host = parts[0] ?? bare;
  const tail = parts.slice(-2).join("/");
  const short = parts.length > 3 ? `${host}/…/${tail}` : bare;
  return clip(short);
};

const clip = (text: string): string =>
  text.length <= LINK_TEXT_MAX ? text : `${text.slice(0, LINK_TEXT_MAX - 1).trimEnd()}…`;

/** What a link reads as: its own text, or, where that is the URL itself, the URL shortened. */
export const linkText = (text: string, href: string): string =>
  text === href || /^[a-z]+:\/\//i.test(text) ? shortUrl(text) : clip(text);

/** One line's inline marks. */
export const inlineMarks = (line: string): StripMark[] => {
  const marks: StripMark[] = [];
  let at = 0;
  const text = (to: number) => {
    if (to > at) marks.push({ kind: "text", text: line.slice(at, to) });
  };
  for (const match of line.matchAll(INLINE)) {
    const [whole, label, href, code, strong, em, url] = match;
    text(match.index);
    if (label !== undefined && href !== undefined) {
      marks.push(
        OPENS.test(href)
          ? { kind: "link", text: linkText(label, href), href }
          : { kind: "text", text: label },
      );
    } else if (code !== undefined) {
      marks.push({ kind: "code", text: code });
    } else if (strong !== undefined) {
      marks.push({ kind: "strong", marks: inlineMarks(strong) });
    } else if (em !== undefined) {
      marks.push({ kind: "em", marks: inlineMarks(em) });
    } else if (url !== undefined) {
      marks.push({ kind: "link", text: shortUrl(url), href: url });
    }
    at = match.index + whole.length;
  }
  text(line.length);
  return marks;
};

/**
 * A message's lines, each as its inline marks: a heading's `#`s, a quote's `>` and a fence's
 * backticks go, and a list item keeps a bullet. Blank lines stay, as paragraph breaks.
 */
export const stripLines = (text: string): StripMark[][] =>
  text.split("\n").flatMap((raw) => {
    if (/^\s*(?:```|~~~)/.test(raw)) return [];
    const line = raw
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^\s*>\s?/, "")
      .replace(/^(\s*)[-*+]\s+(?:\[[ xX]\]\s+)?/, "$1• ");
    return [inlineMarks(line)];
  });
