import type { ThreadId, WorkspaceId } from "@gram/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage, isThreadNotFound } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { forgetClosedThread, useThreadsStore } from "@/stores/threads";
import { useLeaveThread } from "@/thread/close-thread-dialog";
import { Dialog, DialogShell } from "@/thread/dialog-shell";

import {
  removalLines,
  workersText,
  workspaceRemoval,
  type WorkspaceRemoval,
} from "./remove-workspace-model";
import { useWorkspaces } from "./use-orchestration";

const ignore = () => {};

/**
 * Says what removing a workspace does, then does all of it: closes the orchestrator (the server
 * refuses to remove a workspace whose orchestrator is open), its workers if asked, and the workspace.
 */
export function RemoveWorkspaceDialog({
  workspaceId,
  onClose,
}: {
  workspaceId: WorkspaceId;
  onClose: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const inSettings = useLocation({
    select: (location) => location.pathname.startsWith("/settings/"),
  });
  const leave = useLeaveThread();
  const state = useWorkspaces().find((each) => each.workspace.id === workspaceId);
  const byId = useThreadsStore((s) => s.byId);
  const live = useMemo(
    () => (state === undefined ? undefined : workspaceRemoval(state, Object.values(byId))),
    [state, byId],
  );
  // What the dialog said when the user confirmed, which closing the orchestrator would change.
  const [confirmed, setConfirmed] = useState<WorkspaceRemoval>();
  const removal = confirmed ?? live;
  const [closeWorkers, setCloseWorkers] = useState(false);
  const closed = useRef(new Set<ThreadId>());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  if (state === undefined || removal === undefined) return null;
  const { happens, kept } = removalLines(removal, closeWorkers);
  const workers = workersText(removal);

  /** Closes a thread unless an earlier attempt already did, so a retry picks up where one failed. */
  const closeOnce = async (threadId: ThreadId) => {
    // Remembered here as well as read from the store, whose `thread.removed` may not have arrived.
    if (!closed.current.has(threadId) && useThreadsStore.getState().byId[threadId] !== undefined) {
      try {
        await api.closeThread(threadId, {});
      } catch (e) {
        if (!isThreadNotFound(e)) throw e;
      }
    }
    closed.current.add(threadId);
    forgetClosedThread(threadId);
    leave(threadId);
  };

  const submit = async () => {
    // A retry keeps the plan that was confirmed: the orchestrator it closed has cut its workers
    // loose, so the live one would no longer list them.
    setConfirmed(removal);
    setPending(true);
    setError(undefined);
    try {
      // The orchestrator first, so closing a worker wakes nobody.
      if (removal.orchestrator !== undefined) await closeOnce(removal.orchestrator.thread.id);
      for (const pass of removal.passes) await closeOnce(pass.thread.id);
      if (closeWorkers) {
        for (const worker of removal.workers) await closeOnce(worker.thread.id);
      }
      await api.removeWorkspace(workspaceId);
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      // Off a page that showed it: its settings page goes back to the list, a board or memory home.
      if (params.workspaceId === workspaceId) {
        void navigate({ to: inSettings ? "/settings/workspaces" : "/" });
      }
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setPending(false);
    }
  };

  return (
    <DialogShell
      testId="remove-workspace-dialog"
      title={`Remove the workspace “${state.workspace.name}”?`}
      // Closing mid-removal would hide work that carries on regardless, so it waits until done.
      onClose={pending ? ignore : onClose}
    >
      <ul
        data-testid="remove-workspace-happens"
        className="flex list-disc flex-col gap-1 pl-4 text-sm"
      >
        {happens.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <ul
        data-testid="remove-workspace-kept"
        className="flex list-disc flex-col gap-1 pl-4 text-xs text-muted-foreground"
      >
        {kept.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {workers !== undefined && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={closeWorkers}
            onChange={(event) => setCloseWorkers(event.target.checked)}
          />
          <span className="flex flex-col gap-0.5">
            Also close {workers}
            <span className="text-xs text-muted-foreground">
              Worktrees and branches stay on disk either way.
            </span>
          </span>
        </label>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Dialog.Close
          disabled={pending}
          render={<Button type="button" variant="ghost" size="sm" />}
        >
          Cancel
        </Dialog.Close>
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={pending}
          onClick={() => void submit()}
        >
          Remove workspace
        </Button>
      </div>
    </DialogShell>
  );
}
