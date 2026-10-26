import type { ThreadId, WorktreeRemoval } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Inbox, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { focusPaneComposer } from "@/shell/pane-focus";
import { useLayoutStore } from "@/stores/layout";
import { closeThread, useThreadsStore } from "@/stores/threads";

import { closeWarning, waitingWarning } from "./close-warning";
import { Dialog, DialogShell } from "./dialog-shell";
import { cleanAndPushed, mergedPrRef } from "./merged-cleanup";
import {
  DirtyAlert,
  PermissionChecklist,
  useSkippedRules,
  worktreeDirtyCount,
} from "./removal-checklist";
import type { ClosePreset } from "./thread-dialogs-store";

/** Empties the panes showing `threadId` and leaves its route. */
export function useLeaveThread() {
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  return (threadId: ThreadId) => {
    const panes = useLayoutStore.getState().grid.panes;
    for (let index = panes.length - 1; index >= 0; index--) {
      if (panes[index] === threadId) useLayoutStore.getState().closePane(index);
    }
    if (params.threadId === threadId) void navigate({ to: "/" });
  };
}

/** Once the closed thread's pane is gone, the pane that took focus gets the caret. */
const focusRemainingPane = (): undefined => {
  focusPaneComposer(useLayoutStore.getState().grid.focused, { always: true });
  return undefined;
};

/** Says what became of the local branch, when deleting it was asked for. */
function reportBranch(result: WorktreeRemoval) {
  const branch = result.branch;
  if (branch === undefined) return;
  useThreadsStore.getState().applyEvent(
    branch.deleted
      ? { type: "notify", kind: "info", title: `Deleted the local branch ${branch.name}` }
      : {
          type: "notify",
          kind: "info",
          title: `Kept the local branch ${branch.name}`,
          ...(branch.reason === undefined ? {} : { body: branch.reason }),
        },
  );
}

/**
 * Close checklist: warn about uncommitted and unmerged work, offer to delete the
 * worktree (and, after a merged PR, its local branch), carry approved permission rules back to the
 * main checkout, and ask again before forcing away a dirty worktree.
 */
export function CloseThreadDialog({
  threadId,
  onClose,
  preset,
}: {
  threadId: ThreadId;
  onClose: () => void;
  /** What starts ticked; a merged-PR cleanup ticks both. */
  preset?: ClosePreset;
}) {
  const api = useApi();
  const leave = useLeaveThread();
  const live = useThreadsStore((s) => s.byId[threadId]);
  const byId = useThreadsStore((s) => s.byId);
  // Ticked when the tree is clean and pushed, so closing tidies up unless the user unticks it.
  const [removeWorktree, setRemoveWorktree] = useState(
    () =>
      preset?.removeWorktree ??
      (live?.thread.checkout.kind === "worktree" &&
        !Object.values(byId).some(
          (other) =>
            other.thread.id !== threadId &&
            other.thread.checkout.path === live.thread.checkout.path,
        ) &&
        cleanAndPushed(live.git)),
  );
  const [deleteBranch, setDeleteBranch] = useState(preset?.deleteBranch ?? false);
  const ruleChoice = useSkippedRules();
  const [dirty, setDirty] = useState<number | undefined>();
  const [pending, setPending] = useState(false);
  const [last, setLast] = useState(live);
  if (live !== undefined && live !== last) setLast(live);
  // Its own close drops the thread before the dialog has closed and handed the caret on; one
  // closed elsewhere while the dialog stands takes it away.
  const summary = live ?? (pending ? last : undefined);
  const [error, setError] = useState<string | undefined>();

  const thread = summary?.thread;
  const shared =
    thread !== undefined &&
    Object.values(byId).some(
      (other) =>
        other.thread.id !== threadId && other.thread.checkout.path === thread.checkout.path,
    );
  const canRemove = thread?.checkout.kind === "worktree" && !shared;
  const branchName = thread?.checkout.kind === "worktree" ? thread.checkout.branch : undefined;
  const merged = mergedPrRef(summary);
  const canDeleteBranch =
    canRemove && removeWorktree && merged !== undefined && branchName !== undefined;
  const rules = useQuery({
    queryKey: ["worktree.pendingPermissions", threadId],
    queryFn: () => api.pendingPermissions(threadId),
    enabled: canRemove && removeWorktree,
    retry: false,
  });

  if (!thread) return null;
  const warning = closeWarning(summary?.git);
  const waiting = waitingWarning(summary?.waits);
  const picked = ruleChoice.picked(rules.data);

  const submit = async (force: boolean) => {
    setPending(true);
    setError(undefined);
    try {
      const result = await closeThread(
        api,
        threadId,
        canRemove && removeWorktree
          ? {
              removeWorktree: {
                force,
                ...(canDeleteBranch && deleteBranch && merged ? { deleteBranch: merged } : {}),
              },
              ...(picked.length > 0 ? { permissionRules: picked } : {}),
            }
          : {},
      );
      reportBranch(result);
      leave(threadId);
      onClose();
    } catch (e) {
      const changed = worktreeDirtyCount(e);
      if (changed === undefined) setError(errorMessage(e));
      else setDirty(changed);
      setPending(false);
    }
  };

  return (
    <DialogShell
      testId="close-thread-dialog"
      title={`Close “${thread.title}”?`}
      description="The agent stops and the thread leaves the list. Its conversation is kept by Claude."
      onClose={onClose}
      returnFocus={focusRemainingPane}
    >
      {warning && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-md border border-status-needs/40 bg-status-needs/10 px-2 py-1.5 text-xs"
        >
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-status-needs" />
          {warning}
        </p>
      )}
      {waiting && (
        <p
          role="status"
          data-testid="close-waiting-warning"
          className="flex items-start gap-2 rounded-md border border-status-needs/40 bg-status-needs/10 px-2 py-1.5 text-xs"
        >
          <Inbox aria-hidden className="mt-0.5 size-3.5 shrink-0 text-status-needs" />
          {waiting}
        </p>
      )}

      {canRemove && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={removeWorktree}
            onChange={(event) => {
              setRemoveWorktree(event.target.checked);
              setDirty(undefined);
            }}
          />
          <span className="flex flex-col gap-0.5">
            Also delete the worktree on disk
            <span className="text-xs text-muted-foreground">
              {!removeWorktree
                ? "The worktree folder stays on disk."
                : canDeleteBranch && deleteBranch
                  ? "The worktree folder will be removed."
                  : "The worktree folder will be removed. The branch and its commits are kept."}
            </span>
          </span>
        </label>
      )}

      {canDeleteBranch && (
        <label className="flex items-start gap-2 pl-5 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={deleteBranch}
            onChange={(event) => setDeleteBranch(event.target.checked)}
          />
          <span className="flex flex-col gap-0.5">
            Also delete the local branch {branchName}
            <span className="text-xs text-muted-foreground">
              #{merged.number} is merged. The branch is deleted only if its tip is still the PR's
              head and nothing else has it checked out; the remote branch is never touched.
            </span>
          </span>
        </label>
      )}

      {canRemove && removeWorktree && (
        <PermissionChecklist
          rules={rules}
          skipped={ruleChoice.skipped}
          onToggle={ruleChoice.toggle}
        />
      )}

      {dirty !== undefined && <DirtyAlert changedFiles={dirty} />}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
          Cancel
        </Dialog.Close>
        {dirty === undefined ? (
          <Button
            type="button"
            size="sm"
            variant={removeWorktree ? "destructive" : "default"}
            disabled={pending || (removeWorktree && rules.status === "pending")}
            onClick={() => void submit(false)}
          >
            {removeWorktree ? "Close and delete worktree" : "Close thread"}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={pending}
            onClick={() => void submit(true)}
          >
            Delete anyway
          </Button>
        )}
      </div>
    </DialogShell>
  );
}
