import type { ThreadId } from "@gram/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useApi } from "@/api/context";
import { Button } from "@/components/ui/button";
import { EMPTY_GRID, useLayoutStore } from "@/stores/layout";
import { closeThread, useThreadsStore } from "@/stores/threads";

import { Dialog, DialogShell } from "./dialog-shell";

/** Closes every thread after one confirm, one at a time; worktrees stay on disk. */
export function CloseAllThreadsDialog({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const navigate = useNavigate();
  const count = useThreadsStore((s) => Object.keys(s.byId).length);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = async () => {
    setPending(true);
    setError(undefined);
    const ids = Object.keys(useThreadsStore.getState().byId) as ThreadId[];
    let failed = 0;
    for (const id of ids) {
      try {
        await closeThread(api, id);
      } catch {
        failed++;
      }
    }
    useLayoutStore.setState({ grid: EMPTY_GRID });
    void navigate({ to: "/" });
    setPending(false);
    if (failed > 0) setError(`${failed} thread${failed === 1 ? "" : "s"} couldn't be closed.`);
    else onClose();
  };

  return (
    <DialogShell
      testId="close-all-dialog"
      title={
        count === 0 ? "No threads to close" : `Close all ${count} thread${count === 1 ? "" : "s"}?`
      }
      description="Every agent stops and the threads leave the list. Worktrees stay on disk."
      onClose={onClose}
    >
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
          Cancel
        </Dialog.Close>
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={count === 0 || pending}
          onClick={() => void submit()}
        >
          Close all
        </Button>
      </div>
    </DialogShell>
  );
}
