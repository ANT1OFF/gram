// The repositories "Add repository" offers as `owner/repo` is typed: from the embedding app's
// source when it gave one (searched as the person types, a page at a time), else the server's own
// `gh` listing, matched here. Either way they are grouped by owner.
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import type { ShellRepositoryPage } from "@/embed/contract";
import { useEmbedShell } from "@/embed/store";

/** How many of the server's own listing are offered at once. */
const SUGGESTION_LIMIT = 8;
/** How long typing rests before the embedding app's source is asked again. */
const SEARCH_DEBOUNCE_MS = 250;

/** Suggested `owner/repo` names containing `text`, prefix matches first. */
export const matchRepos = (repos: readonly string[], text: string): string[] => {
  const q = text.trim().toLowerCase();
  if (q === "") return repos.slice(0, SUGGESTION_LIMIT);
  const scored = repos.flatMap((repo) => {
    const name = repo.toLowerCase();
    if (name === q) return [];
    const short = name.slice(name.indexOf("/") + 1);
    const score = name.startsWith(q) || short.startsWith(q) ? 0 : name.includes(q) ? 1 : -1;
    return score === -1 ? [] : [{ repo, score }];
  });
  return scored
    .toSorted((a, b) => a.score - b.score)
    .slice(0, SUGGESTION_LIMIT)
    .map((s) => s.repo);
};

export interface RepoGroup {
  readonly owner: string;
  readonly repos: readonly string[];
}

/**
 * `repos` by owner, each owner's in the order given: `account`'s first, then the others by name.
 * Without `account`, owners keep the order they first appear in.
 */
export const groupByOwner = (repos: readonly string[], account?: string): RepoGroup[] => {
  const groups = new Map<string, string[]>();
  for (const repo of repos) {
    const owner = repo.slice(0, Math.max(0, repo.indexOf("/")));
    const list = groups.get(owner);
    if (list === undefined) groups.set(owner, [repo]);
    else if (!list.includes(repo)) list.push(repo);
  }
  const all = [...groups].map(([owner, list]) => ({ owner, repos: list }));
  if (account === undefined) return all;
  const own = account.toLowerCase();
  return all.toSorted((a, b) => {
    const mine = Number(b.owner.toLowerCase() === own) - Number(a.owner.toLowerCase() === own);
    return mine !== 0 ? mine : a.owner.localeCompare(b.owner, undefined, { sensitivity: "base" });
  });
};

export interface RepoSuggestions {
  readonly groups: readonly RepoGroup[];
  /** Asked for and not answered yet. */
  readonly loading: boolean;
  /** Asks for the next page, while there is one and none is under way. */
  readonly more: (() => void) | undefined;
  /** A line under the list: the source's notice, or why it couldn't be asked. */
  readonly notice: ShellRepositoryPage["notice"];
  /** The repositories the source says are private. */
  readonly private: ReadonlySet<string>;
}

const NONE: ReadonlySet<string> = new Set();

const useDebounced = (value: string, ms: number) => {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
};

/** The repositories to offer for `text`; `active` is false while the list can't be shown. */
export function useRepoSuggestions(text: string, active: boolean): RepoSuggestions {
  const api = useApi();
  const source = useEmbedShell((s) => s.repositories);
  const query = useDebounced(text.trim(), SEARCH_DEBOUNCE_MS);

  // Asked for on mount, not on focus: a large organisation's first list takes seconds, and the
  // new-workspace sheet mounts this before its repository list is opened.
  const own = useQuery({
    queryKey: ["clone-suggestions"],
    queryFn: () => api.cloneSuggestions(),
    staleTime: 10 * 60_000,
    retry: false,
    enabled: source === undefined,
  });
  const hosted = useInfiniteQuery({
    queryKey: ["clone-suggestions", "host", query],
    queryFn: ({ pageParam, signal }) =>
      source!.list({ query, signal, ...(pageParam === undefined ? {} : { cursor: pageParam }) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next,
    staleTime: 5 * 60_000,
    retry: false,
    placeholderData: keepPreviousData,
    enabled: source !== undefined && active,
  });

  if (source === undefined) {
    return {
      groups: groupByOwner(matchRepos(own.data?.repos ?? [], text)),
      loading: own.isPending,
      more: undefined,
      notice: undefined,
      private: NONE,
    };
  }
  const pages = hosted.data?.pages ?? [];
  const typed = text.trim().toLowerCase();
  const listed = pages.flatMap((page) => page.repositories);
  const names = listed.map((repo) => repo.fullName).filter((name) => name.toLowerCase() !== typed);
  return {
    groups: groupByOwner(names, pages[0]?.account),
    loading: hosted.isPending && active,
    more:
      hosted.hasNextPage && !hosted.isFetchingNextPage
        ? () => void hosted.fetchNextPage()
        : undefined,
    notice: hosted.isError
      ? { text: errorMessage(hosted.error) || "Couldn't list your repositories." }
      : pages[0]?.notice,
    private: new Set(listed.flatMap((repo) => (repo.private === true ? [repo.fullName] : []))),
  };
}
