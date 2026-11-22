import type { DocId } from "./docs.ts";
import { MAX_HIDDEN_DOCS, type Thread } from "./domain.ts";

/**
 * `thread` with `docId`'s composer chip put away, last in `hiddenDocs`; past `MAX_HIDDEN_DOCS` the
 * oldest is forgotten. Hiding a doc already hidden leaves the thread as it is.
 */
export const hideDoc = (thread: Thread, docId: DocId): Thread => {
  const hidden = thread.hiddenDocs ?? [];
  if (hidden.includes(docId)) return thread;
  return { ...thread, hiddenDocs: [...hidden, docId].slice(-MAX_HIDDEN_DOCS) };
};

/** Whether the user put `docId`'s composer chip away in `thread`. */
export const docHidden = (
  thread: Pick<Thread, "hiddenDocs"> | undefined,
  docId: DocId | undefined,
): boolean => docId !== undefined && (thread?.hiddenDocs?.includes(docId) ?? false);
