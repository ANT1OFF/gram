import type { Autonomy, WorkspaceId } from "@gram/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { NewEntry } from "./new-entry";
import type { TaskTarget } from "./task-model";

interface TaskDraftState {
  /** The target the last task went to, which a later draft starts on when nothing nearer says. */
  readonly last?: TaskTarget | undefined;
  /** What the sidebar's New menu was last used for, which it highlights when it opens. */
  readonly entry?: NewEntry | undefined;
  /**
   * The level last picked for a workspace a draft makes, which the next one starts at; absent
   * until somebody picks one, so the default stays the server's.
   */
  readonly autonomy?: Autonomy | undefined;
  /** The workspace an open New task draft is aimed at, which the window shows while it is open. */
  readonly showing?: WorkspaceId | undefined;
  remember: (target: TaskTarget) => void;
  rememberAutonomy: (autonomy: Autonomy) => void;
  rememberEntry: (entry: NewEntry) => void;
  show: (workspaceId: WorkspaceId | undefined) => void;
}

/** What New task remembers between drafts, kept on this machine. */
export const useTaskDraftStore = create<TaskDraftState>()(
  persist(
    (set) => ({
      remember: (target) => set({ last: target }),
      rememberAutonomy: (autonomy) => set({ autonomy }),
      rememberEntry: (entry) => set({ entry }),
      show: (showing) => set({ showing }),
    }),
    {
      name: "gram.task-draft",
      storage: createJSONStorage(() => localStorage),
      partialize: ({ last, entry, autonomy }) => ({ last, entry, autonomy }),
    },
  ),
);
