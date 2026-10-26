import type { ReviewSeverity, ReviewThread } from "@gram/contracts";

const SEVERITY_ORDER: Record<ReviewSeverity, number> = {
  blocker: 0,
  suggestion: 1,
  outstanding: 2,
  finding: 3,
};

export const SEVERITY_LABEL: Record<ReviewSeverity, string> = {
  blocker: "Blocker",
  suggestion: "Suggestion",
  outstanding: "Still outstanding",
  finding: "Finding",
};

interface ReviewFileGroup {
  path: string;
  /** Unresolved threads on current lines, most severe first, then by line. */
  current: ReviewThread[];
  /** Unresolved threads whose lines changed since the review. */
  outdated: ReviewThread[];
}

export interface GroupedReview {
  files: ReviewFileGroup[];
  resolved: ReviewThread[];
}

const bySeverityThenLine = (a: ReviewThread, b: ReviewThread) =>
  SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
  (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER);

const mostSevere = (group: ReviewFileGroup) =>
  Math.min(...[...group.current, ...group.outdated].map((t) => SEVERITY_ORDER[t.severity]));

/** Unresolved threads by file (files with blockers first, then by path), and the resolved rest. */
export function groupReviewThreads(threads: readonly ReviewThread[]): GroupedReview {
  const byPath = new Map<string, ReviewFileGroup>();
  const resolved: ReviewThread[] = [];
  for (const thread of threads) {
    if (thread.isResolved) {
      resolved.push(thread);
      continue;
    }
    let group = byPath.get(thread.path);
    if (!group) {
      group = { path: thread.path, current: [], outdated: [] };
      byPath.set(thread.path, group);
    }
    (thread.isOutdated ? group.outdated : group.current).push(thread);
  }
  const files = [...byPath.values()];
  for (const group of files) {
    group.current.sort(bySeverityThenLine);
    group.outdated.sort(bySeverityThenLine);
  }
  files.sort((a, b) => mostSevere(a) - mostSevere(b) || a.path.localeCompare(b.path));
  return { files, resolved };
}

const TAG = /^\s*(?:\*\*|`)?\[(?:blocker|suggestion|still outstanding)\](?:\*\*|`)?\s*/i;
const SUGGESTION_BLOCK = /```suggestion[^\n]*\n[\s\S]*?```\n?/;

/** A comment body for display: the severity tag and suggestion block have their own UI. */
export const displayBody = (body: string) =>
  body.replace(TAG, "").replace(SUGGESTION_BLOCK, "").trim();

export const location = (thread: ReviewThread) =>
  thread.line === undefined
    ? thread.path
    : thread.startLine !== undefined && thread.startLine !== thread.line
      ? `${thread.path}:${thread.startLine}-${thread.line}`
      : `${thread.path}:${thread.line}`;

const quote = (text: string) =>
  text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");

const finding = (thread: ReviewThread) => {
  const body = thread.comments[0] ? displayBody(thread.comments[0].body) : "";
  const suggestion = thread.comments[0]?.suggestion;
  const suggested =
    suggestion === undefined
      ? ""
      : suggestion === ""
        ? "\n\nSuggested change: delete these lines."
        : `\n\nSuggested change:\n\n\`\`\`\n${suggestion}\n\`\`\``;
  return `${quote(body)}${suggested}`;
};

const heading = (thread: ReviewThread) =>
  `\`${location(thread)}\` [${thread.severity}]${thread.isOutdated ? " (outdated)" : ""}`;

/** The structured message that asks the thread's agent to address one review finding. */
export function addressThreadMessage(prNumber: number, thread: ReviewThread): string {
  return [
    `Address review finding on PR #${prNumber} — ${heading(thread)}:`,
    "",
    finding(thread),
    "",
    `When done, reply in the review thread (id \`${thread.id}\`) with what changed.`,
  ].join("\n");
}

/** One message listing every given blocker, for "Address all blockers". */
export function addressBlockersMessage(
  prNumber: number,
  blockers: readonly ReviewThread[],
): string {
  const items = blockers.map((thread, i) => `${i + 1}. ${heading(thread)}\n\n${finding(thread)}`);
  return [
    `Address ${blockers.length === 1 ? "the review blocker" : `all ${blockers.length} review blockers`} on PR #${prNumber}:`,
    "",
    items.join("\n\n"),
    "",
    "When done, reply in each review thread with what changed.",
    "",
    `Review thread ids: ${blockers.map((t) => `\`${t.id}\``).join(", ")}`,
  ].join("\n");
}
