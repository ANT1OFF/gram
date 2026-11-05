import type { DocId, WorkspaceId } from "@gram/contracts";
import { create } from "zustand";

import { useLayoutStore } from "@/stores/layout";

interface DocPaneState {
  /** The doc the Docs tab shows for each workspace; absent shows the list. */
  readonly open: Readonly<Partial<Record<WorkspaceId, DocId>>>;
  setOpen(workspaceId: WorkspaceId, id: DocId | undefined): void;
}

/** Which doc the Docs tab has open, per workspace, for this window only. */
export const useDocPane = create<DocPaneState>()((set) => ({
  open: {},
  setOpen: (workspaceId, id) =>
    set((s) => {
      const { [workspaceId]: _was, ...rest } = s.open;
      return { open: id === undefined ? rest : { ...rest, [workspaceId]: id } };
    }),
}));

/** Opens `id` in the right panel's Docs tab, showing the panel however it fits. */
export function showDoc(workspaceId: WorkspaceId, id: DocId) {
  useDocPane.getState().setOpen(workspaceId, id);
  useLayoutStore.getState().revealPanel("docs");
}

/** Shows the workspace's whole list of docs in the Docs tab: "View all". */
export function showAllDocs(workspaceId: WorkspaceId) {
  useDocPane.getState().setOpen(workspaceId, undefined);
  useLayoutStore.getState().revealPanel("docs");
}
