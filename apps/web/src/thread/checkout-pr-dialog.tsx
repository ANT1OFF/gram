import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { parsePrRef } from "@/panels/review/pr-ref";
import { useOpenThread } from "@/shell/thread-switcher";

import { Dialog, DialogShell } from "./dialog-shell";

const fieldCls =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * "Check out PR…" from ⌘K or a review request: a new worktree on the PR's head branch, a thread in it
 * that follows the PR. `projectRoot` preselects the project, else the most recent one; `prRef` fills
 * in the PR.
 */
export function CheckoutPrDialog({
  projectRoot,
  prRef,
  onClose,
}: {
  projectRoot?: string;
  prRef?: string;
  onClose: () => void;
}) {
  const api = useApi();
  const openThread = useOpenThread();
  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
  const [root, setRoot] = useState(projectRoot);
  const [value, setValue] = useState(prRef ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const selected = root ?? projects[0]?.root;
  const ref = parsePrRef(value);

  const submit = async () => {
    if (!ref || selected === undefined || pending) return;
    setPending(true);
    setError(undefined);
    try {
      const thread = await api.prCheckout(selected, ref.number, ref.repo);
      onClose();
      openThread(thread.id);
    } catch (e) {
      setError(errorMessage(e));
      setPending(false);
    }
  };

  return (
    <DialogShell
      testId="checkout-pr-dialog"
      title="Check out a PR"
      description="Creates a worktree on the PR's branch and opens a thread that follows the PR."
      onClose={onClose}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <select
          aria-label="Project"
          className={fieldCls}
          value={selected ?? ""}
          disabled={projects.length === 0}
          onChange={(event) => setRoot(event.target.value)}
        >
          {projects.length === 0 && <option value="">No projects yet</option>}
          {projects.map((project) => (
            <option key={project.id} value={project.root}>
              {project.name}
            </option>
          ))}
        </select>
        <input
          aria-label="Pull request number or URL"
          // oxlint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          className={cn(fieldCls, "font-mono")}
          placeholder="#12, owner/repo#12 or a PR URL"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        {value.trim() !== "" && !ref && (
          <p className="text-xs text-muted-foreground">
            Type a number like #12, owner/repo#12 or a github.com PR URL
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
            Cancel
          </Dialog.Close>
          <Button type="submit" size="sm" disabled={pending || !ref || selected === undefined}>
            {pending ? "Checking out…" : "Check out"}
          </Button>
        </div>
      </form>
    </DialogShell>
  );
}
