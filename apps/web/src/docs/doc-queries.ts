import type { DocId, DocMeta, ThreadId, WorkspaceId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";

import { useApi } from "@/api/context";
import { useThreadsStore } from "@/stores/threads";

/** Every docs query of a workspace sits under this, so `docs.changed` refetches them all. */
export const docsListKey = (workspaceId: WorkspaceId | undefined) =>
  ["docs", workspaceId, "list"] as const;
export const docKey = (workspaceId: WorkspaceId, id: DocId) =>
  ["docs", workspaceId, "doc", id] as const;
export const archivedDocsKey = (workspaceId: WorkspaceId) =>
  ["docs", workspaceId, "archived"] as const;

/** Whether every word of `query` is in the doc's title, case ignored, as `read_doc` matches. */
export const matchesDocQuery = (doc: Pick<DocMeta, "title">, query: string): boolean => {
  const title = doc.title.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "")
    .every((word) => title.includes(word));
};

/** The workspace's archived docs, the latest archived first; idle until `enabled`. */
export function useArchivedDocs(workspaceId: WorkspaceId, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: archivedDocsKey(workspaceId),
    queryFn: () => api.listArchivedDocs(workspaceId),
    enabled,
    retry: false,
  });
}

/** The workspace's docs, newest first; idle without a workspace. */
export function useDocs(workspaceId: WorkspaceId | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: docsListKey(workspaceId),
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
