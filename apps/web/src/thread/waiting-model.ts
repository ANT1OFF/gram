import {
  HELPER_RESOLVE_UNDO_MS,
  approvalSubject,
  waitViewOf,
  type MemoryQuestion,
  type PendingRequest,
  type GramUIMessage,
  type ThreadId,
  type WaitItem,
  type WaitView,
  type WaitViewKind,
  type WorkspaceId,
  waitIsKept,
} from "@gram/contracts";

import type { InboxEntry } from "@/orchestration/inbox-model";

/** The part of a `ThreadSummary` Waiting on you reads. */
export interface WaitsOf {
  readonly thread: { readonly id: ThreadId };
  readonly waits?: readonly WaitItem[] | undefined;
  readonly helperResolved?: readonly WaitItem[] | undefined;
}

/** A workspace's open questions, which its orchestrator's tray folds in. */
export interface QuestionsOf {
  readonly workspaceId: WorkspaceId;
  readonly questions: readonly MemoryQuestion[];
}

/**
 * What a thread's Waiting on you tray lists: its own open items, the
 * helper's suggestions among them, oldest first, and for an orchestrator its workspace's open
 * questions after them. Its own requests stay out, since their cards are above the composer
 * already, and so do its workers', which the board lists.
 */
export const trayViews = (summary: WaitsOf, asked?: QuestionsOf): WaitView[] => [
  ...(summary.waits ?? []).map((item) => waitViewOf(summary.thread.id, item)),
  ...(asked === undefined
    ? []
    : asked.questions.map((question) =>
        questionView(summary.thread.id, asked.workspaceId, question),
      )),
];

/**
 * A thread's items as every view but its own tray lists them: kept ones only, since a helper's
 * suggestion waits for the user in that thread alone until it is kept.
 */
export const keptWaits = (summary: Pick<WaitsOf, "waits">): WaitItem[] =>
  (summary.waits ?? []).filter(waitIsKept);

/** How many count on the sidebar row: kept items only, never a suggestion. */
export const waitCount = (views: readonly WaitView[]): number =>
  views.filter((view) => view.suggested !== true).length;

const KIND_WORDS: Record<WaitViewKind, readonly [one: string, many: string]> = {
  draft: ["draft", "drafts"],
  review: ["review", "reviews"],
  decision: ["decision", "decisions"],
  action: ["step to take", "steps to take"],
  question: ["question", "questions"],
  approval: ["approval", "approvals"],
  plan: ["plan to review", "plans to review"],
};

/** "3 waiting on you: 2 drafts, 1 review", in the order kinds first appear. */
export const waitBreakdown = (views: readonly WaitView[]): string => {
  const counted = views.filter((view) => view.suggested !== true);
  const byKind = new Map<WaitViewKind, number>();
  for (const view of counted) byKind.set(view.kind, (byKind.get(view.kind) ?? 0) + 1);
  const parts = [...byKind].map(([kind, n]) => `${n} ${KIND_WORDS[kind][n === 1 ? 0 : 1]}`);
  return `${counted.length} waiting on you${parts.length === 0 ? "" : `: ${parts.join(", ")}`}`;
};

/** The collapsed line's names, short enough to scan: each title up to its first colon. */
export const trayNames = (views: readonly WaitView[]): string[] =>
  views.map((view) => {
    const head = view.title.split(/:\s/u)[0]?.trim() ?? "";
    return head === "" ? view.title : head;
  });

/** The collapsed button's spoken label: the count and every title, suggestions named as such. */
export const trayLabel = (views: readonly WaitView[]): string => {
  const kept = views.filter((view) => view.suggested !== true);
  const suggested = views.filter((view) => view.suggested === true);
  return [
    `${waitBreakdown(views)}.`,
    ...(kept.length === 0 ? [] : [kept.map((view) => view.title).join("; ")]),
    ...(suggested.length === 0
      ? []
      : [`Suggested: ${suggested.map((view) => view.title).join("; ")}`]),
  ].join(" ");
};

/** What the helper resolved that may still be undone at `now`, newest first. */
export const undoableHelperResolves = (summary: WaitsOf, now: number): WaitItem[] =>
  (summary.helperResolved ?? []).filter(
    (item) => item.resolvedAt !== undefined && item.resolvedAt > now - HELPER_RESOLVE_UNDO_MS,
  );

/** What a row offers, besides Jump to and Done, by its kind. */
export type WaitAction = "copy" | "open" | "answer";

export const primaryAction = (kind: WaitViewKind): WaitAction | undefined => {
  switch (kind) {
    case "draft":
      return "copy";
    case "review":
      return "open";
    case "decision":
      return "answer";
    default:
      return undefined;
  }
};

/** The host a link goes to, shown before it is opened; `undefined` for one that doesn't parse. */
export const linkHost = (link: string): string | undefined => {
  try {
    return new URL(link).host;
  } catch {
    // Stored links are checked on the way in; one that isn't a URL shows no host.
    return undefined;
  }
};

const FENCE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n {0,3}\1[ \t]*$/gmu;

/** The quoted blocks of `text`: each run of lines starting with `>`, without the markers. */
const quotedBlocks = (text: string): string[] => {
  const blocks: string[] = [];
  let run: string[] = [];
  for (const line of [...text.split("\n"), ""]) {
    const quoted = /^ {0,3}> ?(.*)$/u.exec(line);
    if (quoted) {
      run.push(quoted[1]!);
    } else if (run.length > 0) {
      blocks.push(run.join("\n"));
      run = [];
    }
  }
  return blocks;
};

/**
 * What Copy puts on the clipboard: the item's `copy` when it has one;
 * else, from the message it was added in, its one fenced or quoted block if it has exactly one, or
 * its whole text; else its body or title.
 */
export const copyTextOf = (
  item: Pick<WaitItem, "copy" | "body" | "title">,
  message: GramUIMessage | undefined,
): string => {
  if (item.copy !== undefined) return item.copy;
  const text = (message?.parts ?? [])
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n\n")
    .trim();
  if (text === "") return item.body ?? item.title;
  const fenced = [...text.matchAll(FENCE)].map((match) => match[2]!);
  const outsideFences = text.replace(FENCE, "");
  const blocks = [...fenced, ...quotedBlocks(outsideFences)];
  return blocks.length === 1 ? blocks[0]! : text;
};

/** How far back the tray's Resolved line reaches. */
export const RESOLVED_SHOWN_MS = 24 * 60 * 60 * 1000;

/**
 * The items resolved in the last day, latest first, for the tray's Resolved line and ⌘K: not the
 * helper's suggestions that were dismissed or lapsed, which were never the user's.
 */
export const recentlyResolved = (items: readonly WaitItem[], now: number): WaitItem[] =>
  items
    .filter(
      (item) =>
        item.suggested !== true &&
        item.resolvedAt !== undefined &&
        now - item.resolvedAt < RESOLVED_SHOWN_MS,
    )
    .toSorted((a, b) => b.resolvedAt! - a.resolvedAt!);

/** A note as the told line unfolds it: what the agent read, without the fence around it. */
export const noteShown = (note: string): string =>
  note.replace(/^<gram-note>|<\/gram-note>$/gu, "").trim();

const oneLine = (text: string): string => text.replace(/\s+/gu, " ").trim();

/** An open question's row: it lives with the orchestrator, and is answered on its own form. */
const questionView = (
  orchestratorId: ThreadId,
  workspaceId: WorkspaceId,
  question: MemoryQuestion,
): WaitView => {
  const preview = question.detail === undefined ? "" : oneLine(question.detail);
  const asked = question.date === undefined ? Number.NaN : Date.parse(question.date);
  return {
    key: `q:${workspaceId}:${question.id ?? question.text}`,
    threadId: orchestratorId,
    source: "question",
    kind: "question",
    title: question.text,
    ...(preview === "" ? {} : { preview }),
    createdAt: Number.isNaN(asked) ? 0 : asked,
  };
};

/** What a pending request asks, on one line. */
const requestTitle = (request: PendingRequest): string => {
  switch (request.kind) {
    case "approval":
      return `${request.displayName}: ${oneLine(approvalSubject(request))}`;
    case "question":
      return oneLine(request.questions[0]?.question ?? "A question");
    case "plan":
      return "Its plan, to approve";
  }
};

/**
 * A pending request's row, named for its thread; its card is where it is answered. A request
 * carries no time of its own, so `at` stands in: the thread's last activity, when it asked.
 */
const requestView = (
  entry: Pick<InboxEntry, "threadId" | "title" | "request">,
  at: number,
): WaitView => ({
  key: `r:${entry.threadId}:${entry.request.id}`,
  threadId: entry.threadId,
  source: "request",
  kind: entry.request.kind,
  title: requestTitle(entry.request),
  preview: entry.title,
  createdAt: at,
});

/** The part of a `ThreadSummary` the views across threads read. */
export interface WaitingThread extends WaitsOf {
  readonly thread: {
    readonly id: ThreadId;
    readonly title: string;
    readonly lastActivityAt: number;
    readonly workspaceId?: WorkspaceId | undefined;
  };
  readonly pendingRequests: readonly PendingRequest[];
}

/**
 * Everything that waits on the user, across every thread, oldest
 * first: each thread's kept items and pending requests, and each workspace's open questions under
 * its orchestrator. A workspace whose orchestrator isn't open has nowhere for its questions to live, so
 * they wait on the board instead.
 */
export const waitingViews = (
  threads: readonly WaitingThread[],
  asked: readonly (QuestionsOf & { readonly orchestratorId: ThreadId | undefined })[] = [],
): WaitView[] =>
  [
    ...threads.flatMap((summary) => [
      ...trayViews({ thread: summary.thread, waits: keptWaits(summary) }),
      ...summary.pendingRequests.map((request) =>
        requestView(
          { threadId: summary.thread.id, title: summary.thread.title, request },
          summary.thread.lastActivityAt,
        ),
      ),
    ]),
    ...asked.flatMap(({ orchestratorId, workspaceId, questions }) =>
      orchestratorId === undefined
        ? []
        : questions.map((question) => questionView(orchestratorId, workspaceId, question)),
    ),
  ].toSorted((a, b) => a.createdAt - b.createdAt);

/** Rows by the thread they live in, in `order`; a thread `order` doesn't name comes last. */
export const byThread = (
  views: readonly WaitView[],
  order: readonly ThreadId[],
): { readonly threadId: ThreadId; readonly views: readonly WaitView[] }[] => {
  const rank = new Map(order.map((id, index) => [id, index]));
  const groups = new Map<ThreadId, WaitView[]>();
  for (const view of views) {
    const group = groups.get(view.threadId);
    if (group === undefined) groups.set(view.threadId, [view]);
    else group.push(view);
  }
  return [...groups]
    .toSorted(([a], [b]) => (rank.get(a) ?? order.length) - (rank.get(b) ?? order.length))
    .map(([threadId, grouped]) => ({ threadId, views: grouped }));
};
