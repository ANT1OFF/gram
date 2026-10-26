import type { ThreadId } from "@gram/contracts";
import { GitBranch } from "lucide-react";

import { useThreadsStore } from "@/stores/threads";

const baseName = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() ?? path;

/** Shown while the thread follows the agent into another worktree; the panels below show that folder. */
export function WorktreeBanner({ threadId }: { threadId: ThreadId }) {
  const thread = useThreadsStore((s) => s.byId[threadId]?.thread);
  const current = thread?.currentCheckout;
  if (thread === undefined || current === undefined) return null;
  return (
    <div
      data-testid="worktree-banner"
      className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1.5 text-xs text-muted-foreground"
    >
      <GitBranch aria-hidden className="size-3 shrink-0" />
      <span className="min-w-0 truncate">
        Working in worktree{" "}
        <code className="font-mono text-foreground" title={current.path}>
          {baseName(current.path)}
        </code>
        {current.branch && <> on {current.branch}</>} · started in{" "}
        <code className="font-mono" title={thread.checkout.path}>
          {baseName(thread.checkout.path)}
        </code>
      </span>
    </div>
  );
}
