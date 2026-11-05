import type { RepositoryCandidate } from "@gram/contracts";

/** How many repositories the first run lists before it offers a search. */
export const RECENT_LIMIT = 6;

/**
 * The repositories matching what was typed in the first run's search: every word, in any order, in
 * the name or the path, ignoring case. Name matches come first, then path-only ones, each in the
 * order Gram listed them (most recent first). An empty query keeps the list as it is.
 */
export function matchRepos(
  repos: readonly RepositoryCandidate[],
  query: string,
): readonly RepositoryCandidate[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return repos;
  const hits = repos.filter((repo) => {
    const text = `${repo.name} ${repo.root}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
  const inName = (repo: RepositoryCandidate) =>
    words.every((word) => repo.name.toLowerCase().includes(word));
  return [...hits.filter(inName), ...hits.filter((repo) => !inName(repo))];
}
