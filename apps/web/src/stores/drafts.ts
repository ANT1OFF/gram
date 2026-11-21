import type { MessageId, ThreadId } from "@gram/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface EditTarget {
  messageId: MessageId;
  files: boolean;
}

interface DraftState {
  text: Readonly<Record<string, string>>;
  edits: Readonly<Record<string, EditTarget>>;
  setText(threadId: ThreadId, text: string): void;
  startEdit(threadId: ThreadId, text: string, target: EditTarget): void;
  cancelEdit(threadId: ThreadId): void;
}

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
