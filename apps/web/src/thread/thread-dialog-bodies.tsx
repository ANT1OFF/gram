import { MoveWorkspaceDialog } from "@/orchestration/move-workspace";
import { RemoveWorkspaceDialog } from "@/orchestration/remove-workspace";
import { AddRepoDialog } from "@/orchestration/workspace-repos";
import { ProjectScriptsDialog } from "@/scripts/project-scripts-dialog";
import { WorktreesDialog } from "@/worktrees/worktrees-dialog";

import { BindPrDialog } from "./bind-pr-dialog";
import { CheckoutPrDialog } from "./checkout-pr-dialog";
import { CloseAllThreadsDialog } from "./close-all-dialog";
import { CloseThreadDialog } from "./close-thread-dialog";
import { ContinueInDialog } from "./continue-in-dialog";
import { ForkDialog } from "./fork-dialog";
import { LabelsDialog } from "./labels-dialog";
import { RenameThreadDialog } from "./rename-dialog";
import { RestartSessionDialog } from "./restart-session-dialog";
import { SnoozeDialog } from "./snooze-dialog";
import type { ThreadDialog } from "./thread-dialogs-store";

/** The open thread-action dialog, loaded apart from the shell: `ThreadDialogs` mounts it. */
export function ThreadDialogBody({
  dialog,
  dismiss,
}: {
  dialog: ThreadDialog;
  dismiss: () => void;
}) {
  return (
    <>
      {dialog.kind === "rename" && (
        <RenameThreadDialog threadId={dialog.threadId} onClose={dismiss} />
      )}
      {dialog.kind === "snooze" && <SnoozeDialog threadId={dialog.threadId} onClose={dismiss} />}
      {dialog.kind === "close" && (
        <CloseThreadDialog
          threadId={dialog.threadId}
          onClose={dismiss}
          {...(dialog.preset === undefined ? {} : { preset: dialog.preset })}
        />
      )}
      {dialog.kind === "closeAll" && <CloseAllThreadsDialog onClose={dismiss} />}
      {dialog.kind === "labels" && <LabelsDialog onClose={dismiss} />}
      {dialog.kind === "worktrees" && (
        <WorktreesDialog repoPath={dialog.repoPath} onClose={dismiss} />
      )}
      {dialog.kind === "bindPr" && <BindPrDialog threadId={dialog.threadId} onClose={dismiss} />}
      {dialog.kind === "checkoutPr" && (
        <CheckoutPrDialog
          {...(dialog.projectRoot === undefined ? {} : { projectRoot: dialog.projectRoot })}
          {...(dialog.prRef === undefined ? {} : { prRef: dialog.prRef })}
          onClose={dismiss}
        />
      )}
      {dialog.kind === "fork" && (
        <ForkDialog
          threadId={dialog.threadId}
          notice={dialog.notice}
          open
          onOpenChange={(next) => {
            if (!next) dismiss();
          }}
        />
      )}
      {dialog.kind === "restartSession" && (
        <RestartSessionDialog threadId={dialog.threadId} onClose={dismiss} />
      )}
      {dialog.kind === "continueIn" && (
        <ContinueInDialog threadId={dialog.threadId} model={dialog.model} onClose={dismiss} />
      )}
      {dialog.kind === "addRepo" && (
        <AddRepoDialog workspaceId={dialog.workspaceId} onClose={dismiss} />
      )}
      {dialog.kind === "removeWorkspace" && (
        <RemoveWorkspaceDialog workspaceId={dialog.workspaceId} onClose={dismiss} />
      )}
      {dialog.kind === "moveWorkspace" && (
        <MoveWorkspaceDialog workspaceId={dialog.workspaceId} onClose={dismiss} />
      )}
      {dialog.kind === "projectScripts" && (
        <ProjectScriptsDialog projectId={dialog.projectId} onClose={dismiss} />
      )}
    </>
  );
}
