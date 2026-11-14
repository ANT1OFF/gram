import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface ConversationOnlyState {
  /** Transcripts leave out the agent's tool calls and reasoning. */
  readonly on: boolean;
  set(on: boolean): void;
  toggle(): void;
}

/**
 * "Conversation only": every transcript shows what was said and what needs the reader, and none of
 * how the agent got there. One switch for the whole app, kept across launches. Only the view
 * changes: the thread, its trace and its panels hold the same work.
 */
export const useConversationOnly = create<ConversationOnlyState>()(
  persist(
    (set) => ({
      on: false,
      set: (on) => set({ on }),
      toggle: () => set((s) => ({ on: !s.on })),
    }),
    {
      name: "gram.conversationOnly",
      version: 1,
      storage: createJSONStorage(() => globalThis.localStorage),
      partialize: ({ on }) => ({ on }),
    },
  ),
);
