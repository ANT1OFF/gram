import type { Autonomy } from "@gram/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { NewEntry } from "./new-entry";
import type { TaskTarget } from "./task-model";
import { taskTargetKey } from "./task-model";

interface TaskDraftState {
  /** The target the last task went to, which a later draft starts on when nothing nearer says. */
  readonly last?: TaskTarget | undefined;
  /** What the sidebar's New menu was last used for, which it highlights when it opens. */
  readonly entry?: NewEntry | undefined;
  /** The worker model last picked for each target's direct task, by `taskTargetKey`. */
  readonly workers: Readonly<Record<string, string>>;
  /**
   * The level last picked for a workspace a draft makes, which the next one starts at; absent
   * until somebody picks one, so the default stays the server's.
   */
  readonly autonomy?: Autonomy | undefined;
  /** `worker` is the picked model's `workerChoiceKey`, for a task that went to a worker. */
  remember: (target: TaskTarget, worker?: string) => void;
  rememberAutonomy: (autonomy: Autonomy) => void;
  rememberEntry: (entry: NewEntry) => void;
}

/** What New task remembers between drafts, kept on this machine. */
export const useTaskDraftStore = create<TaskDraftState>()(
  persist(
    (set) => ({
      workers: {},
      remember: (target, worker) =>
        set((s) => ({
          last: target,
          ...(worker === undefined
            ? {}
            : { workers: { ...s.workers, [taskTargetKey(target)]: worker } }),
        })),
      rememberAutonomy: (autonomy) => set({ autonomy }),
      rememberEntry: (entry) => set({ entry }),
    }),
    {
      name: "gram.task-draft",
      storage: createJSONStorage(() => localStorage),
      partialize: ({ last, entry, workers, autonomy }) => ({ last, entry, workers, autonomy }),
    },
  ),
);
