import type { AppUpdateState, UpdateCheck, UpdateProgress } from "@gram/contracts";
import { create } from "zustand";

interface UpdateState {
  progress: UpdateProgress | undefined;
  installingTag: string | undefined;
  latest: UpdateCheck | undefined;
  dismissed: string | undefined;
  native: AppUpdateState | null | undefined;
}

export const useUpdateStore = create<UpdateState>()(() => ({
  progress: undefined,
  installingTag: undefined,
  latest: undefined,
  dismissed: undefined,
  native: undefined,
}));
