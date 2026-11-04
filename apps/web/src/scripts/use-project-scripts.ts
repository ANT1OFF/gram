import type { ProjectId, ProjectScript, ProjectScripts, ThreadId } from "@gram/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import type { Api } from "@/api/types";
import { openThreadPanel } from "@/components/git-badges";
import { runScript, terminalProblem } from "@/panels/terminal/terminals-store";
import { useThreadsStore } from "@/stores/threads";

export const projectScriptsKey = (projectId: ProjectId | undefined) =>
  ["projectScripts", projectId] as const;

/**
 * The project's saved scripts and suggestions, read again by each view that shows them as it opens
 * (and the menu as it opens), so a hand edit of the file shows without a reload.
 */
export function useProjectScripts(projectId: ProjectId | undefined, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: projectScriptsKey(projectId),
    queryFn: () => api.projectScripts(projectId!),
    enabled: projectId !== undefined && enabled,
    staleTime: 5_000,
    refetchOnMount: "always",
  });
}

/** Saves the project's scripts and puts what the server read back in the cache. */
export function useSaveProjectScripts(projectId: ProjectId) {
  const api = useApi();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (scripts: readonly ProjectScript[]) => api.saveProjectScripts(projectId, scripts),
    onSuccess: (saved: ProjectScripts) =>
      queryClient.setQueryData(projectScriptsKey(projectId), saved),
  });
  return {
    save: mutation.mutateAsync,
    saving: mutation.isPending,
    error: mutation.error === null ? undefined : errorMessage(mutation.error),
    reset: mutation.reset,
  };
}

/** The project a thread works in. */
export const useThreadProject = (threadId: ThreadId | undefined): ProjectId | undefined =>
  useThreadsStore((s) => (threadId === undefined ? undefined : s.byId[threadId]?.thread.projectId));

/**
 * Runs `name` for the thread: the terminal panel opens on the script's tab, which a re-run reuses.
 * Only a click or the script's own key calls this.
 */
export function startScript(api: Api, threadId: ThreadId, name: string): void {
  // The run is asked for before the panel shows, so the panel adopts its tab instead of opening a
  // blank shell beside it.
  const running = runScript(api, threadId, name);
  openThreadPanel(threadId, "terminal");
  running.catch((error: unknown) =>
    useThreadsStore.getState().applyEvent({
      type: "notify",
      kind: "error",
      title: `Couldn't run ${name}`,
      body: terminalProblem(error),
    }),
  );
}
