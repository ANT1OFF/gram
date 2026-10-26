import type { ThreadId } from "@gram/contracts";
import { useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { bindPrFromInput } from "@/panels/review/pr-bind";
import { useThreadsStore } from "@/stores/threads";

import { Dialog, DialogShell } from "./dialog-shell";

/**
 * "Bind PR…" from the row menu or ⌘K: the PR panel's bind field, as a dialog. A thread that already
 * has a PR follows the new one beside it instead of replacing it.
 */
export function BindPrDialog({ threadId, onClose }: { threadId: ThreadId; onClose: () => void }) {
  const api = useApi();
  const title = useThreadsStore((s) => s.byId[threadId]?.thread.title ?? "");
  const origin = useThreadsStore((s) => s.byId[threadId]?.git?.origin);
  const primary = useThreadsStore((s) => s.byId[threadId]?.thread.boundPr?.number);
  const extra = primary !== undefined;
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = async () => {
    if (value.trim() === "" || pending) return;
    setPending(true);
    setError(undefined);
    try {
      await bindPrFromInput(api, threadId, value, origin, extra);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setPending(false);
    }
  };

  return (
    <DialogShell
      testId="bind-pr-dialog"
      title={extra ? "Follow another PR" : "Bind a PR"}
      description={
        extra
          ? `“${title}” shows it above the composer and can watch its CI. The PR panel stays on #${primary}.`
          : `The PR panel, badge and babysit follow this PR for “${title}”.`
      }
      onClose={onClose}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          aria-label="Pull request number or URL"
          // oxlint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          placeholder={origin ? "#12 or a PR URL" : "https://github.com/owner/repo/pull/12"}
          value={value}
          onChange={(event) => setValue(event.target.value)}
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
          <Button type="submit" size="sm" disabled={pending || value.trim() === ""}>
            {extra ? "Follow" : "Bind"}
          </Button>
        </div>
      </form>
    </DialogShell>
  );
}
