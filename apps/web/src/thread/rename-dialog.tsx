import type { ThreadId } from "@gram/contracts";
import { useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { useThreadsStore } from "@/stores/threads";

import { Dialog, DialogShell } from "./dialog-shell";

export function RenameThreadDialog({
  threadId,
  onClose,
}: {
  threadId: ThreadId;
  onClose: () => void;
}) {
  const api = useApi();
  const current = useThreadsStore((s) => s.byId[threadId]?.thread.title ?? "");
  const [title, setTitle] = useState(current);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const next = title.trim();

  const submit = async () => {
    if (next === "" || pending) return;
    setPending(true);
    try {
      if (next !== current) await api.rename(threadId, next);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setPending(false);
    }
  };

  return (
    <DialogShell testId="rename-dialog" title="Rename thread" onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          aria-label="Thread title"
          // oxlint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
            Cancel
          </Dialog.Close>
          <Button type="submit" size="sm" disabled={next === "" || pending}>
            Rename
          </Button>
        </div>
      </form>
    </DialogShell>
  );
}
