// Gram's bounded buffers and retention: what a process's output, a log or a folder of records may
// hold. Every cap here counts what is kept, never what arrived, so a single huge line or chunk can't
// grow a buffer past it before the cap is applied.

/** The longest line kept by default, in characters. */
export const LINE_CHARS = 16_384;
/** Ends a line cut at its cap. */
export const TRUNCATED = " … [line truncated]";

/**
 * Splits streamed text into lines, keeping at most `maxChars` of each while it arrives, so a line
 * that never ends can't grow without bound. `onLine` gets each line as kept, and whether more of it
 * was dropped; `end` hands over a last line that never ended.
 */
export const makeLineCutter = (
  onLine: (text: string, cut: boolean) => void,
  maxChars: number = LINE_CHARS,
) => {
  let partial = "";
  let cut = false;
  const take = (piece: string) => {
    if (cut) return;
    const room = maxChars - partial.length;
    if (piece.length > room) cut = true;
    partial += piece.slice(0, room);
  };
  const end = () => {
    const text = partial;
    const wasCut = cut;
    partial = "";
    cut = false;
    onLine(text, wasCut);
  };
  return {
    write: (chunk: string) => {
      const pieces = chunk.split(/\r?\n/);
      const rest = pieces.pop() ?? "";
      for (const piece of pieces) {
        take(piece);
        end();
      }
      take(rest);
    },
    end,
  };
};

/**
 * Appends to `items` keeping at most `maxItems` of them and at most `maxSize` by `sizeOf` together,
 * the oldest dropped first. `items` is the caller's own array, which readers may hold.
 */
export const makeBoundedList = <T>(
  items: Array<T>,
  limits: {
    readonly maxItems: number;
    readonly maxSize?: number;
    readonly sizeOf?: (item: T) => number;
  },
) => {
  const sizeOf = limits.sizeOf ?? (() => 1);
  const maxSize = limits.maxSize ?? Number.POSITIVE_INFINITY;
  let size = items.reduce((sum, item) => sum + sizeOf(item), 0);
  return {
    push: (item: T) => {
      items.push(item);
      size += sizeOf(item);
      while (items.length > 0 && (items.length > limits.maxItems || size > maxSize))
        size -= sizeOf(items.shift()!);
    },
  };
};

/** `text + more`, keeping its last `maxChars`, without first building a string longer than both. */
export const appendTail = (text: string, more: string, maxChars: number): string =>
  more.length >= maxChars ? more.slice(-maxChars) : (text + more).slice(-maxChars);

/**
 * Which of `items` to drop, oldest first by `olderFirst`, so that what is left holds at most
 * `maxItems` and at most `maxSize` by `sizeOf`. A `pinned` item is never dropped but still counts,
 * so when the pinned ones alone are over a cap, everything else goes and the cap stays exceeded.
 */
export const dropOldest = <T>(
  items: ReadonlyArray<T>,
  rule: {
    readonly olderFirst: (a: T, b: T) => number;
    readonly maxItems?: number;
    readonly maxSize?: number;
    readonly sizeOf?: (item: T) => number;
    readonly pinned?: (item: T) => boolean;
  },
): Array<T> => {
  const sizeOf = rule.sizeOf ?? (() => 0);
  const maxItems = rule.maxItems ?? Number.POSITIVE_INFINITY;
  const maxSize = rule.maxSize ?? Number.POSITIVE_INFINITY;
  let count = items.length;
  let size = items.reduce((sum, item) => sum + sizeOf(item), 0);
  const drop: Array<T> = [];
  for (const item of items.filter((each) => !rule.pinned?.(each)).toSorted(rule.olderFirst)) {
    if (count <= maxItems && size <= maxSize) break;
    drop.push(item);
    count -= 1;
    size -= sizeOf(item);
  }
  return drop;
};
