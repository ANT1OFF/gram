import type { ThreadId } from "@gram/contracts";
import { create } from "zustand";

/**
 * A note on a line range of the thread's diff, for the agent. A draft until the message it rides in
 * is sent; nothing here reaches GitHub.
 */
export interface DiffComment {
  id: string;
  /** Relative to the checkout. */
  path: string;
  /** Which file's numbers `start` and `end` are: the new one, or the old one for removed lines only. */
  side: "new" | "old";
  start: number;
  end: number;
  /** The commented lines as they read in the diff, each with its `+`, `-` or space. */
  snippet: string;
  note: string;
}

interface DiffCommentsState {
  byThread: Readonly<Record<string, readonly DiffComment[]>>;
  add(threadId: ThreadId, comment: DiffComment): void;
  setNote(threadId: ThreadId, id: string, note: string): void;
  remove(threadId: ThreadId, id: string): void;
  /** The thread's comments, cleared from the store for the message about to carry them. */
  take(threadId: ThreadId): readonly DiffComment[];
  /** Puts taken comments back, ahead of any added since, when their message didn't go. */
  restore(threadId: ThreadId, comments: readonly DiffComment[]): void;
}

const NONE: readonly DiffComment[] = [];

/** Kept while switching threads, like the composer's text; not across a reload. */
export const useDiffCommentsStore = create<DiffCommentsState>()((set, get) => {
  const update = (threadId: ThreadId, fn: (list: readonly DiffComment[]) => DiffComment[]) =>
    set((s) => ({ byThread: { ...s.byThread, [threadId]: fn(s.byThread[threadId] ?? NONE) } }));
  return {
    byThread: {},
    add: (threadId, comment) => update(threadId, (list) => [...list, comment]),
    setNote: (threadId, id, note) =>
      update(threadId, (list) => list.map((c) => (c.id === id ? { ...c, note } : c))),
    remove: (threadId, id) => update(threadId, (list) => list.filter((c) => c.id !== id)),
    take: (threadId) => {
      const taken = get().byThread[threadId] ?? NONE;
      if (taken.length > 0) update(threadId, () => []);
      return taken;
    },
    restore: (threadId, comments) => {
      if (comments.length > 0) update(threadId, (list) => [...comments, ...list]);
    },
  };
});

/** The thread's draft comments, the same array until they change. */
export const useDiffComments = (threadId: ThreadId): readonly DiffComment[] =>
  useDiffCommentsStore((s) => s.byThread[threadId] ?? NONE);

/** `src/a.ts:12-14`, with `(removed)` when the numbers are the old file's. */
export function commentLabel(comment: DiffComment): string {
  const range =
    comment.start === comment.end ? `${comment.start}` : `${comment.start}-${comment.end}`;
  return `${comment.path}:${range}${comment.side === "old" ? " (removed)" : ""}`;
}

/** A code fence longer than any run of backticks in `text`, so the snippet can't close it early. */
const fenceFor = (text: string) =>
  "`".repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length + 1)));

/**
 * The message the agent gets: each comment as its file and range, the lines as a diff excerpt and
 * the note, then what was typed. Plain text, so every harness reads it the same way.
 */
export function withDiffComments(comments: readonly DiffComment[], typed: string): string {
  if (comments.length === 0) return typed;
  const blocks = comments.map((comment) => {
    const fence = fenceFor(comment.snippet);
    return [
      commentLabel(comment),
      `${fence}diff`,
      comment.snippet,
      fence,
      comment.note.trim(),
    ].join("\n");
  });
  const intro =
    comments.length === 1 ? "A review comment on the diff:" : "Review comments on the diff:";
  return [intro, ...blocks, ...(typed ? [typed] : [])].join("\n\n");
}
