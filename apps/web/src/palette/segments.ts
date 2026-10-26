export interface Segment {
  text: string;
  match: boolean;
}

/** `text` as plain and highlighted runs; ranges are sorted, clamped to the text, and overlaps merged. */
export function highlightSegments(
  text: string,
  highlights: readonly { start: number; end: number }[] = [],
): Segment[] {
  const segments: Segment[] = [];
  let at = 0;
  for (const { start, end } of highlights.toSorted((a, b) => a.start - b.start)) {
    const from = Math.max(at, Math.min(start, text.length));
    const to = Math.max(from, Math.min(end, text.length));
    if (from > at) segments.push({ text: text.slice(at, from), match: false });
    if (to > from) segments.push({ text: text.slice(from, to), match: true });
    at = to;
  }
  if (at < text.length) segments.push({ text: text.slice(at), match: false });
  return segments;
}
