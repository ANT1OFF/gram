/** A run of a changed line's text, marked where it differs from the line it replaced. */
export interface DiffSpan {
  readonly text: string;
  readonly changed: boolean;
}

/**
 * A line of `after` against `before`: kept, added or removed, with its number on each side it is
 * on. A changed line paired with the one it replaced carries `spans` when words were asked for.
 */
export type DiffLine =
  | {
      readonly kind: "same";
      readonly text: string;
      readonly before: number;
      readonly after: number;
    }
  | {
      readonly kind: "add";
      readonly text: string;
      readonly after: number;
      readonly spans?: readonly DiffSpan[];
    }
  | {
      readonly kind: "del";
      readonly text: string;
      readonly before: number;
      readonly spans?: readonly DiffSpan[];
    };

export interface LineDiffOptions {
  /** Mark the words that differ within a changed line. Off by default. */
  readonly words?: boolean;
  /** Lines on either side past which the texts are not compared. Default 5000. */
  readonly maxLines?: number;
}

/** The default `maxLines`. */
export const DIFF_MAX_LINES = 5000;

const MAX_CELLS = 4_000_000;
const MAX_WORD_CELLS = 40_000;
const MAX_WORD_PAIRS = 1000;

const linesOf = (text: string) => (text === "" ? [] : text.split("\n"));

type Op = "same" | "add" | "del";

function ops<T>(a: readonly T[], b: readonly T[], limit: number): Op[] | undefined {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const out: Op[] = Array.from({ length: head }, () => "same" as const);
  if (midA.length * midB.length > limit) return undefined;
  const width = midB.length + 1;
  const table = new Uint32Array((midA.length + 1) * width);
  for (let i = midA.length - 1; i >= 0; i--)
    for (let j = midB.length - 1; j >= 0; j--)
      table[i * width + j] =
        midA[i] === midB[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
  let i = 0;
  let j = 0;
  while (i < midA.length || j < midB.length) {
    if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
      out.push("same");
      i++;
      j++;
    } else if (
      i < midA.length &&
      (j === midB.length || table[(i + 1) * width + j]! >= table[i * width + j + 1]!)
    ) {
      out.push("del");
      i++;
    } else {
      out.push("add");
      j++;
    }
  }
  for (let k = 0; k < tail; k++) out.push("same");
  return out;
}

const WORD = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

/** The spans of `before` and `after` that differ, word by word; undefined when too long to compare. */
export function wordSpans(
  before: string,
  after: string,
): { before: DiffSpan[]; after: DiffSpan[] } | undefined {
  const a = before.match(WORD) ?? [];
  const b = after.match(WORD) ?? [];
  const steps = ops(a, b, MAX_WORD_CELLS);
  if (steps === undefined) return undefined;
  const left: DiffSpan[] = [];
  const right: DiffSpan[] = [];
  const push = (into: DiffSpan[], text: string, changed: boolean) => {
    const last = into.at(-1);
    if (last?.changed === changed) into[into.length - 1] = { text: last.text + text, changed };
    else into.push({ text, changed });
  };
  let i = 0;
  let j = 0;
  for (const step of steps) {
    if (step === "same") {
      push(left, a[i++]!, false);
      push(right, b[j++]!, false);
    } else if (step === "del") push(left, a[i++]!, true);
    else push(right, b[j++]!, true);
  }
  return { before: left, after: right };
}

/**
 * A line diff of two texts by longest common subsequence, removed lines before the lines that
 * replaced them. Undefined when either text is longer than `maxLines`, so a caller can say it is
 * too large to compare. A change too large to match line by line is drawn as its old lines removed
 * and its new ones added.
 */
export function lineDiff(
  before: string,
  after: string,
  options: LineDiffOptions = {},
): DiffLine[] | undefined {
  const a = linesOf(before);
  const b = linesOf(after);
  const max = options.maxLines ?? DIFF_MAX_LINES;
  if (a.length > max || b.length > max) return undefined;
  const steps = ops(a, b, MAX_CELLS) ?? wholeChange(a, b);
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  for (const step of steps) {
    if (step === "same") {
      lines.push({ kind: "same", text: b[j]!, before: i + 1, after: j + 1 });
      i++;
      j++;
    } else if (step === "del") {
      lines.push({ kind: "del", text: a[i]!, before: i + 1 });
      i++;
    } else {
      lines.push({ kind: "add", text: b[j]!, after: j + 1 });
      j++;
    }
  }
  return options.words ? withWords(lines) : lines;
}

function wholeChange(a: readonly string[], b: readonly string[]): Op[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  return [
    ...Array.from({ length: head }, () => "same" as const),
    ...Array.from({ length: a.length - head - tail }, () => "del" as const),
    ...Array.from({ length: b.length - head - tail }, () => "add" as const),
    ...Array.from({ length: tail }, () => "same" as const),
  ];
}

function withWords(lines: DiffLine[]): DiffLine[] {
  const out = [...lines];
  let pairs = 0;
  let at = 0;
  while (at < out.length && pairs < MAX_WORD_PAIRS) {
    if (out[at]!.kind !== "del") {
      at++;
      continue;
    }
    const delStart = at;
    while (at < out.length && out[at]!.kind === "del") at++;
    const addStart = at;
    while (at < out.length && out[at]!.kind === "add") at++;
    const count = Math.min(addStart - delStart, at - addStart);
    for (let k = 0; k < count && pairs < MAX_WORD_PAIRS; k++, pairs++) {
      const del = out[delStart + k] as Extract<DiffLine, { kind: "del" }>;
      const add = out[addStart + k] as Extract<DiffLine, { kind: "add" }>;
      const spans = wordSpans(del.text, add.text);
      if (spans === undefined) continue;
      out[delStart + k] = { ...del, spans: spans.before };
      out[addStart + k] = { ...add, spans: spans.after };
    }
  }
  return out;
}

/** A run of unchanged lines folded away, `from` its first index in the diff. */
export interface DiffFold {
  readonly kind: "fold";
  readonly from: number;
  readonly count: number;
}

/**
 * The diff with unchanged lines more than `context` away from any change folded into one row, but
 * a run of a single line, which is shown rather than folded.
 */
export function foldUnchanged(
  lines: readonly DiffLine[],
  context: number,
): (DiffLine | DiffFold)[] {
  const near = Array.from({ length: lines.length }, () => false);
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    const end = Math.min(lines.length - 1, index + context);
    for (let k = Math.max(0, index - context); k <= end; k++) near[k] = true;
  });
  const shown: (DiffLine | DiffFold)[] = [];
  let index = 0;
  while (index < lines.length) {
    if (near[index]) {
      shown.push(lines[index]!);
      index++;
      continue;
    }
    const from = index;
    while (index < lines.length && !near[index]) index++;
    if (index - from === 1) shown.push(lines[from]!);
    else shown.push({ kind: "fold", from, count: index - from });
  }
  return shown;
}
