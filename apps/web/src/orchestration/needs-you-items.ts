import {
  waitViewOf,
  waitIsKept,
  type ThreadId,
  type WaitItem,
  type WaitView,
  type WorkspaceId,
} from "@gram/contracts";

import { answersInPlace, type Ask } from "./ask-model";
import type { FailureItem } from "./needs-you-model";

// Everything that needs the user, as one list the Needs you popover, its panel and the next and
// previous keys walk (docs/design/mocks/needs-you-home, direction C): every workspace's asks, its
// standing failures and its threads' Waiting on you items, grouped by workspace, newest first, then
// the threads outside any workspace with their requests, errors and waits. Each item names the
// thread it opens and the message it scrolls to. Every answer still goes through its source's own
// path. No React.

type NeedsYouKind = "approval" | "question" | "plan" | "wait" | "failure";

/** The panel's filter: everything, or one family of kinds. */
export type NeedsYouFilter = "all" | "asks" | "waits" | "failing";

export const NEEDS_YOU_FILTERS: readonly NeedsYouFilter[] = ["all", "asks", "waits", "failing"];

/** The family a kind's filter shows it under. */
const filterOf = (kind: NeedsYouKind): Exclude<NeedsYouFilter, "all"> =>
  kind === "wait" ? "waits" : kind === "failure" ? "failing" : "asks";

export interface NeedsYouItem {
  /** Unique across the list. */
  readonly key: string;
  /** What Later puts away and an answer hides: the ask's ids, the wait's key, the failure's ids. */
  readonly ids: readonly string[];
  readonly kind: NeedsYouKind;
  /** The words a row leads with; an approval's command follows in `command`. */
  readonly title: string;
  /** The exact command, path or URL an approval covers, shown whole. */
  readonly command?: string | undefined;
  /** The thread it belongs to, by title; "Orchestrator" for the workspace's own questions. */
  readonly where: string;
  /** What Open goes to; absent when no thread is left to open. */
  readonly threadId: ThreadId | undefined;
  /** The message Open scrolls to, when the source knows it. */
  readonly messageId?: string | undefined;
  /** The tool call it gates, which the thread's transcript can find. */
  readonly toolUseId?: string | undefined;
  /** Whether a live thread still owns it; false for a failure whose worker is gone or parked. */
  readonly owned: boolean;
  /** Answered in its orchestrator's ask stack, which a jump focuses, rather than in a card. */
  readonly inStack?: boolean | undefined;
  /** Epoch ms it was asked or added, when the source keeps it. */
  readonly at?: number | undefined;
  readonly ask?: Ask | undefined;
  readonly wait?: { readonly item: WaitItem; readonly view: WaitView } | undefined;
  readonly failure?: FailureItem | undefined;
}

export interface NeedsYouGroup {
  /** The workspace's id, or `THREADS_GROUP` for threads outside any workspace. */
  readonly key: string;
  readonly workspaceId: WorkspaceId | undefined;
  readonly name: string;
  readonly orchestratorThreadId: ThreadId | undefined;
  readonly items: readonly NeedsYouItem[];
}

export const THREADS_GROUP = "threads";

/** The part of a workspace's asks the list reads. */
export interface NeedsYouWorkspace {
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly orchestratorThreadId: ThreadId | undefined;
  readonly asks: readonly Ask[];
}

/** The part of a thread summary the list reads. */
export interface NeedsYouThread {
  readonly thread: {
    readonly id: ThreadId;
    readonly title: string;
    readonly workspaceId?: WorkspaceId | undefined;
    readonly parked?: boolean | undefined;
  };
  readonly waits?: readonly WaitItem[] | undefined;
}

/** What a row says, the command after the words when there is one: for labels and hints. */
export const itemText = (item: Pick<NeedsYouItem, "title" | "command">): string =>
  item.command === undefined ? item.title : `${item.title} ${item.command}`;

/** One item for an ask, opening the thread that asked. */
const askItem = (
  ask: Ask,
  workspace: Pick<NeedsYouWorkspace, "orchestratorThreadId">,
): NeedsYouItem => {
  const base = {
    key: `ask:${ask.key}`,
    ids: ask.ids,
    kind: ask.icon,
    title: ask.lead,
    command: ask.command,
    owned: true,
    ask,
  };
  if (ask.worker !== undefined) {
    const { question } = ask.worker;
    return {
      ...base,
      where: question.title,
      threadId: question.threadId,
      at: question.forwardedAt ?? question.askedAt,
    };
  }
  if (ask.memory !== undefined) {
    return {
      ...base,
      where: "Orchestrator",
      threadId: workspace.orchestratorThreadId,
      inStack: true,
    };
  }
  const first = ask.group?.entries[0];
  const more = (ask.group?.entries.length ?? 1) - 1;
  // The orchestrator's own requests that answer in place show in its stack, not as cards.
  const own =
    workspace.orchestratorThreadId !== undefined &&
    (ask.group?.entries.every((entry) => entry.threadId === workspace.orchestratorThreadId) ??
      false) &&
    first !== undefined &&
    answersInPlace(first.request);
  return {
    ...base,
    ...(own ? { inStack: true } : {}),
    where: first === undefined ? "" : more > 0 ? `${first.title} +${more}` : first.title,
    threadId: first?.threadId,
    toolUseId: first?.request.toolUseId,
  };
};

/** One item for a stored Waiting on you item, opening its thread at the message that added it. */
const waitItem = (summary: NeedsYouThread, item: WaitItem): NeedsYouItem => {
  const view = waitViewOf(summary.thread.id, item);
  return {
    key: view.key,
    ids: [view.key],
    kind: "wait",
    title: view.title,
    where: summary.thread.title,
    threadId: summary.thread.id,
    messageId: view.messageId,
    owned: true,
    at: view.createdAt,
    wait: { item, view },
  };
};

/** One item for a failure; `live` says whether its worker still runs to own it. */
const failureItem = (failure: FailureItem, live: (id: ThreadId) => boolean): NeedsYouItem => ({
  key: failure.key,
  ids: failure.ids,
  kind: "failure",
  title: failure.failure.tag,
  where: failure.failure.title,
  threadId: failure.failure.threadId,
  owned: live(failure.failure.threadId),
  at: failure.failure.at,
  failure,
});

/** Newest first; what keeps no time goes last, in the order it came. */
const newestFirst = (items: readonly NeedsYouItem[]): NeedsYouItem[] =>
  items
    .map((item, index) => ({ item, index }))
    .toSorted((a, b) => (b.item.at ?? -1) - (a.item.at ?? -1) || a.index - b.index)
    .map(({ item }) => item);

/** What the threads outside any workspace ask beside their waits. */
export interface NeedsYouSolo {
  /** Their requests, as asks. */
  readonly asks: readonly Ask[];
  /** Their errors. */
  readonly failures: readonly FailureItem[];
}

const NO_SOLO: NeedsYouSolo = { asks: [], failures: [] };

/**
 * Every workspace's group in the order given, then the threads outside any, each newest first and
 * without the ids in `away` (put away for Later). Empty groups are left out.
 */
export const needsYouGroups = ({
  workspaces,
  failures,
  threads,
  solo = NO_SOLO,
  away = new Set(),
}: {
  readonly workspaces: readonly NeedsYouWorkspace[];
  readonly failures: ReadonlyMap<WorkspaceId, readonly FailureItem[]>;
  readonly threads: readonly NeedsYouThread[];
  readonly solo?: NeedsYouSolo;
  readonly away?: ReadonlySet<string>;
}): NeedsYouGroup[] => {
  const known = new Set<string>(workspaces.map((w) => w.workspaceId));
  const byId = new Map(threads.map((summary) => [summary.thread.id as string, summary]));
  const live = (id: ThreadId) => {
    const summary = byId.get(id);
    return summary !== undefined && summary.thread.parked !== true;
  };
  const waitsIn = (inWorkspace: (workspaceId: WorkspaceId | undefined) => boolean) =>
    threads.flatMap((summary) =>
      inWorkspace(summary.thread.workspaceId)
        ? (summary.waits ?? []).filter(waitIsKept).map((item) => waitItem(summary, item))
        : [],
    );
  const keep = (item: NeedsYouItem) => !item.ids.some((id) => away.has(id));
  const groups: NeedsYouGroup[] = workspaces.map((w) => ({
    key: w.workspaceId,
    workspaceId: w.workspaceId,
    name: w.name,
    orchestratorThreadId: w.orchestratorThreadId,
    items: newestFirst(
      [
        ...w.asks.map((ask) => askItem(ask, w)),
        ...(failures.get(w.workspaceId) ?? []).map((failure) => failureItem(failure, live)),
        ...waitsIn((id) => id === w.workspaceId),
      ].filter(keep),
    ),
  }));
  groups.push({
    key: THREADS_GROUP,
    workspaceId: undefined,
    name: "Threads",
    orchestratorThreadId: undefined,
    items: newestFirst(
      [
        ...solo.asks.map((ask) => askItem(ask, { orchestratorThreadId: undefined })),
        ...solo.failures.map((failure) => failureItem(failure, live)),
        ...waitsIn((id) => id === undefined || !known.has(id)),
      ].filter(keep),
    ),
  });
  return groups.filter((group) => group.items.length > 0);
};

/** `groups` with only the items `filter` shows, empty groups left out. */
export const filterGroups = (
  groups: readonly NeedsYouGroup[],
  filter: NeedsYouFilter,
): NeedsYouGroup[] =>
  filter === "all"
    ? [...groups]
    : groups
        .map((group) => ({
          ...group,
          items: group.items.filter((item) => filterOf(item.kind) === filter),
        }))
        .filter((group) => group.items.length > 0);

/** How many of each family, for the filter's counts. */
export const filterCounts = (
  groups: readonly NeedsYouGroup[],
): Readonly<Record<NeedsYouFilter, number>> => {
  const counts = { all: 0, asks: 0, waits: 0, failing: 0 };
  for (const item of groups.flatMap((group) => group.items)) {
    counts.all += 1;
    counts[filterOf(item.kind)] += 1;
  }
  return counts;
};

/**
 * The item a step of `by` from `current` lands on, wrapping; from nothing, the first going forward
 * and the last going back.
 */
export const stepItem = (
  items: readonly NeedsYouItem[],
  current: string | undefined,
  by: 1 | -1,
): NeedsYouItem | undefined => {
  if (items.length === 0) return undefined;
  const at = items.findIndex((item) => item.key === current);
  if (at === -1) return by === 1 ? items[0] : items.at(-1);
  return items[(((at + by) % items.length) + items.length) % items.length];
};
