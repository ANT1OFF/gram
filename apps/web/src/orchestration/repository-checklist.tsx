import type { Project, ProjectId, RepositoryCandidate } from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderGit2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";

/**
 * The rows a workspace's repository list shows: each candidate once, and before them a picked
 * project the candidates leave out (a plain folder an older workspace was given), so it can be
 * unticked.
 */
export const checklistRows = (
  candidates: readonly RepositoryCandidate[],
  projects: readonly Project[],
  picked: readonly ProjectId[],
): RepositoryCandidate[] => {
  // Registration updates the projects cache before repository discovery refreshes. Reconcile
  // that newly known identity by root, so the stale folder stays one selected, removable row.
  const registered = new Map(projects.map((project) => [project.root, project]));
  const reconciled = candidates.map((candidate) => {
    const project = registered.get(candidate.root);
    return project === undefined ? candidate : { ...candidate, projectId: project.id };
  });
  const listed = new Set(reconciled.flatMap((each) => each.projectId ?? []));
  const extra = projects
    .filter((project) => picked.includes(project.id) && !listed.has(project.id))
    .map((project) => ({ name: project.name, root: project.root, projectId: project.id }));
  return [...extra, ...reconciled];
};

/**
 * A workspace's repositories as checkboxes: the known ones, then every repository found directly in
 * the default folder and the clone folder. Ticking one Gram doesn't know yet adds it first.
 */
export function RepositoryChecklist({
  projects,
  picked,
  onToggle,
  onPendingChange,
  testId,
  autofocus = false,
  className,
  empty,
}: {
  projects: readonly Project[];
  picked: readonly ProjectId[];
  onToggle: (projectId: ProjectId, included: boolean) => void;
  onPendingChange?: ((pending: boolean) => void) | undefined;
  testId?: string | undefined;
  /** Whether the first box takes the step's focus. */
  autofocus?: boolean;
  className?: string | undefined;
  /** Shown when there is nothing to list. */
  empty: ReactNode;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  // Under `projects` so whatever refreshes the projects (an add, a clone, a workspace) does this too.
  const { data } = useQuery({
    queryKey: ["projects", "repositories"],
    queryFn: () => api.listRepositories(),
  });
  const [adding, setAdding] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => onPendingChange?.(adding !== undefined), [adding, onPendingChange]);

  const rows = checklistRows(data?.repos ?? [], projects, picked);

  const add = (root: string) => {
    if (adding !== undefined) return;
    setAdding(root);
    setError(undefined);
    api
      .addProject(root)
      .then(async (project) => {
        await queryClient.invalidateQueries({ queryKey: ["projects"] });
        onToggle(project.id, true);
      })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setAdding(undefined));
  };

  if (data === undefined) return null;
  if (rows.length === 0) return empty;
  return (
    <>
      <ul data-testid={testId} className={className}>
        {rows.map((repo, i) => (
          <li key={repo.projectId ?? repo.root}>
            <label className="flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-accent/30">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                {...(autofocus && i === 0 ? { "data-autofocus": true } : {})}
                checked={repo.projectId !== undefined && picked.includes(repo.projectId)}
                disabled={adding === repo.root}
                onChange={(event) => {
                  const included = event.target.checked;
                  if (repo.projectId !== undefined) onToggle(repo.projectId, included);
                  else if (included) add(repo.root);
                }}
              />
              <FolderGit2 aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span>{repo.name}</span>
              <span className="truncate font-mono text-xs text-muted-foreground">{repo.root}</span>
            </label>
          </li>
        ))}
      </ul>
      {error !== undefined && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </>
  );
}
