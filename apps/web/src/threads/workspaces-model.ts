import type { OpenPrRow, ThreadSummary } from "@gram/contracts";

import { agoText } from "@/lib/time";

/** An embedding app's word for a workspace on the page of every thread: one, and more than one. */
export interface WorkspaceWords {
  readonly noun: string;
  readonly plural: string;
}

/** What one workspace's row says of it now. */
export interface WorkspaceFacts {
  /** How much of it waits on you: its share of Needs you. */
  readonly asks: number;
  /** Its workers at work now. */
  readonly working: number;
  /** Its threads' open pull requests. */
  readonly prs: number;
  /** When it was paused, if it is. */
  readonly pausedAt?: number | undefined;
  /** When any of its threads last did anything. */
  readonly lastWorkAt?: number | undefined;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * A row's facts in words, in the order it shows them: what waits on you, that it is paused, what
 * runs, what is open, and when it last worked once nothing runs. None is left out for being zero
 * but the ones that then say nothing ("0 pull requests open").
 */
export const workspaceFactWords = (
  facts: WorkspaceFacts,
  now: number,
): readonly {
  readonly key: string;
  readonly words: string;
  readonly tone?: "asks";
}[] => {
  const paused = facts.pausedAt !== undefined;
  return [
    ...(facts.asks > 0
      ? [
          {
            key: "asks",
            words: `${facts.asks} ${facts.asks === 1 ? "waits" : "wait"} on you`,
            tone: "asks" as const,
          },
        ]
      : []),
    ...(facts.pausedAt === undefined
      ? []
      : [
          {
            key: "paused",
            words: `Paused ${agoText(facts.pausedAt, now, { long: true })}`,
          },
        ]),
    ...(facts.working > 0
      ? [
          {
            key: "working",
            words: `${count(facts.working, "worker", "workers")} running`,
          },
        ]
      : paused
        ? []
        : [{ key: "working", words: "Nothing running" }]),
    ...(facts.prs > 0
      ? [
          {
            key: "prs",
            words: `${count(facts.prs, "pull request", "pull requests")} open`,
          },
        ]
      : []),
    ...(facts.working === 0 && facts.lastWorkAt !== undefined
      ? [
          {
            key: "lastWork",
            words: `Last work ${agoText(facts.lastWorkAt, now, { long: true })}`,
          },
        ]
      : []),
  ];
};

/** How many open pull requests each workspace's threads own, by the workspace's id. */
export const prsByWorkspace = (
  rows: readonly Pick<OpenPrRow, "owner">[],
  byId: Readonly<Record<string, ThreadSummary | undefined>>,
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const workspaceId = row.owner === undefined ? undefined : byId[row.owner]?.thread.workspaceId;
    if (workspaceId === undefined) continue;
    counts.set(workspaceId, (counts.get(workspaceId) ?? 0) + 1);
  }
  return counts;
};

/** When each workspace's threads last did anything, by the workspace's id. */
export const lastWorkByWorkspace = (
  summaries: Iterable<ThreadSummary>,
): ReadonlyMap<string, number> => {
  const latest = new Map<string, number>();
  for (const { thread } of summaries) {
    if (thread.workspaceId === undefined) continue;
    latest.set(
      thread.workspaceId,
      Math.max(latest.get(thread.workspaceId) ?? 0, thread.lastActivityAt),
    );
  }
  return latest;
};

/** A workspace's repositories as its row names them: every one, by name, in the order it has them. */
export const repositoriesLine = (
  projectIds: readonly string[],
  nameOf: ReadonlyMap<string, string>,
): string => projectIds.flatMap((id) => nameOf.get(id) ?? []).join(", ");

/**
 * The line under the list for the threads in no workspace, which the list leaves out: how many
 * there are and how many run, or undefined with none. `threads` is the name of the view that
 * lists them.
 */
export const outsideLine = (
  outside: { readonly total: number; readonly running: number },
  words: WorkspaceWords,
): string | undefined => {
  if (outside.total === 0) return undefined;
  const article = /^[aeiou]/i.test(words.noun) ? "an" : "a";
  const running = outside.running === 0 ? "" : `, ${outside.running} running`;
  return `${count(outside.total, "thread", "threads")} outside ${article} ${words.noun.toLowerCase()}${running}.`;
};

/** What the empty list says a workspace is, in the embedding app's word for one. */
export const emptyWords = (words: WorkspaceWords): { title: string; line: string } => {
  const noun = words.noun.toLowerCase();
  const article = /^[aeiou]/i.test(noun) ? "An" : "A";
  return {
    title: `No ${noun} yet`,
    line: `${article} ${noun} is an orchestrator and its workers on one or more repositories. Hand it a goal and it plans the work, runs workers and sees their pull requests merged.`,
  };
};
