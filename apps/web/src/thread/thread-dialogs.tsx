import type { ThreadId } from "@gram/contracts";
import { useNavigate } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { useShortcut } from "@/keyboard/registry";
import { RemoveWorkspaceDialog } from "@/orchestration/remove-workspace";
import { AddRepoDialog } from "@/orchestration/workspace-repos";
import { focusPaneComposer } from "@/shell/pane-focus";
import { useLayoutStore } from "@/stores/layout";
import { WorktreesDialog } from "@/worktrees/worktrees-dialog";

import { BindPrDialog } from "./bind-pr-dialog";
import { CheckoutPrDialog } from "./checkout-pr-dialog";
import { CloseAllThreadsDialog } from "./close-all-dialog";
import { CloseThreadDialog } from "./close-thread-dialog";
import { Dialog, DialogShell } from "./dialog-shell";
import { ForkDialog } from "./fork-dialog";
import { LabelsDialog } from "./labels-dialog";
import { RenameThreadDialog } from "./rename-dialog";
import { RestartSessionDialog } from "./restart-session-dialog";
import { useThreadDialogs } from "./thread-dialogs-store";

const focusedThread = (): ThreadId | undefined => {
  const { grid } = useLayoutStore.getState();
  return grid.panes[grid.focused] ?? undefined;
};

/**
 * Mount once: the thread-action dialogs, and the shortcuts that act on the focused pane's thread.
 * ⌘W closes the pane (the thread keeps running); ⌥⌘W asks to close the thread itself.
 */
export function ThreadDialogs() {
  const navigate = useNavigate();
  const dialog = useThreadDialogs((s) => s.dialog);
  const error = useThreadDialogs((s) => s.error);
  const open = useThreadDialogs((s) => s.open);
  const dismiss = useThreadDialogs((s) => s.dismiss);
  const clearError = useThreadDialogs((s) => s.clearError);

  useShortcut({
    id: "thread.close",
    keys: "mod+alt+w",
    label: "Close thread…",
    group: "Thread",
    when: () => focusedThread() !== undefined,
    run: () => {
      const threadId = focusedThread();
      if (threadId) open({ kind: "close", threadId });
    },
  });

  useShortcut({
    id: "thread.rename",
    keys: "f2",
    label: "Rename thread…",
    group: "Thread",
    // F2 types nothing, so it works from the composer too.
    allowInInputs: true,
    when: () => focusedThread() !== undefined,
    run: () => {
      const threadId = focusedThread();
      if (threadId) open({ kind: "rename", threadId });
    },
  });

  // The desktop menu owns ⌘W there; this documents it and gives the browser the same behaviour.
  useShortcut({
    id: "pane.close",
    keys: "mod+w",
    label: "Close pane (the thread keeps running)",
    group: "Navigation",
    when: () => !window.gram,
    run: () => {
      const { grid, closePane } = useLayoutStore.getState();
      const othersShown = grid.panes.some((id, index) => id !== null && index !== grid.focused);
      if (othersShown) {
        closePane(grid.focused);
        focusPaneComposer(useLayoutStore.getState().grid.focused, { always: true });
      } else void navigate({ to: "/" });
    },
  });

  return (
    <>
      {dialog?.kind === "rename" && (
        <RenameThreadDialog threadId={dialog.threadId} onClose={dismiss} />
      )}
      {dialog?.kind === "close" && (
        <CloseThreadDialog
          threadId={dialog.threadId}
          onClose={dismiss}
          {...(dialog.preset === undefined ? {} : { preset: dialog.preset })}
        />
      )}
      {dialog?.kind === "closeAll" && <CloseAllThreadsDialog onClose={dismiss} />}
      {dialog?.kind === "labels" && <LabelsDialog onClose={dismiss} />}
      {dialog?.kind === "worktrees" && (
        <WorktreesDialog repoPath={dialog.repoPath} onClose={dismiss} />
      )}
      {dialog?.kind === "bindPr" && <BindPrDialog threadId={dialog.threadId} onClose={dismiss} />}
      {dialog?.kind === "checkoutPr" && (
        <CheckoutPrDialog
          {...(dialog.projectRoot === undefined ? {} : { projectRoot: dialog.projectRoot })}
          {...(dialog.prRef === undefined ? {} : { prRef: dialog.prRef })}
          onClose={dismiss}
        />
      )}
      {dialog?.kind === "fork" && (
        <ForkDialog
          threadId={dialog.threadId}
          notice={dialog.notice}
          open
          onOpenChange={(next) => {
            if (!next) dismiss();
          }}
        />
      )}
      {dialog?.kind === "restartSession" && (
        <RestartSessionDialog threadId={dialog.threadId} onClose={dismiss} />
      )}
      {dialog?.kind === "addRepo" && (
        <AddRepoDialog workspaceId={dialog.workspaceId} onClose={dismiss} />
      )}
      {dialog?.kind === "removeWorkspace" && (
        <RemoveWorkspaceDialog workspaceId={dialog.workspaceId} onClose={dismiss} />
      )}
      {error !== undefined && (
        <DialogShell testId="thread-action-error" title="That didn't work" onClose={clearError}>
          <p role="alert" className="text-sm">
            {error}
          </p>
          <div className="flex justify-end">
            <Dialog.Close render={<Button type="button" size="sm" />}>OK</Dialog.Close>
          </div>
        </DialogShell>
      )}
    </>
  );
}
