import { canCreatePr, effectiveCheckout, type ThreadId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { GitPullRequestCreate } from "lucide-react";
import { useState, type FormEvent } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { pushActionOf } from "@/components/push-button";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useThreadsStore } from "@/stores/threads";
import { DialogShell } from "@/thread/dialog-shell";

const labelCls = "text-xs font-medium text-muted-foreground";
const inputCls =
  "w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** `origin/main` as GitHub names it: `main`. */
const branchName = (ref: string) => ref.replace(/^origin\//, "");

// Shared with the `wrap_up` tool, which offers Create PR only when this button would show.
export { canCreatePr };

/** "Create PR" for a branch without one; opens the create-PR dialog. */
export function CreatePrButton({
  threadId,
  className,
}: {
  threadId: ThreadId;
  className?: string;
}) {
  const git = useThreadsStore((s) => s.byId[threadId]?.git);
  const [open, setOpen] = useState(false);
  if (!canCreatePr(git)) return null;
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid="create-pr-button"
        className={className}
        onClick={() => setOpen(true)}
      >
        <GitPullRequestCreate data-icon="inline-start" />
        Create PR
      </Button>
      {open && <CreatePrDialog threadId={threadId} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * Title, description, base and Draft for `gh pr create`, pre-filled from the branch's commits.
 * Pushes first when origin doesn't have the branch's commits.
 */
export function CreatePrDialog({ threadId, onClose }: { threadId: ThreadId; onClose: () => void }) {
  const api = useApi();
  const thread = useThreadsStore((s) => s.byId[threadId]?.thread);
  const git = useThreadsStore((s) => s.byId[threadId]?.git);
  const repoPath = thread === undefined ? "" : effectiveCheckout(thread).path;
  const { data: branchList } = useQuery({
    queryKey: ["branches", repoPath],
    queryFn: () => api.branches(repoPath),
    enabled: repoPath !== "",
  });
  const suggestedBase = branchName(git?.base ?? branchList?.default ?? "main");
  // Undefined until the user picks or types, so the suggestion and pre-fill can still arrive.
  const [pickedBase, setBase] = useState<string>();
  const [editedTitle, setTitle] = useState<string>();
  const [editedBody, setBody] = useState<string>();
  const [draft, setDraft] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const base = pickedBase ?? suggestedBase;

  const prefill = useQuery({
    queryKey: ["pr.draft", threadId, base],
    queryFn: () => api.prDraft(threadId, base),
    retry: false,
  });
  const title = editedTitle ?? prefill.data?.title ?? thread?.title ?? "";
  const body = editedBody ?? prefill.data?.body ?? "";
  const bases = [
    ...new Set(
      [base, ...(branchList?.branches ?? []).map(branchName)].filter((b) => b !== git?.branch),
    ),
  ];
  const needsPush = pushActionOf(git) !== undefined;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || title.trim() === "") return;
    setPending(true);
    setError(undefined);
    try {
      if (needsPush) await api.pushBranch(threadId);
      const created = await api.prCreate({ threadId, title: title.trim(), body, base, draft });
      useThreadsStore.getState().applyEvent({
        type: "notify",
        kind: "info",
        title: `Opened #${created.number}`,
        body: created.url,
      });
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setPending(false);
    }
  };

  return (
    <DialogShell
      testId="create-pr-dialog"
      title="Create pull request"
      description={
        git?.branch === undefined ? undefined : `From ${git.branch} on ${git.origin ?? "origin"}`
      }
      onClose={onClose}
    >
      <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Title</span>
          <input
            aria-label="Title"
            className={cn(inputCls, "h-8")}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Description</span>
          <textarea
            aria-label="Description"
            rows={6}
            className={cn(inputCls, "resize-y py-2")}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        </label>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className={labelCls}>Base branch</span>
            <Select
              value={base}
              items={bases.map((name) => ({ value: name, label: name }))}
              onValueChange={(next) => {
                if (next !== null) setBase(next);
              }}
            >
              <SelectTrigger aria-label="Base branch" className="font-mono text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {bases.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="flex h-8 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft}
              onChange={(event) => setDraft(event.target.checked)}
            />
            Draft
          </label>
        </div>
        {needsPush && (
          <p className="text-xs text-muted-foreground">
            origin doesn't have this branch's latest commits yet, so they're pushed first.
          </p>
        )}
        {error !== undefined && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || title.trim() === ""}>
            {pending ? "Creating…" : needsPush ? "Push and create" : "Create PR"}
          </Button>
        </div>
      </form>
    </DialogShell>
  );
}
