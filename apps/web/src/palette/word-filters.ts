import { waitIsKept, type PaletteFilter, type ThreadSummary } from "@gram/contracts";

import { threadWorking } from "@/orchestration/tree-model";
import { needsYou } from "@/sidebar/grouping";

export interface NamedWorkspace {
  id: string;
  name: string;
}
export interface WordParse {
  filters: PaletteFilter[];
  text: string;
}

/** Consume only whole phrases; workspace names win before words such as "open" or "today". */
export function parseWordFilters(raw: string, workspaces: readonly NamedWorkspace[]): WordParse {
  if (raw.startsWith(">")) return { filters: [], text: raw };
  let text = raw.toLowerCase().replace(/[?!,]/g, " ");
  const filters: PaletteFilter[] = [];
  const take = (pattern: RegExp, filter: PaletteFilter) => {
    if (filters.some((f) => f.field === filter.field) || !pattern.test(text)) return;
    filters.push(filter);
    text = text.replace(pattern, " ");
  };
  for (const workspace of workspaces.toSorted((a, b) => b.name.length - a.name.length)) {
    const name = workspace.name
      .toLowerCase()
      .trim()
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (name)
      take(new RegExp(`(^|\\s)(?:in\\s+)?${name}(?=\\s|$)`, "u"), {
        field: "workspace",
        value: workspace.id,
      });
  }
  take(/\b(?:pull requests?|prs?)\b/, { field: "kind", value: "pr" });
  take(/\bworkers?\b/, { field: "kind", value: "worker" });
  take(/\bthreads?\b/, { field: "kind", value: "thread" });
  take(/\b(?:asks?|questions?)\b/, { field: "kind", value: "ask" });
  take(/\b(?:waiting on me|waiting on you|needs me|needs you|needs input|needs approval)\b/, {
    field: "state",
    value: "waiting",
  });
  take(/\b(?:checks failing|failing|failed|errors?)\b/, { field: "state", value: "failing" });
  take(/\b(?:working|running)\b/, { field: "state", value: "working" });
  for (const value of ["idle", "done", "open", "closed", "merged"] as const)
    take(new RegExp(`\\b${value}\\b`), { field: "state", value });
  take(/\b(?:last 24 (?:h|hours?)|past 24 hours?)\b/, { field: "time", value: "last24h" });
  take(/\b(?:last 7 days|past week)\b/, { field: "time", value: "last7d" });
  take(/\bthis week\b/, { field: "time", value: "thisWeek" });
  take(/\btoday\b/, { field: "time", value: "today" });
  take(/\byesterday\b/, { field: "time", value: "yesterday" });
  // Filler is ignored only after an actual filter was found. Unrecognized words remain searchable.
  if (filters.length)
    text = text.replace(/\b(?:show|find|me|the|all|in|from|what's|what is)\b/g, " ");
  return { filters, text: text.replace(/\s+/g, " ").trim() };
}

export const FILTER_LABELS: Record<string, string> = {
  thread: "Threads",
  worker: "Workers",
  pr: "PRs",
  ask: "Asks",
  failing: "Checks failing",
  waiting: "Waiting on you",
  working: "Working",
  idle: "Idle",
  done: "Done",
  open: "Open",
  closed: "Closed",
  merged: "Merged",
  today: "Today",
  yesterday: "Yesterday",
  thisWeek: "This week",
  last24h: "Last 24 h",
  last7d: "Last 7 days",
};

export function timeBounds(value: string, now: number): [number, number] {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const end = day.getTime();
  if (value === "last24h") return [now - 86_400_000, now];
  if (value === "last7d") return [now - 7 * 86_400_000, now];
  if (value === "yesterday") {
    day.setDate(day.getDate() - 1);
    return [day.getTime(), end];
  }
  if (value === "thisWeek") day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return [day.getTime(), now];
}

/** Only facts already in the sidebar snapshot; an unknown PR timestamp never implies recency. */
export function matchesWordFilters(
  summary: ThreadSummary,
  kind: string,
  filters: readonly PaletteFilter[],
  now: number,
  itemAt?: number,
): boolean {
  return filters.every(({ field, value }) => {
    if (field === "workspace") return summary.thread.workspaceId === value;
    if (field === "kind") return kind === value;
    const pr = summary.git?.pr;
    if (field === "time") {
      const [start, end] = timeBounds(value, now);
      const at =
        itemAt ?? (kind === "pr" ? Date.parse(pr?.updatedAt ?? "") : summary.thread.lastActivityAt);
      return at >= start && (value === "yesterday" ? at < end : at <= end);
    }
    if (value === "failing")
      return kind === "pr"
        ? pr?.checks === "failing"
        : summary.status === "error" || pr?.checks === "failing";
    // Waiting is what the sidebar puts under Needs you, or a Waiting on you item still kept;
    // working and idle are what its glyph says, work running under a resting thread included.
    if (value === "waiting")
      return (
        needsYou(summary) ||
        summary.pendingRequests.length > 0 ||
        (summary.waits ?? []).some(waitIsKept)
      );
    if (value === "working") return threadWorking(summary);
    if (value === "idle")
      return (summary.status === "idle" || summary.status === "cold") && !threadWorking(summary);
    if (value === "done") return summary.thread.completedAt !== undefined;
    if (kind === "pr") return pr?.state === value.toUpperCase();
    if (kind === "ask") return value === "open";
    return false;
  });
}
