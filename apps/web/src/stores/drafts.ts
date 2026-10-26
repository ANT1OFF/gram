import type { MessageId, ThreadId } from "@gram/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** An "Edit from here" in progress: sending rewinds to `messageId` first. */
interface EditTarget {
  messageId: MessageId;
  /** Also restore the working tree on rewind. */
  files: boolean;
}

interface DraftState {
  /** Composer text per thread, kept while switching threads. */
  text: Readonly<Record<string, string>>;
  edits: Readonly<Record<string, EditTarget>>;
  setText(threadId: ThreadId, text: string): void;
  /** Pre-fills the composer with an earlier message and marks the rewind target. */
  startEdit(threadId: ThreadId, text: string, target: EditTarget): void;
  cancelEdit(threadId: ThreadId): void;
}

/** Only the strings of a stored `text`: anything else in the window's storage is dropped. */
const storedText = (persisted: unknown): Record<string, string> => {
  const text = (persisted as { text?: unknown } | undefined)?.text;
  if (typeof text !== "object" || text === null) return {};
  return Object.fromEntries(
    Object.entries(text).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
};

/**
 * The text outlives a reload of the window in session storage, so a message waiting for the
 * connection stays in the composer.
 */
export const useDraftStore = create<DraftState>()(
  persist(
    (set) => ({
      text: {},
      edits: {},
      setText: (threadId, text) => set((s) => ({ text: { ...s.text, [threadId]: text } })),
      startEdit: (threadId, text, target) =>
        set((s) => ({
          text: { ...s.text, [threadId]: text },
          edits: { ...s.edits, [threadId]: target },
        })),
      cancelEdit: (threadId) =>
        set((s) => {
          const { [threadId]: _cancelled, ...edits } = s.edits;
          return { edits };
        }),
    }),
    {
      name: "gram.drafts",
      version: 1,
      storage: createJSONStorage(() => globalThis.sessionStorage),
      partialize: ({ text }) => ({ text }),
      merge: (persisted, current) => ({ ...current, text: storedText(persisted) }),
    },
  ),
);
