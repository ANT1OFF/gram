import type { DocId, ThreadId, WorkspaceId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";

import { useApi } from "@/api/context";
import { useThreadsStore } from "@/stores/threads";

/** Every docs query of a workspace sits under this, so `docs.changed` refetches them all. */
export const docsListKey = (workspaceId: WorkspaceId) => ["docs", workspaceId, "list"] as const;
export const docKey = (workspaceId: WorkspaceId, id: DocId) =>
  ["docs", workspaceId, "doc", id] as const;

/** The workspace's docs, newest first; idle without a workspace. */
export function useDocs(workspaceId: WorkspaceId | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: docsListKey(workspaceId ?? ("" as WorkspaceId)),
    queryFn: () => api.listDocs(workspaceId!),
    enabled: workspaceId !== undefined,
    retry: false,
  });
}

export function useDoc(workspaceId: WorkspaceId, id: DocId) {
  const api = useApi();
  return useQuery({
    queryKey: docKey(workspaceId, id),
    queryFn: () => api.readDoc(workspaceId, id),
    retry: false,
  });
}

/** The workspace `threadId` is in, as the sidebar has it. */
export const useThreadWorkspace = (threadId: ThreadId | undefined): WorkspaceId | undefined =>
  useThreadsStore((s) =>
    threadId === undefined ? undefined : s.byId[threadId]?.thread.workspaceId,
  );
