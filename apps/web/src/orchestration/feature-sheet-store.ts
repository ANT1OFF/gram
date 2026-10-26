import type { WorkspaceId } from "@gram/contracts";
import { create } from "zustand";

// Which feature's sheet is open (`feature-sheet.tsx`), apart from the sheet so a feature's card can
// open it without importing it.

interface FeatureSheetState {
  readonly open: boolean;
  /** Kept after closing, so the sheet keeps its content while it slides away. */
  readonly target: { readonly workspaceId: WorkspaceId; readonly feature: string } | undefined;
  /** Whether closing gives focus back to what opened it; not when an action moved it on purpose. */
  readonly returnFocus: boolean;
  /** Whether its stage editor is open: Set stage… or Edit plan… from the feature's menu. */
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
