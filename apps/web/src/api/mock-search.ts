import type {
  MessageId,
  GramUIMessage,
  Thread,
  ThreadSearchHit,
  ThreadSearchResult,
} from "@gram/contracts";

const RADIUS = 48;

interface Range {
  start: number;
  end: number;
}

export const plainText = (message: GramUIMessage): string =>
  message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");

/** The words the server matches: letters or digits required, control characters dropped. */
export const searchTerms = (query: string): string[] =>
  query
    .split(/\s+/)
    .map((term) => term.replace(/\p{Cc}/gu, ""))
    .filter((term) => /[\p{L}\p{N}]/u.test(term))
    .map((term) => term.toLowerCase());

/** Where each term first occurs in `text`; undefined unless every term does. */
function matchRanges(text: string, terms: readonly string[]): Range[] | undefined {
  const lower = text.toLowerCase();
  const ranges: Range[] = [];
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at === -1) return undefined;
    ranges.push({ start: at, end: at + term.length });
  }
  return ranges.toSorted((a, b) => a.start - b.start);
}

/** A one-line snippet of `text` around the matched ranges, with their offsets in the snippet. */
export function snippetAround(
  text: string,
  ranges: readonly Range[],
  radius = RADIUS,
): Pick<ThreadSearchHit, "snippet" | "highlights"> {
  const first = Math.min(...ranges.map((r) => r.start));
  const last = Math.max(...ranges.map((r) => r.end));
  const start = Math.max(0, first - radius);
  const end = Math.min(text.length, last + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  const snippet = `${prefix}${text.slice(start, end).replaceAll("\n", " ")}${suffix}`;
  const offset = prefix.length - start;
  return {
    snippet,
    highlights: ranges.map((r) => ({ start: r.start + offset, end: r.end + offset })),
  };
}

/**
 * The mock's `thread.search`, shaped like the server's: every term must appear (the last may be a
 * prefix of a word), threads matching only by title come first, then message hits.
 */
export function searchMessages(
  threads: Iterable<{ thread: Thread; messages: readonly GramUIMessage[] }>,
  query: string,
  limit: number,
): ThreadSearchResult {
  const terms = searchTerms(query);
  if (terms.length === 0) return { hits: [], truncated: false };
  const titleHits: ThreadSearchHit[] = [];
  const messageHits: ThreadSearchHit[] = [];
  for (const { thread, messages } of threads) {
    let matchedMessage = false;
    for (const message of messages) {
      const text = plainText(message);
      const ranges = matchRanges(text, terms);
      if (!ranges) continue;
      matchedMessage = true;
      messageHits.push({
        threadId: thread.id,
        messageId: message.id as MessageId,
        title: thread.title,
        ...snippetAround(text, ranges),
      });
    }
    const titleRanges = matchedMessage ? undefined : matchRanges(thread.title, terms);
    if (titleRanges) {
      titleHits.push({
        threadId: thread.id,
        title: thread.title,
        ...snippetAround(thread.title, titleRanges),
      });
    }
  }
  const hits = [...titleHits, ...messageHits];
  return { hits: hits.slice(0, limit), truncated: hits.length > limit };
}
