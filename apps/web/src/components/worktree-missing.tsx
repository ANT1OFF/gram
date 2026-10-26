import type { GitState } from "@gram/contracts";
import { FolderX } from "lucide-react";

import { Hint } from "@/components/hint";
import { cn } from "@/lib/utils";

/** The thread's checkout was deleted outside Gram (`GitState.missing`). */
export const worktreeMissing = (git: GitState | undefined): boolean => git?.missing === true;

/** A row's or header's mark for a thread whose folder is gone; nothing while it is there. */
export function WorktreeMissingChip({
  git,
  testId,
  className,
}: {
  git: GitState | undefined;
  testId: string;
  className?: string;
}) {
  if (!worktreeMissing(git)) return null;
  return (
    <Hint
      label="This thread's folder was deleted outside Gram"
      render={
        <span
          data-testid={testId}
          className={cn("flex shrink-0 items-center gap-0.5 text-warning-text", className)}
        />
      }
    >
      <FolderX aria-hidden className="size-3.5" />
      <span className="sr-only">Folder missing</span>
    </Hint>
  );
}
