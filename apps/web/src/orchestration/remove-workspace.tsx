import type { ThreadId, WorkspaceId } from "@gram/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage, isThreadNotFound } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  const [confirmed, setConfirmed] = useState<WorkspaceRemoval>();
  const removal = confirmed ?? live;
  const [closeWorkers, setCloseWorkers] = useState(false);
  const closed = useRef(new Set<ThreadId>());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  if (state === undefined || removal === undefined) return null;
  const { happens, kept } = removalLines(removal, closeWorkers);
  const workers = workersText(removal);

  const closeOnce = async (threadId: ThreadId) => {
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
    setConfirmed(removal);
    setPending(true);
    setError(undefined);
    try {
      if (removal.orchestrator !== undefined) await closeOnce(removal.orchestrator.thread.id);
      for (const pass of removal.passes) await closeOnce(pass.thread.id);
      if (closeWorkers) {
        for (const worker of removal.workers) await closeOnce(worker.thread.id);
      }
      await api.removeWorkspace(workspaceId);
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
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
      onClose={pending ? ignore : onClose}
    >
      <ul
        data-testid="remove-workspace-happens"
        className="flex list-disc flex-col gap-1 pl-4 text-reading"
      >
        {happens.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <ul
        data-testid="remove-workspace-kept"
        className="flex list-disc flex-col gap-1 pl-4 text-meta text-muted-foreground"
      >
        {kept.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {workers !== undefined && (
        <Checkbox
          className="text-reading"
          label={<>Also close {workers}</>}
          description="Worktrees and branches stay on disk either way."
          checked={closeWorkers}
          onChange={(event) => setCloseWorkers(event.target.checked)}
        />
      )}
      {error && (
        <p role="alert" className="text-reading text-destructive">
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
