import type { WorkspaceId } from "@gram/contracts";
import { useLocation } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useId, useRef } from "react";
import { create } from "zustand";

import { returnFocusTo, useOpener } from "@/lib/use-return-focus";
import { cn } from "@/lib/utils";
import {
  Dialog,
  OverlayBackdrop,
  OverlayContent,
  SHEET_POPUP,
  SHEET_WIDE,
} from "@/thread/dialog-shell";

import type * as WorkspacePage from "./workspace-page";

let pageLoad: Promise<typeof WorkspacePage> | undefined;

/** The sheet's page and the settings sections in it, loaded after the shell's first paint. */
export const preloadWorkspaceSheet = () => {
  pageLoad ??= import("./workspace-page").catch((error: unknown) => {
    pageLoad = undefined;
    throw error;
  });
  return pageLoad;
};

const WorkspaceSettingsPage = lazy(() =>
  preloadWorkspaceSheet().then((page) => ({ default: page.WorkspaceSettingsPage })),
);

interface WorkspaceSheetState {
  readonly open: boolean;
  readonly workspaceId: WorkspaceId | undefined;
  readonly show: (workspaceId: WorkspaceId) => void;
  readonly close: () => void;
}

export const useWorkspaceSheet = create<WorkspaceSheetState>()((set) => ({
  open: false,
  workspaceId: undefined,
  show: (workspaceId) => set({ open: true, workspaceId }),
  close: () => set({ open: false }),
}));

/** Opens a workspace's settings in the sheet, over whatever is on screen. */
export const openWorkspaceSettings = (workspaceId: WorkspaceId) =>
  useWorkspaceSheet.getState().show(workspaceId);

export const WORKSPACE_SHEET_TEST_ID = "workspace-sheet";

/**
 * A workspace's settings in a sheet from the right, opened from its orchestrator so they're changed
 * where the work is. The same page as Settings → Workspaces → the workspace, saved the same way.
 * Going anywhere else closes it.
 */
export function WorkspaceSheet() {
  const open = useWorkspaceSheet((s) => s.open);
  const workspaceId = useWorkspaceSheet((s) => s.workspaceId);
  const close = useWorkspaceSheet((s) => s.close);
  const opener = useOpener(open);
  const titleId = useId();
  useCloseOnNavigate(open, close);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <Dialog.Portal>
        <OverlayBackdrop />
        <Dialog.Popup
          data-testid={WORKSPACE_SHEET_TEST_ID}
          data-surface="overlay"
          aria-labelledby={titleId}
          finalFocus={returnFocusTo(opener)}
          className={cn(SHEET_POPUP, SHEET_WIDE)}
        >
          <OverlayContent>
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              {workspaceId !== undefined && (
                <Suspense fallback={null}>
                  <WorkspaceSettingsPage
                    workspaceId={workspaceId}
                    sheet={{ titleId, onClose: close }}
                  />
                </Suspense>
              )}
            </div>
          </OverlayContent>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Closes a sheet when the route changes under it, such as Open board from its menu. */
export function useCloseOnNavigate(open: boolean, close: () => void) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const openedAt = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!open) {
      openedAt.current = undefined;
      return;
    }
    if (openedAt.current === undefined) openedAt.current = pathname;
    else if (openedAt.current !== pathname) close();
  }, [open, pathname, close]);
}
