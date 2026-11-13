import type { PageId, WorkspaceId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";

import { useApi } from "@/api/context";

/** Every pages query of a workspace sits under this, so `pages.changed` refetches them all. */
export const pagesListKey = (workspaceId: WorkspaceId) => ["pages", workspaceId, "list"] as const;

/** The workspace's pinned pages, newest pin first; idle without a workspace. */
export function usePages(workspaceId: WorkspaceId | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: pagesListKey(workspaceId ?? ("" as WorkspaceId)),
    queryFn: () => api.listPages(workspaceId!),
    enabled: workspaceId !== undefined,
    retry: false,
  });
}

/** Where the shown `version` of `id` loads from: asked again for each version. */
export function usePageAddress(workspaceId: WorkspaceId, id: PageId, version: number | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: ["pages", workspaceId, "open", id, version],
    queryFn: () => api.openPage(workspaceId, id),
    enabled: version !== undefined,
    retry: false,
    staleTime: Infinity,
  });
}
