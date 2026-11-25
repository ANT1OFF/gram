import type { ThreadSummary } from "@gram/contracts";

import { useThreadsStore, type ThreadsState } from "@/stores/threads";

import { attentionOf } from "./attention";

const listedGit = (summary: ThreadSummary): string => {
  const { git } = summary;
  return [
    attentionOf(summary)?.key ?? "",
    git?.pr === undefined ? "" : `${git.pr.number}:${git.pr.state}`,
    (git?.extraPrs ?? []).map((pr) => `${pr.url}:${pr.state}`).join(","),
    git?.origin ?? "",
    git?.prElsewhere === undefined ? "" : "elsewhere",
  ].join("|");
};

const listsAs = (shown: ThreadSummary, next: ThreadSummary): boolean => {
  if (shown === next) return true;
  const before: Readonly<Record<string, unknown>> = shown;
  const after: Readonly<Record<string, unknown>> = next;
  const keys = Object.keys(after);
  if (keys.length !== Object.keys(before).length) return false;
  for (const key of keys) {
    if (key !== "git" && before[key] !== after[key]) return false;
  }
  return listedGit(shown) === listedGit(next);
};

let lastById: ThreadsState["byId"] | undefined;
let lastListed: ThreadsState["byId"] = {};

/**
 * `byId` as the thread lists see it. A `git.state` that changes nothing `listedGit` reads keeps the
 * thread's previous summary, and so the previous map, so the sidebar doesn't regroup and re-render
 * every row's layout wrapper for a sweep that moved one row's sync chip. That summary's other git is
 * then stale: a row reads its own summary from the store, and anything done on a click reads
 * `getState()`.
 */
export function selectListed(s: Pick<ThreadsState, "byId">): ThreadsState["byId"] {
  if (s.byId === lastById) return lastListed;
  const previous = lastListed;
  const next: Record<string, ThreadSummary> = {};
  let same = Object.keys(s.byId).length === Object.keys(previous).length;
  for (const [id, summary] of Object.entries(s.byId)) {
    const shown = previous[id];
    const listed = shown !== undefined && listsAs(shown, summary) ? shown : summary;
    next[id] = listed;
    if (listed !== shown) same = false;
  }
  lastById = s.byId;
  lastListed = same ? previous : next;
  return lastListed;
}

/** `selectListed` of the threads store, for components that list threads. */
export const useListedThreads = () => useThreadsStore(selectListed);
