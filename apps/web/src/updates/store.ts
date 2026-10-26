import type { AppUpdateState, UpdateCheck, UpdateProgress } from "@gram/contracts";
import { create } from "zustand";

interface UpdateState {
  progress: UpdateProgress | undefined;
  /** An explicit install request awaiting IPC/progress; not a downloaded artifact. */
  installingTag: string | undefined;
  /** The latest check, automatic or from Settings. */
  latest: UpdateCheck | undefined;
  /** The version whose notice was dismissed for this session. */
  dismissed: string | undefined;
  /**
   * Electron's updater on a signed install, as main last reported it: undefined until asked, null
   * where this install has none (Windows' `gh` updater, or no in-app updater at all).
   */
  native: AppUpdateState | null | undefined;
}

export const useUpdateStore = create<UpdateState>()(() => ({
  progress: undefined,
  installingTag: undefined,
  latest: undefined,
  dismissed: undefined,
  native: undefined,
}));
