import type { WorkspaceId } from "@gram/contracts";
import { create } from "zustand";

interface FeatureSheetState {
  readonly open: boolean;
  readonly target: { readonly workspaceId: WorkspaceId; readonly feature: string } | undefined;
  readonly returnFocus: boolean;
  readonly editingStage: boolean;
  readonly show: (workspaceId: WorkspaceId, feature: string, editStage?: boolean) => void;
  readonly close: (returnFocus?: boolean) => void;
  readonly editStage: (editing: boolean) => void;
}

export const useFeatureSheet = create<FeatureSheetState>()((set) => ({
  open: false,
  target: undefined,
  returnFocus: true,
  editingStage: false,
  show: (workspaceId, feature, editStage = false) =>
    set({
      open: true,
      target: { workspaceId, feature },
      returnFocus: true,
      editingStage: editStage,
    }),
  close: (returnFocus = true) => set({ open: false, returnFocus }),
  editStage: (editingStage) => set({ editingStage }),
}));

/** Opens a feature's sheet over whatever is on screen; `editStage` with its stage editor open. */
export const openFeatureSheet = (workspaceId: WorkspaceId, feature: string, editStage = false) =>
  useFeatureSheet.getState().show(workspaceId, feature, editStage);
