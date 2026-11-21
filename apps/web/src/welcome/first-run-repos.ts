import { useQuery } from "@tanstack/react-query";

import { useApi } from "@/api/context";

import { RECENT_LIMIT } from "./repo-search";

/**
 * The repositories the first run offers, shared by the picker and the session import, and whether
 * they are `listed` yet.
 */
export function useFirstRunRepos() {
  const api = useApi();
  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
  const { data, isPending } = useQuery({
    queryKey: ["projects", "repositories"],
    queryFn: () => api.listRepositories(),
  });
  const all = data?.repos ?? [];
  return { projects, all, repos: all.slice(0, RECENT_LIMIT), listed: !isPending };
}
