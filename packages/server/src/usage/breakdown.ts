import {
  USAGE_BREAKDOWN_THREADS,
  type UsageBreakdown,
  type UsageModelShare,
  type UsageProvider,
  type UsageThreadRole,
  type UsageTotals,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { SqlClient } from "../platform/unstable.ts";
import { addTotals, emptyTotals, type UsageRecord } from "./aggregate.ts";

/** Most models one breakdown row lists; the rest still count in its totals. */
const BREAKDOWN_MODELS = 16;
/** Longest title a breakdown carries, in characters. */
const TITLE_CHARS = 200;

interface Tally {
  totals: UsageTotals;
  readonly models: Map<string, UsageModelShare>;
}
const tally = (): Tally => ({ totals: emptyTotals(), models: new Map() });
const countInto = (
  into: Tally,
  provider: UsageProvider,
  model: string | null,
  totals: UsageTotals,
) => {
  into.totals = addTotals(into.totals, totals);
  const key = JSON.stringify([provider, model]);
  const previous = into.models.get(key)?.totalTokens ?? 0;
  into.models.set(key, { provider, model, totalTokens: previous + totals.totalTokens });
};
const mergeInto = (into: Tally, from: Tally) => {
  into.totals = addTotals(into.totals, from.totals);
  for (const [key, share] of from.models) {
    const previous = into.models.get(key)?.totalTokens ?? 0;
    into.models.set(key, { ...share, totalTokens: previous + share.totalTokens });
  }
};
const shown = (from: Tally) => ({
  totals: from.totals,
  models: [...from.models.values()]
    .toSorted((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, BREAKDOWN_MODELS),
});
const largestFirst = <T extends { readonly totals: UsageTotals }>(rows: T[]): T[] =>
  rows.toSorted((a, b) => b.totals.totalTokens - a.totals.totalTokens);

/**
 * The provider of a CLI session Gram never ran: history-merge gives one the thread id
 * `["cli", provider, session]`. Undefined for any Gram thread.
 */
export function outsideProvider(threadId: string): UsageProvider | undefined {
  if (!threadId.startsWith('["cli",')) return undefined;
  try {
    const parsed: unknown = JSON.parse(threadId);
    if (!Array.isArray(parsed) || parsed[0] !== "cli") return undefined;
    return parsed[1] === "claude" || parsed[1] === "codex" ? parsed[1] : undefined;
  } catch {
    return undefined;
  }
}

/** A thread as it is stored now, open or closed; absent once it is gone. */
export interface BreakdownThread {
  readonly title: string | null;
  readonly workspaceId: string | null;
  readonly role: string | null;
}

const roleOf = (thread: BreakdownThread | undefined): UsageThreadRole =>
  thread?.role === "orchestrator"
    ? "orchestrator"
    : thread?.role === "dream"
      ? "dream"
      : thread?.workspaceId != null
        ? "worker"
        : "solo";

/**
 * Collects what `aggregateUsage` counts, by thread and by CLI session, so the breakdown sums to the
 * overview's totals: every counted record lands in exactly one workspace, Solo, or Outside Gram.
 */
export function breakdownCollector() {
  const threads = new Map<string, Tally>();
  const outside = new Map<UsageProvider, { tally: Tally; sessions: Set<string> }>();
  return {
    onCounted: (record: UsageRecord, provider: UsageProvider, totals: UsageTotals) => {
      const cli = outsideProvider(record.thread_id);
      if (cli !== undefined) {
        const entry = outside.get(cli) ?? { tally: tally(), sessions: new Set<string>() };
        countInto(entry.tally, provider, record.model, totals);
        entry.sessions.add(record.thread_id);
        outside.set(cli, entry);
        return;
      }
      const entry = threads.get(record.thread_id) ?? tally();
      countInto(entry, provider, record.model, totals);
      threads.set(record.thread_id, entry);
    },
    threadIds: (): string[] => [...threads.keys()],
    build: (
      stored: ReadonlyMap<string, BreakdownThread>,
      workspaceNames: ReadonlyMap<string, string | null>,
    ): UsageBreakdown => {
      const workspaces = new Map<string, { tally: Tally; threads: number }>();
      const solo = { tally: tally(), threads: 0 };
      const named: UsageBreakdown["threads"][number][] = [];
      for (const [threadId, counted] of threads) {
        const thread = stored.get(threadId);
        const workspaceId = thread?.workspaceId ?? null;
        const group =
          workspaceId === null
            ? solo
            : (workspaces.get(workspaceId) ?? { tally: tally(), threads: 0 });
        mergeInto(group.tally, counted);
        group.threads++;
        if (workspaceId !== null) workspaces.set(workspaceId, group);
        named.push({
          threadId,
          title: thread?.title ?? null,
          workspaceId,
          role: roleOf(thread),
          ...shown(counted),
        });
      }
      return {
        workspaces: largestFirst(
          [...workspaces].map(([workspaceId, group]) => ({
            workspaceId,
            name: workspaceNames.get(workspaceId) ?? null,
            threads: group.threads,
            ...shown(group.tally),
          })),
        ),
        solo: { threads: solo.threads, ...shown(solo.tally) },
        threads: largestFirst(named).slice(0, USAGE_BREAKDOWN_THREADS),
        outside: largestFirst(
          [...outside].map(([provider, entry]) => ({
            provider,
            sessions: entry.sessions.size,
            ...shown(entry.tally),
          })),
        ),
      };
    },
  };
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/** The stored threads and workspace names a breakdown needs, by id, open and closed alike. */
export const readBreakdownNames = (threadIds: readonly string[]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ids = JSON.stringify(threadIds);
    const rows = yield* sql<{
      readonly id: string;
      readonly title: unknown;
      readonly workspace_id: unknown;
      readonly role: unknown;
    }>`
      WITH wanted AS MATERIALIZED (SELECT value AS id FROM json_each(${ids})),
      stored AS (
        SELECT t.id, t.data, 0 AS closed FROM threads t JOIN wanted w ON w.id = t.id
        UNION ALL
        SELECT c.thread_id, c.data, 1 FROM closed_threads c JOIN wanted w ON w.id = c.thread_id
      )
      SELECT id,
        substr(json_extract(CASE WHEN json_valid(data) THEN data ELSE '{}' END, '$.title'), 1, ${TITLE_CHARS}) AS title,
        json_extract(CASE WHEN json_valid(data) THEN data ELSE '{}' END, '$.workspaceId') AS workspace_id,
        json_extract(CASE WHEN json_valid(data) THEN data ELSE '{}' END, '$.role') AS role
      FROM stored ORDER BY closed`;
    const threads = new Map<string, BreakdownThread>();
    for (const row of rows) {
      if (threads.has(row.id)) continue;
      threads.set(row.id, {
        title: text(row.title),
        workspaceId: text(row.workspace_id),
        role: text(row.role),
      });
    }
    // A row holds a `WorkspaceState`, so the name is under `workspace`.
    const workspaceRows = yield* sql<{ readonly id: string; readonly name: unknown }>`
      SELECT id,
        substr(json_extract(CASE WHEN json_valid(data) THEN data ELSE '{}' END, '$.workspace.name'), 1, ${TITLE_CHARS}) AS name
      FROM workspaces`;
    const workspaces = new Map(workspaceRows.map((row) => [row.id, text(row.name)]));
    return { threads, workspaces };
  });
