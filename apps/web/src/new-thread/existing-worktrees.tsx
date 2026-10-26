import type { WorktreeEntry } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { FolderGit2 } from "lucide-react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/lib/time";
import { Shimmer } from "@/motion";

import { baseName } from "./path";

const inputCls =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * The repo's registered worktrees to open a thread in, newest activity first. A worktree another
 * thread already has open is shown but can't be picked; a path can still be typed.
 */
export function ExistingWorktrees({
  repoPath,
  value,
  onChange,
}: {
  repoPath: string;
  value: string;
  onChange: (path: string) => void;
}) {
  const api = useApi();
  const query = useQuery({
    queryKey: ["worktree.list", repoPath],
    queryFn: () => api.listWorktrees(repoPath),
    enabled: repoPath !== "",
    retry: false,
  });
  const worktrees = (query.data?.worktrees ?? [])
    .filter((entry) => !entry.isMain)
    .toSorted((a, b) => b.lastActivity - a.lastActivity);
  const listed = worktrees.some((entry) => entry.path === value);

  return (
    <div className="flex flex-col gap-2">
      {repoPath === "" ? (
        <p className="text-xs text-muted-foreground">Pick a git project to see its worktrees.</p>
      ) : query.status === "pending" ? (
        <p className="text-xs text-muted-foreground">
          <Shimmer>Loading worktrees…</Shimmer>
        </p>
      ) : query.status === "error" ? (
        <p role="alert" className="text-xs text-danger-text">
          {errorMessage(query.error)}
        </p>
      ) : worktrees.length === 0 ? (
        <p className="text-xs text-muted-foreground">This repo has no other worktrees yet.</p>
      ) : (
        <div role="radiogroup" aria-label="Existing worktrees" className="flex flex-col gap-0.5">
          {worktrees.map((entry) => (
            <WorktreeOption
              key={entry.path}
              entry={entry}
              checked={entry.path === value}
              onPick={() => onChange(entry.path)}
            />
          ))}
        </div>
      )}
      <input
        aria-label="Worktree path"
        className={cn(inputCls, listed && "text-muted-foreground")}
        placeholder="Or type a worktree path…"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function WorktreeOption({
  entry,
  checked,
  onPick,
}: {
  entry: WorktreeEntry;
  checked: boolean;
  onPick: () => void;
}) {
  const name = entry.branch ?? baseName(entry.path);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-disabled={entry.isOpen}
      disabled={entry.isOpen}
      title={entry.isOpen ? "A thread is already open in this worktree" : entry.path}
      onClick={onPick}
      className="flex min-w-0 items-center gap-2 rounded-md border border-transparent px-2 py-1 text-left text-sm outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60 disabled:hover:bg-transparent aria-checked:border-ring aria-checked:bg-accent"
    >
      <FolderGit2 aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 font-mono text-xs">{name}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
        {entry.path}
      </span>
      {entry.isOpen ? (
        <span className="shrink-0 text-[11px] text-muted-foreground">open in a thread</span>
      ) : (
        entry.lastActivity > 0 && (
          <time className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {formatRelative(entry.lastActivity)}
          </time>
        )
      )}
    </button>
  );
}
