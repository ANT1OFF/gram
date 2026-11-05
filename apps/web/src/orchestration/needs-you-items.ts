import {
  waitViewOf,
  waitIsKept,
  type ThreadId,
  type WaitItem,
  type WaitView,
  type WorkspaceId,
} from "@gram/contracts";

import type { Ask } from "./ask-model";
import type { FailureItem } from "./needs-you-model";

// Everything that needs the user, as one list the Inbox shows and the next and previous keys walk (docs/design/mocks/needs-you-home, direction C): every workspace's asks, its
// standing failures and its threads' Waiting on you items, grouped by workspace, newest first, then
// the threads outside any workspace with their requests, errors and waits. Each item names the
// thread it opens and the message it scrolls to. Every answer still goes through its source's own
// path. No React.

type NeedsYouKind = "approval" | "question" | "plan" | "wait" | "failure" | "watch";

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
  /** The workspace it is in, by name, and its id; none for the threads outside any. */
  readonly workspace?: string | undefined;
  readonly workspaceId?: WorkspaceId | undefined;
  /** What Open goes to; absent when no thread is left to open. */
  readonly threadId: ThreadId | undefined;
  /** The message Open scrolls to, when the source knows it. */
  readonly messageId?: string | undefined;
  /** The tool call it gates, which the thread's transcript can find. */
  readonly toolUseId?: string | undefined;
  /** Whether a live thread still owns it; false for a failure whose worker is gone or parked. */
  readonly owned: boolean;
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

/** One item for an ask, opening the thread that asked at its card. */
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
    };
  }
  const first = ask.group?.entries[0];
  const more = (ask.group?.entries.length ?? 1) - 1;
  return {
    ...base,
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

/**
 * One item for a failure; `live` says whether its worker still runs to own it. A stopped Watch PR
 * (babysit) is its own `watch` kind, not an error: it stands apart from failing PRs in the list.
 */
const failureItem = (failure: FailureItem, live: (id: ThreadId) => boolean): NeedsYouItem => ({
  key: failure.key,
  ids: failure.ids,
  kind: failure.failure.kind === "babysit" ? "watch" : "failure",
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
      ]
        .filter(keep)
        .map((item) => ({ ...item, workspace: w.name, workspaceId: w.workspaceId })),
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

/** The kinds of request Needs you lists apart, in the order it lists them. */
export type NeedsYouSectionKey =
  | "approvals"
  | "questions"
  | "reviews"
  | "drafts"
  | "steps"
  | "errors";

const SECTION_LABELS: Readonly<Record<NeedsYouSectionKey, string>> = {
  approvals: "Approvals",
  questions: "Questions",
  reviews: "Reviews",
  drafts: "Drafts",
  steps: "Steps to take",
  errors: "Errors",
};

/** A section's name in the category strip, one short word each. */
export const CATEGORY_LABELS: Readonly<Record<NeedsYouSectionKey, string>> = {
  ...SECTION_LABELS,
  steps: "Steps",
};

/**
 * What stops work first: failures, then approvals that hold a worker, then what it asks, then what
 * waits on a read, and drafts, which hold nothing, last.
 */
const SECTION_ORDER: readonly NeedsYouSectionKey[] = [
  "errors",
  "approvals",
  "questions",
  "reviews",
  "steps",
  "drafts",
];

/** The section an item is listed in: what the user is asked to do with it. */
export const sectionOf = (item: Pick<NeedsYouItem, "kind" | "wait">): NeedsYouSectionKey => {
  switch (item.kind) {
    case "approval":
    case "plan":
      return "approvals";
    case "question":
      return "questions";
    case "failure":
      return "errors";
    case "watch":
      return "steps";
    case "wait":
      switch (item.wait?.view.kind) {
        case "review":
          return "reviews";
        case "draft":
          return "drafts";
        case "decision":
          return "questions";
        default:
          return "steps";
      }
  }
};

/** One kind's section of Needs you: its items across every workspace, each saying its own. */
export interface NeedsYouSection {
  readonly key: NeedsYouSectionKey;
  readonly label: string;
  readonly items: readonly NeedsYouItem[];
}

/**
 * The list by what it asks of the user: errors, approvals, questions, reviews, steps to take, then
 * drafts, each across every workspace in the groups' order (newest first within each workspace).
 * Empty sections are left out. This is the order the list shows and the next key walks.
 */
export const needsYouSections = (groups: readonly NeedsYouGroup[]): NeedsYouSection[] => {
  const items = groups.flatMap((group) => group.items);
  return SECTION_ORDER.map((key) => ({
    key,
    label: SECTION_LABELS[key],
    items: items.filter((item) => sectionOf(item) === key),
  })).filter((section) => section.items.length > 0);
};

/** Every needs-you count the window shows, from the one list (`needsYouCounts`). */
export interface NeedsYouCounts {
  /** Everything listed: the pill, the window title and the dock badge. */
  readonly total: number;
  /** Each workspace's share: its group's items, which its badges show. */
  readonly byWorkspace: ReadonlyMap<string, number>;
}

/**
 * The one source of every needs-you count: the pill's total and each workspace's badge are the
 * Needs you list's items and its groups' items, so a count always equals the list it opens and a
 * workspace's badge is its share of the total. The threads outside any workspace keep the rest.
 */
export const needsYouCounts = (groups: readonly NeedsYouGroup[]): NeedsYouCounts => {
  const byWorkspace = new Map<string, number>();
  let total = 0;
  for (const group of groups) {
    total += group.items.length;
    if (group.workspaceId !== undefined) byWorkspace.set(group.workspaceId, group.items.length);
  }
  return { total, byWorkspace };
};

/** The category Needs you shows: every section, or one of them. */
export type NeedsYouCategory = "all" | NeedsYouSectionKey;

/**
 * The sections `category` shows: only its own, or all of them when it is "all" or has nothing left
 * (its last item answered), so a pick never strands the list empty.
 */
export const sectionsIn = (
  sections: readonly NeedsYouSection[],
  category: NeedsYouCategory,
): readonly NeedsYouSection[] => {
  if (category === "all") return sections;
  const one = sections.filter((section) => section.key === category);
  return one.length === 0 ? sections : one;
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

/** Whether the item asks the user something, rather than reporting an error: what a count opens on. */
const asks = (item: Pick<NeedsYouItem, "kind">) =>
  item.kind === "approval" || item.kind === "question" || item.kind === "plan";

/**
 * The item to open on when the user came for what needs them (a count, a question): the newest
 * request (approval, plan or question), else the newest other wait, else the newest error. Items
 * that keep no time count as oldest; ties keep the list's order.
 */
export const newestAsk = (items: readonly NeedsYouItem[]): NeedsYouItem | undefined => {
  const tiers = [
    items.filter(asks),
    items.filter((item) => !asks(item) && item.kind !== "failure"),
    items,
  ];
  const tier = tiers.find((each) => each.length > 0);
  return tier === undefined ? undefined : newestFirst(tier)[0];
};

/** The newest item listed in section `key`, for an Inbox that remembers the kind last looked at. */
export const newestOfKind = (
  items: readonly NeedsYouItem[],
  key: NeedsYouSectionKey,
): NeedsYouItem | undefined => newestFirst(items.filter((item) => sectionOf(item) === key))[0];

const KIND_WORDS: Readonly<Record<NeedsYouSectionKey, readonly [string, string]>> = {
  approvals: ["approval", "approvals"],
  questions: ["question", "questions"],
  reviews: ["review", "reviews"],
  drafts: ["draft", "drafts"],
  steps: ["step to take", "steps to take"],
  errors: ["error", "errors"],
};

/** "1 question, 1 error": what `items` ask by kind, in the Inbox's order, so asks and errors stay apart. */
export const kindsText = (items: readonly NeedsYouItem[]): string =>
  SECTION_ORDER.map((key) => {
    const n = items.filter((item) => sectionOf(item) === key).length;
    const [one, many] = KIND_WORDS[key];
    return n === 0 ? "" : `${n} ${n === 1 ? one : many}`;
  })
    .filter((words) => words !== "")
    .join(", ");

/**
 * Where the total is, from where the user is: "Here (Gram): nothing needs you", "billing-api: 1
 * question", "Threads outside a workspace: 1 error". The sidebar pill's hover, so the one global
 * count says how much of it is here and how much elsewhere; every count is a share of the one list.
 * Outside a workspace (a solo thread) there is no "here", only each group's share.
 */
export const scopeLines = (
  groups: readonly NeedsYouGroup[],
  here: { readonly workspaceId: WorkspaceId; readonly name: string } | undefined,
): string[] => {
  const name = (group: NeedsYouGroup) =>
    group.key === THREADS_GROUP ? "Threads outside a workspace" : group.name;
  const own =
    here === undefined ? undefined : groups.find((group) => group.workspaceId === here.workspaceId);
  const others = groups.filter((group) => group !== own && group.items.length > 0);
  const lines: string[] = [];
  if (here !== undefined) {
    const kinds = own === undefined ? "" : kindsText(own.items);
    lines.push(`Here (${here.name}): ${kinds === "" ? "nothing needs you" : kinds}`);
  }
  for (const group of others) lines.push(`${name(group)}: ${kindsText(group.items)}`);
  return lines;
};
