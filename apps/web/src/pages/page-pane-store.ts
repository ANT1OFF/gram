import type { PageId, WorkspaceId } from "@gram/contracts";
import { create } from "zustand";

import { useLayoutStore } from "@/stores/layout";

interface PagePaneState {
  /** The page the Pages tab shows for each workspace; absent shows the list. */
  readonly open: Readonly<Partial<Record<WorkspaceId, PageId>>>;
  setOpen(workspaceId: WorkspaceId, id: PageId | undefined): void;
}

/** Which page the Pages tab has open, per workspace, for this window only. */
export const usePagePane = create<PagePaneState>()((set) => ({
  open: {},
  setOpen: (workspaceId, id) =>
    set((s) => {
      const { [workspaceId]: _was, ...rest } = s.open;
      return { open: id === undefined ? rest : { ...rest, [workspaceId]: id } };
    }),
}));

/** Opens `id` in the right panel's Pages tab, showing the panel however it fits. */
export function showPage(workspaceId: WorkspaceId, id: PageId) {
  usePagePane.getState().setOpen(workspaceId, id);
  useLayoutStore.getState().revealPanel("pages");
}
