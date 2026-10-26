import type { Autonomy } from "@gram/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { TaskTarget, TaskWay } from "./task-model";
import { taskTargetKey } from "./task-model";

interface TaskDraftState {
  /** The target the last task went to, which a later draft starts on when nothing nearer says. */
  readonly last?: TaskTarget | undefined;
  /** The way each target's last task went, by `taskTargetKey`. */
  readonly ways: Readonly<Record<string, TaskWay>>;
  /** The worker model last picked for each target's direct task, by `taskTargetKey`. */
  readonly workers: Readonly<Record<string, string>>;
  /**
   * The level last picked for a workspace a draft makes, which the next one starts at; absent
   * until somebody picks one, so the default stays the server's.
   */
  readonly autonomy?: Autonomy | undefined;
  /** `worker` is the picked model's `workerChoiceKey`, for a task that went to a worker. */
  remember: (target: TaskTarget, way: TaskWay, worker?: string) => void;
  rememberAutonomy: (autonomy: Autonomy) => void;
}

/** What New task remembers between drafts, kept on this machine. */
export const useTaskDraftStore = create<TaskDraftState>()(
  persist(
    (set) => ({
      ways: {},
      workers: {},
      remember: (target, way, worker) =>
        set((s) => {
          const key = taskTargetKey(target);
          return {
            last: target,
            ways: { ...s.ways, [key]: way },
            ...(worker === undefined ? {} : { workers: { ...s.workers, [key]: worker } }),
          };
        }),
      rememberAutonomy: (autonomy) => set({ autonomy }),
    }),
    {
      name: "gram.task-draft",
      storage: createJSONStorage(() => localStorage),
      partialize: ({ last, ways, workers, autonomy }) => ({ last, ways, workers, autonomy }),
    },
  ),
);
