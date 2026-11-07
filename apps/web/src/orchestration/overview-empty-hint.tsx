import { useThreadsStore } from "@/stores/threads";

import { useWorkspacesQuery } from "./use-orchestration";

/**
 * A ghost line in the overview while it has nothing to list, no workspace and no thread, so the
 * empty column says what will fill it. Words only: the way in is beside it, the first run's Open or
 * the home page's Open a repository.
 */
export function OverviewEmptyHint() {
  const { workspaces, settled } = useWorkspacesQuery();
  const noThreads = useThreadsStore((s) => Object.keys(s.byId).length === 0);
  if (!settled || workspaces.length > 0 || !noThreads) return null;
  return (
    <p
      data-testid="overview-empty-hint"
      className="flex flex-col gap-0.5 px-2.5 py-1 text-meta text-muted-foreground"
    >
      <span>No workspaces yet</span>
      <span>A repository you open becomes one, listed here.</span>
    </p>
  );
}
