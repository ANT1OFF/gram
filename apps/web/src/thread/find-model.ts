import type { GramUIMessage } from "@gram/contracts";

import { isToolPart } from "./parts";

/** A searchable stretch of a message: its words, or one tool call's input and output. */
export interface FindSegment {
  readonly text: string;
  /** The tool call it belongs to, whose card is closed until opened. */
  readonly toolCallId?: string | undefined;
}

/** One match: the `occurrence`-th in its message, counting its segments in order. */
export interface FindMatch {
  readonly key: string;
  readonly messageId: string;
  readonly occurrence: number;
  readonly toolCallId?: string | undefined;
}

/** A tool's output can be a whole file; past this much of it, find doesn't look. */
const TOOL_TEXT_LIMIT = 20_000;
/** Past this many matches the count says "+", as a browser's does. */
export const FIND_LIMIT = 999;

const toolText = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  return (text ?? "").slice(0, TOOL_TEXT_LIMIT);
};

/** What find searches in a message, lower-cased, kept per message (messages keep their identity). */
const segmentCache = new WeakMap<GramUIMessage, readonly FindSegment[]>();

export function findSegments(message: GramUIMessage): readonly FindSegment[] {
  const cached = segmentCache.get(message);
  if (cached) return cached;
  const segments: FindSegment[] = [];
  for (const part of message.parts) {
    if (part.type === "text" || part.type === "reasoning") {
      if (part.text !== "") segments.push({ text: part.text.toLowerCase() });
    } else if (isToolPart(part)) {
      const output = part.state === "output-available" ? toolText(part.output) : "";
      const error = part.state === "output-error" ? (part.errorText ?? "") : "";
      const text = [toolText(part.input), output, error].filter(Boolean).join("\n");
      if (text !== "") segments.push({ text: text.toLowerCase(), toolCallId: part.toolCallId });
    }
  }
  segmentCache.set(message, segments);
  return segments;
}

/**
 * Every literal, case-blind occurrence of `query` in `messages`, top to bottom: words, reasoning
 * and tool calls' input and output alike, whether their rows are drawn or not.
 */
export function findMatches(
  messages: readonly GramUIMessage[],
  query: string,
  limit = FIND_LIMIT,
): { matches: FindMatch[]; truncated: boolean } {
  const needle = query.toLowerCase();
  const matches: FindMatch[] = [];
  if (needle.trim() === "") return { matches, truncated: false };
  for (const message of messages) {
    let occurrence = 0;
    for (const segment of findSegments(message)) {
      let at = segment.text.indexOf(needle);
      while (at !== -1) {
        if (matches.length === limit) return { matches, truncated: true };
        matches.push({
          key: `${message.id}:${occurrence}`,
          messageId: message.id,
          occurrence,
          ...(segment.toolCallId === undefined ? {} : { toolCallId: segment.toolCallId }),
        });
        occurrence++;
        at = segment.text.indexOf(needle, at + needle.length);
      }
    }
  }
  return { matches, truncated: false };
}

/** Where to start: the newest match, the one nearest the bottom of the transcript. */
export const startIndex = (count: number): number => count - 1;

/** The match `delta` steps from `index`, wrapping round. */
export const stepMatch = (index: number, delta: number, count: number): number =>
  count === 0 ? -1 : (((index + delta) % count) + count) % count;
