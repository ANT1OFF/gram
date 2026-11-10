import type { FolderEntry, FolderListing, HostFolderChecked, HostId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useApi } from "@/api/context";
import type { Api } from "@/api/types";

import { folderProblem, type FolderProblem } from "./fs-errors";
import { baseName, splitForCompletion } from "./path";

/** `fs.browse` lists a folder only when its path ends in a separator. */
export const withTrailingSlash = (path: string): string =>
  path === "" || /[\\/]$/.test(path) ? path : `${path}/`;

function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (ms <= 0) return;
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return ms <= 0 ? value : debounced;
}

/**
 * Where folders are listed: this Mac's, or a joined machine's through its host (`hostId`), never
 * this disk for that. Each has its own query key, so the two never share an answer.
 */
const browsing = (api: Api, hostId: HostId | undefined) =>
  hostId === undefined
    ? {
        key: ["fs.browse"] as const,
        browse: (path: string, limit?: number) => api.browse(path, limit),
      }
    : {
        key: ["fs.browseOn", hostId] as const,
        browse: (path: string, limit?: number) => api.browseOn(hostId, path, limit),
      };

/** `browsing` as a hook. */
export function useBrowsing(hostId?: HostId) {
  return browsing(useApi(), hostId);
}

export type FolderStatus =
  | { state: "empty" }
  | { state: "checking" }
  | { state: "valid"; folder: FolderListing }
  | { state: "invalid"; problem: FolderProblem };

/** Whether `path` is a real, readable folder, checked as the user types. */
export function useFolderStatus(path: string, debounceMs = 200): FolderStatus {
  const api = useApi();
  const trimmed = path.trim();
  const debounced = withTrailingSlash(useDebouncedValue(trimmed, debounceMs));
  const query = useQuery({
    queryKey: ["fs.browse", debounced],
    queryFn: () => api.browse(debounced),
    enabled: debounced !== "",
    retry: false,
    staleTime: 5_000,
  });
  if (trimmed === "") return { state: "empty" };
  if (debounced !== withTrailingSlash(trimmed) || query.status === "pending") {
    return { state: "checking" };
  }
  if (query.status === "error") return { state: "invalid", problem: folderProblem(query.error) };
  return { state: "valid", folder: query.data };
}

/**
 * Folders completing `prefix` (`fs.browse` on a path without a trailing separator filters its
 * parent). While a newer prefix in the same folder loads, the previous results are narrowed locally
 * so the list doesn't flicker.
 */
export function useCompletions(
  prefix: string,
  enabled: boolean,
  debounceMs = 120,
  hostId?: HostId,
): readonly FolderEntry[] {
  const { key, browse } = useBrowsing(hostId);
  const debounced = useDebouncedValue(prefix, debounceMs);
  const query = useQuery({
    queryKey: [...key, debounced],
    queryFn: () => browse(debounced),
    enabled: enabled && debounced.trim() !== "",
    retry: false,
    staleTime: 5_000,
    placeholderData: (previous) => previous,
  });
  if (!enabled || prefix.trim() === "" || !query.data) return [];
  const current = splitForCompletion(prefix);
  if (splitForCompletion(debounced).dir !== current.dir) return [];
  const leaf = current.leaf.toLowerCase();
  return query.data.entries.filter((entry) => entry.name.toLowerCase().startsWith(leaf));
}

/** The user's home folder (on `hostId`, else here), from listing `~/`, for showing it as `~`. */
export function useHome(hostId?: HostId): string | undefined {
  const { browse } = useBrowsing(hostId);
  const { data } = useQuery({
    queryKey: hostId === undefined ? ["fs.home"] : ["fs.home", hostId],
    queryFn: async () => (await browse("~/", 1)).path,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  return data;
}

/**
 * Whether a listed folder is itself a git repo. Listings only flag their entries, so this looks the
 * folder up in its parent by name.
 */
export function useIsGitRepo(
  folder: FolderListing | undefined,
  hostId?: HostId,
): boolean | undefined {
  const { key, browse } = useBrowsing(hostId);
  const probe = folder?.parent
    ? `${withTrailingSlash(folder.parent)}${baseName(folder.path)}`
    : undefined;
  const { data } = useQuery({
    queryKey: [...key, probe],
    queryFn: () => browse(probe!),
    enabled: probe !== undefined,
    retry: false,
    staleTime: 5_000,
  });
  return data?.entries.find((entry) => entry.path === folder?.path)?.isGitRepo;
}

export type MachineFolderStatus =
  | { state: "empty" }
  | { state: "checking" }
  | { state: "valid"; folder: HostFolderChecked }
  | { state: "invalid"; problem: FolderProblem };

/**
 * Whether a one-off thread may run in `path` on the joined machine `hostId`, checked there by its
 * host as the user types: the real folder and its branch, or why not.
 */
export function useMachineFolderStatus(
  hostId: HostId | undefined,
  path: string,
  debounceMs = 200,
): MachineFolderStatus {
  const api = useApi();
  const trimmed = path.trim();
  const debounced = useDebouncedValue(trimmed, debounceMs);
  const query = useQuery({
    queryKey: ["fs.checkFolder", hostId, debounced],
    queryFn: () => api.checkFolderOn(hostId!, debounced),
    enabled: hostId !== undefined && debounced !== "",
    retry: false,
    staleTime: 5_000,
  });
  if (hostId === undefined || trimmed === "") return { state: "empty" };
  if (debounced !== trimmed || query.status === "pending") return { state: "checking" };
  if (query.status === "error") return { state: "invalid", problem: folderProblem(query.error) };
  return { state: "valid", folder: query.data };
}
