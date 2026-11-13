import type { DocId, ThreadId } from "@gram/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface DismissedDoc {
  readonly threadId: string;
  readonly docId: string;
  readonly revision: number;
}

interface DocChipState {
  readonly dismissed: readonly DismissedDoc[];
  dismiss(threadId: ThreadId, docId: DocId, revision: number): void;
}

const sanitize = (raw: unknown): DismissedDoc[] =>
  Array.isArray(raw)
    ? raw.filter(
        (entry): entry is DismissedDoc =>
          entry !== null &&
          typeof entry === "object" &&
          typeof entry.threadId === "string" &&
          typeof entry.docId === "string" &&
          Number.isSafeInteger(entry.revision) &&
          entry.revision > 0,
      )
    : [];

/**
 * Dismissed composer chips, per thread and document, kept on this machine across reloads.
 * Only the revision the user saw (and older ones) stays hidden: a later save brings the chip back.
 * Titles, contents and the transcript's document cards are left alone.
 */
export const useDocChipStore = create<DocChipState>()(
  persist(
    (set) => ({
      dismissed: [],
      dismiss: (threadId, docId, revision) =>
        set((s) => ({
          dismissed: [
            ...s.dismissed.filter((entry) => entry.threadId !== threadId || entry.docId !== docId),
            { threadId, docId, revision },
          ],
        })),
    }),
    {
      name: "gram.docChips",
      version: 1,
      storage: createJSONStorage(() => window.localStorage),
      partialize: ({ dismissed }) => ({ dismissed }),
      merge: (persisted, current) => ({
        ...current,
        dismissed: sanitize((persisted as { dismissed?: unknown } | undefined)?.dismissed),
      }),
    },
  ),
);
