/**
 * Which messages a dream reads. Pure: no store, no clock.
 *
 * A memory version holds one watermark per thread, the last seq it consolidated. A dream reads what
 * is past each, and only its adoption moves them, into the version it makes. A mark is only ever
 * replaced by one read later, so discarding a dream, or adopting an older one after a newer, moves
 * nothing back.
 */
import {
  DREAM_DIGEST_MAX_CHARS,
  type DreamRead,
  type DreamWatermark,
  type ThreadId,
} from "@gram/contracts";
import type { MessageMark } from "../persistence/thread-store.ts";

/** Consolidated messages quoted ahead of the new ones, so the first of them reads in context. */
export const DELTA_CONTEXT_MESSAGES = 2;
/** Marks offered for that quote: some messages render to nothing (a subagent's, an empty one). */
const CONTEXT_CANDIDATES = DELTA_CONTEXT_MESSAGES * 4;

/** What `selectDelta` picked of one thread. */
export interface DeltaSelection {
  /** The messages to read as new, in seq order. */
  readonly read: ReadonlyArray<MessageMark>;
  /** The newest consolidated messages before the first new one, oldest first: the context. */
  readonly before: ReadonlyArray<MessageMark>;
  /** The thread no longer holds the message its mark ended on: it was rewound below it. */
  readonly rewound: boolean;
}

/** Marks up to the first of a turn still running, whose messages are still being written. */
const settled = (marks: ReadonlyArray<MessageMark>): ReadonlyArray<MessageMark> => {
  const open = marks.findIndex((mark) => mark.open);
  return open === -1 ? marks : marks.slice(0, open);
};

/**
 * The messages of one thread past its watermark. With no mark, all of them. A thread rewound below
 * its mark (an edit and resend deletes from a message on, and the seqs are given out again) is told
 * by the message the mark ended on having gone or changed; then what was written after the mark's
 * revision is new. `revs: false` is for an archive, whose kept copy has no revisions: a rewound one
 * is read whole. A turn still running is left for the next dream, whatever the mark.
 */
export const selectDelta = (
  marks: ReadonlyArray<MessageMark>,
  mark: DreamWatermark | undefined,
  options: { readonly revs: boolean } = { revs: true },
): DeltaSelection => {
  const usable = settled(marks);
  if (mark === undefined || mark.throughSeq <= 0) {
    return { read: usable, before: [], rewound: false };
  }
  const at = marks.find((each) => each.seq === mark.throughSeq);
  const intact = at !== undefined && (mark.throughId === undefined || at.id === mark.throughId);
  const throughRev = mark.throughRev;
  const read = intact
    ? usable.filter((each) => each.seq > mark.throughSeq)
    : options.revs && throughRev !== undefined
      ? usable.filter((each) => each.seq > mark.throughSeq || each.rev > throughRev)
      : usable;
  const first = read[0]?.seq ?? Number.POSITIVE_INFINITY;
  return {
    read,
    before: usable.filter((each) => each.seq < first).slice(-CONTEXT_CANDIDATES),
    rewound: !intact,
  };
};

/**
 * How many of `blocks`, the new messages that render, fit `maxChars`, oldest first and at least one,
 * and the mark the read ends on: the last selected before the first block left out, so a message
 * that renders to nothing is not read again, and none past the cut is skipped.
 */
export const takeOldest = (
  blocks: ReadonlyArray<{ readonly seq: number; readonly body: string }>,
  read: ReadonlyArray<MessageMark>,
  maxChars: number,
): { readonly count: number; readonly through: MessageMark } => {
  let used = 0;
  let count = 0;
  for (const block of blocks) {
    // The heading and the blank line a block may be written with.
    used += block.body.length + 16;
    if (count > 0 && used > maxChars) break;
    count++;
  }
  const next = blocks[count]?.seq;
  return { count, through: read.findLast((mark) => next === undefined || mark.seq < next)! };
};

/** The newest revision among the marks through `seq`; `undefined` when none has one. */
export const revThrough = (marks: ReadonlyArray<MessageMark>, seq: number): number | undefined => {
  let newest = 0;
  for (const mark of marks) if (mark.seq <= seq && mark.rev > newest) newest = mark.rev;
  return newest === 0 ? undefined : newest;
};

/**
 * The marks an adoption writes: `base`, the adopted version's, with what the dream read laid over
 * it. A thread's mark is taken from the dream unless the one held was read later (`readAt`, the
 * reading dream's start), so adopting an older dream after a newer one moves nothing back. Sorted
 * by thread.
 */
export const foldMarks = (
  base: ReadonlyArray<DreamWatermark>,
  reads: ReadonlyArray<DreamRead>,
  readAt: number,
  digests: ReadonlyMap<ThreadId, string> = new Map(),
): ReadonlyArray<DreamWatermark> => {
  const next = new Map(base.map((mark) => [mark.threadId, mark]));
  for (const read of reads) {
    const held = next.get(read.threadId);
    if (held !== undefined && held.readAt > readAt) continue;
    // A dream that wrote no digest for a thread leaves the one it was given, unless the thread was
    // rewound below its mark: that digest summarises messages the thread no longer holds.
    const digest = digests.get(read.threadId) ?? (read.rewound === true ? undefined : held?.digest);
    next.set(read.threadId, {
      threadId: read.threadId,
      throughSeq: read.throughSeq,
      ...(read.throughId === undefined ? {} : { throughId: read.throughId }),
      ...(read.throughRev === undefined ? {} : { throughRev: read.throughRev }),
      readAt,
      ...(digest === undefined ? {} : { digest }),
    });
  }
  return [...next.values()].toSorted((a, b) => a.threadId.localeCompare(b.threadId));
};

/**
 * A digest as it is kept: scrubbed by the caller, blank lines folded, and cut to `max` at a word,
 * so a dream that wrote too much loses its end and never the cap.
 */
export const capDigest = (text: string, max = DREAM_DIGEST_MAX_CHARS): string | undefined => {
  const folded = text
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (folded === "") return undefined;
  if (folded.length <= max) return folded;
  const cut = folded.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > max / 2 ? cut.slice(0, space) : cut}…`;
};

/** One thread's unread part as the budget weighs it, in the order it is offered. */
export interface BudgetItem {
  /** The new messages that render, oldest first. */
  readonly blocks: ReadonlyArray<{ readonly seq: number; readonly body: string }>;
  /** The characters of a part that can only be read whole: an archive from before anchors. */
  readonly wholeChars?: number | undefined;
  /** What its file holds besides the new messages: the header and the quoted context. */
  readonly overheadChars?: number | undefined;
}

/** What `fillBudget` decided. */
export interface BudgetFill {
  /** The items read, by index, each up to `maxChars` of its new messages (`Infinity`: all). */
  readonly taken: ReadonlyArray<{ readonly index: number; readonly maxChars: number }>;
  /** What of each item was left for the next dream: its new messages past what was taken. */
  readonly left: ReadonlyArray<{
    readonly index: number;
    readonly messages: number;
    readonly tokens: number;
  }>;
}

/** A block's characters as `takeOldest` counts them. */
const sizeOf = (block: { readonly body: string }) => block.body.length + 16;

/**
 * Fills a dream's budget from `items`, offered in order. An item that fits what is left is taken
 * whole. One that would fit a dream of its own waits for the next whole, and the next item is
 * offered: nothing is cut that needn't be. One too big ever to fit (past the budget, or past
 * `fileChars`, what one file holds) is taken oldest-first as far as there is room, so it can't
 * starve. The first item taken may run over, so a dream always reads something. Past `maxFiles`
 * taken, the rest wait.
 */
export const fillBudget = (
  items: ReadonlyArray<BudgetItem>,
  options: {
    readonly budgetTokens: number;
    readonly fileChars: number;
    readonly maxFiles: number;
  },
): BudgetFill => {
  const taken: Array<{ index: number; maxChars: number }> = [];
  const left: Array<{ index: number; messages: number; tokens: number }> = [];
  const budget = options.budgetTokens * 4;
  let remaining = budget;
  for (const [index, item] of items.entries()) {
    const sizes = item.wholeChars === undefined ? item.blocks.map(sizeOf) : [item.wholeChars];
    const leave = (from: number) => {
      const chars = sizes.slice(from).reduce((sum, size) => sum + size, 0);
      left.push({
        index,
        messages: item.wholeChars === undefined ? sizes.length - from : 0,
        tokens: Math.ceil(chars / 4),
      });
    };
    if (taken.length >= options.maxFiles) {
      leave(0);
      continue;
    }
    // A file's header and context count against the budget as much as its messages, but not
    // against `fileChars`, which `DELTA_MAX_CHARS` already leaves them room under.
    const overhead = item.overheadChars ?? 0;
    const full = sizes.reduce((sum, size) => sum + size, 0);
    const room = Math.min(remaining - overhead, options.fileChars);
    if (full <= room || (taken.length === 0 && item.wholeChars !== undefined)) {
      taken.push({ index, maxChars: Number.POSITIVE_INFINITY });
      remaining -= full + overhead;
      continue;
    }
    if (item.wholeChars !== undefined || full <= Math.min(budget - overhead, options.fileChars)) {
      leave(0);
      continue;
    }
    let used = 0;
    let count = 0;
    for (const size of sizes) {
      if (used + size > room) break;
      used += size;
      count++;
    }
    if (count === 0 && taken.length === 0) {
      count = 1;
      used = sizes[0]!;
    }
    if (count === 0) {
      leave(0);
      continue;
    }
    taken.push({ index, maxChars: used });
    remaining -= used + overhead;
    leave(count);
  }
  return { taken, left };
};
