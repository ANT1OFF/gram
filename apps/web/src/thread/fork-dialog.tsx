import { Dialog } from "@base-ui/react/dialog";
import type { MessageId, ThreadId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useApi } from "@/api/context";
import { Button } from "@/components/ui/button";
import {
  initialWorktreeChoice,
  worktreeCheckout,
  WorktreeFields,
} from "@/composer/worktree-fields";
import { useThreadsStore } from "@/stores/threads";

import { useForkThread } from "./use-fork";

/** "Fork into worktree…": the fork gets its own new worktree and branch. */
export function ForkDialog({
  threadId,
  fromMessageId,
  notice,
  open,
  onOpenChange,
}: {
  threadId: ThreadId;
  /** Fork after this message; the latest when absent. */
  fromMessageId?: MessageId | undefined;
  /** Why a worktree is needed, e.g. after a fork into the source checkout was refused. */
  notice?: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const api = useApi();
  const thread = useThreadsStore((s) => s.byId[threadId]?.thread);
  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
    enabled: open,
  });
  const project = projects.find((p) => p.id === thread?.projectId);
  const repoPath = project?.repoRoot ?? project?.root ?? "";
  const [worktree, setWorktree] = useState(initialWorktreeChoice);
  const [title, setTitle] = useState("");
  const { fork, pending, error } = useForkThread(threadId);
  const valid = worktree.name.trim() !== "";

  const submit = async () => {
    if (!valid || pending) return;
    const result = await fork({
      ...(fromMessageId ? { fromMessageId } : {}),
      checkout: worktreeCheckout(worktree),
      ...(title.trim() ? { title: title.trim() } : {}),
    });
    if (result === "opened") onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim transition-opacity duration-(--dur-fast) data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          data-testid="fork-dialog"
          className="fixed top-[20%] left-1/2 z-50 flex w-[min(34rem,90vw)] -translate-x-1/2 flex-col gap-4 rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-lg transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
        >
          <Dialog.Title className="font-heading text-base font-medium">
            Fork into worktree
          </Dialog.Title>
          <Dialog.Description className="text-xs text-muted-foreground">
            {fromMessageId
              ? "The new thread gets the conversation up to this reply, in a new worktree."
              : "The new thread gets the whole conversation, in a new worktree."}
          </Dialog.Description>
          {notice && (
            <p
              role="status"
              className="rounded-md border border-status-needs/40 bg-status-needs/10 px-2 py-1.5 text-xs"
            >
              {notice}
            </p>
          )}
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <WorktreeFields repoPath={repoPath} value={worktree} onChange={setWorktree} />
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Title (optional)</span>
              <input
                aria-label="Fork title"
                placeholder={thread ? `Fork of ${thread.title}` : "Title"}
                className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
                Cancel
              </Dialog.Close>
              <Button type="submit" size="sm" disabled={!valid || pending}>
                Fork
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
