import type { ThreadId, WorkspaceId } from "@gram/contracts";
import { create } from "zustand";

/** What the close dialog starts with ticked, e.g. cleaning up after a merged PR. */
export interface ClosePreset {
  removeWorktree: boolean;
  deleteBranch: boolean;
}

type ThreadDialog =
  | { kind: "rename"; threadId: ThreadId }
  | { kind: "close"; threadId: ThreadId; preset?: ClosePreset }
  | { kind: "closeAll" }
  | { kind: "labels" }
  | { kind: "worktrees"; repoPath: string }
  | { kind: "bindPr"; threadId: ThreadId }
  | { kind: "checkoutPr"; projectRoot?: string; prRef?: string }
  | { kind: "fork"; threadId: ThreadId; notice?: string }
  /** Only when the restart would cut a turn or background work off; at rest it just runs. */
  | { kind: "restartSession"; threadId: ThreadId }
  /** Without a workspace, the repository added opens on New thread. */
  | { kind: "addRepo"; workspaceId?: WorkspaceId }
  | { kind: "removeWorkspace"; workspaceId: WorkspaceId };

interface ThreadDialogsState {
  dialog: ThreadDialog | undefined;
  /** A failed one-click action (pin, park, label, inline rename), shown until dismissed. */
  error: string | undefined;
  open: (dialog: ThreadDialog) => void;
  dismiss: () => void;
  fail: (message: string) => void;
  clearError: () => void;
}

/** The one thread-action dialog on screen; menus, the palette and shortcuts open it by kind. */
export const useThreadDialogs = create<ThreadDialogsState>()((set) => ({
  dialog: undefined,
  error: undefined,
  open: (dialog) => set({ dialog }),
  dismiss: () => set({ dialog: undefined }),
  fail: (error) => set({ error }),
  clearError: () => set({ error: undefined }),
}));
