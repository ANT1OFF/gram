import type {
  UsageBreakdown,
  UsageLimitObservation,
  UsageModelShare,
  UsageOverview,
  UsageOverviewQuery,
  UsageOverviewRow,
  UsageProvider,
  UsageThreadRole,
  UsageTotals,
} from "@gram/contracts";

const empty = (): { -readonly [K in keyof UsageTotals]: number } => ({
  totalTokens: 0,
  uncachedInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  unclassifiedInputTokens: 0,
  outputTokens: 0,
});
type Bucket =
  | {
      readonly kind: "thread";
      readonly threadId: string;
      readonly title: string;
      readonly workspaceId: string | null;
      readonly role: UsageThreadRole;
    }
  | { readonly kind: "outside"; readonly sessions: number };
/** Where each provider's tokens go, as shares; the last takes what rounding leaves. */
type Plan = Readonly<Record<UsageProvider, ReadonlyArray<readonly [Bucket, number]>>>;

const thread = (
  threadId: string,
  title: string,
  workspaceId: string | null,
  role: UsageThreadRole,
): Bucket => ({ kind: "thread", threadId, title, workspaceId, role });

const SAMPLE_WORKSPACES = new Map([["ws-invented", "Invented workspace"]]);
const SAMPLE_PLAN: Plan = {
  claude: [
    [
      thread("t-invented-orchestrator", "Orchestrator · Invented", "ws-invented", "orchestrator"),
      0.6,
    ],
    [thread("t-invented-worker", "Invented worker", "ws-invented", "worker"), 1],
  ],
  codex: [
    [{ kind: "outside", sessions: 4 }, 0.3],
    [thread("t-flaky", "Fix flaky retry test", null, "solo"), 1],
  ],
};
const SHOWCASE_WORKSPACES = new Map([
  ["ws-gram", "gram"],
  ["ws-trading", "trading-bot"],
  ["ws-homelab", "homelab"],
  ["ws-dotfiles", "dotfiles"],
]);
const SHOWCASE_PLAN: Plan = {
  claude: [
    [thread("t-orch-gram", "Orchestrator · Gram", "ws-gram", "orchestrator"), 0.27],
    [thread("t-usage-page", "usage-page-design", "ws-gram", "worker"), 0.14],
    [thread("t-sidebar-fixes", "overview-sidebar-fixes", "ws-gram", "worker"), 0.11],
    [thread("t-orch-trading", "Orchestrator · trading-bot", "ws-trading", "orchestrator"), 0.08],
    [thread("t-pihole", "Tidy the Pi-hole config", "ws-homelab", "worker"), 0.06],
    [thread("t-zsh", "Speed up zsh start", "ws-dotfiles", "worker"), 0.04],
    [thread("t-flaky", "Fix flaky retry test", null, "solo"), 0.06],
    [{ kind: "outside", sessions: 38 }, 0.15],
    [thread("t-readme", "Rewrite the README", null, "solo"), 1],
  ],
  codex: [
    [thread("t-data-sources", "usage-data-sources", "ws-gram", "worker"), 0.34],
    [thread("t-backtest", "Backtest the momentum strategy", "ws-trading", "worker"), 0.28],
    [{ kind: "outside", sessions: 14 }, 0.22],
    [thread("t-bun-port", "Port the CLI to Bun", null, "solo"), 1],
  ],
};

const largest = <T extends { totals: UsageTotals }>(list: T[]) =>
  list.toSorted((a, b) => b.totals.totalTokens - a.totals.totalTokens);

/** The rows' totals spread over a plan's buckets exactly, so the breakdown sums to the totals. */
function mockBreakdown(
  rows: readonly UsageOverviewRow[],
  plan: Plan,
  workspaceNames: ReadonlyMap<string, string>,
): UsageBreakdown {
  type Counts = { -readonly [K in keyof UsageTotals]: number };
  interface Tally {
    totals: Counts;
    models: Map<string, UsageModelShare>;
  }
  const tallies = new Map<Bucket, Tally>();
  const outsideProvider = new Map<Bucket, UsageProvider>();
  for (const row of rows) {
    const buckets = plan[row.provider];
    const left: Counts = { ...row.totals };
    buckets.forEach(([bucket, share], i) => {
      const last = i === buckets.length - 1;
      const part = Object.fromEntries(
        (Object.keys(left) as (keyof UsageTotals)[]).map((key) => [
          key,
          last ? left[key] : Math.floor(row.totals[key] * share),
        ]),
      ) as unknown as UsageTotals;
      for (const key of Object.keys(left) as (keyof UsageTotals)[]) left[key] -= part[key];
      const tally = tallies.get(bucket) ?? { totals: empty(), models: new Map() };
      for (const key of Object.keys(part) as (keyof UsageTotals)[]) tally.totals[key] += part[key];
      const modelKey = JSON.stringify([row.provider, row.model]);
      const previous = tally.models.get(modelKey)?.totalTokens ?? 0;
      tally.models.set(modelKey, {
        provider: row.provider,
        model: row.model,
        totalTokens: previous + part.totalTokens,
      });
      tallies.set(bucket, tally);
      if (bucket.kind === "outside") outsideProvider.set(bucket, row.provider);
    });
  }
  const shown = (tally: Tally) => ({
    totals: tally.totals,
    models: [...tally.models.values()]
      .filter((m) => m.totalTokens > 0)
      .toSorted((a, b) => b.totalTokens - a.totalTokens),
  });
  const counted = [...tallies].filter(([, tally]) => tally.totals.totalTokens > 0);
  const threads = counted.flatMap(([bucket, tally]) =>
    bucket.kind === "thread" ? [{ bucket, tally }] : [],
  );
  const groups = new Map<string | null, { tally: Tally; threads: number }>();
  for (const { bucket, tally } of threads) {
    const group = groups.get(bucket.workspaceId) ?? {
      tally: { totals: empty(), models: new Map() },
      threads: 0,
    };
    group.threads++;
    for (const key of Object.keys(tally.totals) as (keyof UsageTotals)[])
      group.tally.totals[key] += tally.totals[key];
    for (const [key, model] of tally.models) {
      const previous = group.tally.models.get(key)?.totalTokens ?? 0;
      group.tally.models.set(key, { ...model, totalTokens: previous + model.totalTokens });
    }
    groups.set(bucket.workspaceId, group);
  }
  const solo = groups.get(null);
  return {
    workspaces: largest(
      [...groups].flatMap(([workspaceId, group]) =>
        workspaceId === null
          ? []
          : [
              {
                workspaceId,
                name: workspaceNames.get(workspaceId) ?? null,
                threads: group.threads,
                ...shown(group.tally),
              },
            ],
      ),
    ),
    solo:
      solo === undefined
        ? { threads: 0, totals: empty(), models: [] }
        : { threads: solo.threads, ...shown(solo.tally) },
    threads: largest(
      threads.map(({ bucket, tally }) => ({
        threadId: bucket.threadId,
        title: bucket.title,
        workspaceId: bucket.workspaceId,
        role: bucket.role,
        ...shown(tally),
      })),
    ),
    outside: largest(
      counted.flatMap(([bucket, tally]) =>
        bucket.kind === "outside"
          ? [{ provider: outsideProvider.get(bucket)!, sessions: bucket.sessions, ...shown(tally) }]
          : [],
      ),
    ),
  };
}

/** Thirty-odd days of invented work across four model families, for the page's own screenshots. */
function showcaseRows(to: number, from: number, provider: UsageProvider | undefined) {
  const rows: UsageOverviewRow[] = [];
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const models = [
    ["claude", "claude-opus-5-5", 1.0],
    ["claude", "claude-sonnet-5-5", 0.45],
    ["claude", "claude-haiku-5-5", 0.06],
    ["codex", "gpt-5.5-codex", 0.42],
  ] as const;
  for (let age = 89; age >= 0; age--) {
    const at = to - age * 86_400_000 - 3_600_000;
    const weekday = new Date(at).getUTCDay();
    const load = (weekday === 0 || weekday === 6 ? 0.35 : 1) * (0.55 + (89 - age) / 140);
    for (const [p, model, weight] of models) {
      const n = Math.round(
        load * weight * (0.7 + rnd() * 0.8) * 1_000_000 * (age === 0 ? 0.55 : 1),
      );
      if (at < from || (provider !== undefined && provider !== p)) continue;
      const cache = 0.62 + rnd() * 0.18;
      const output = Math.round(n * 0.06);
      const input = n - output;
      const read = Math.round(input * cache);
      const write = p === "claude" ? Math.round(input * 0.04) : 0;
      rows.push({
        day: new Date(at).toISOString().slice(0, 10),
        provider: p,
        model,
        turns: Math.max(1, Math.round(n / 40_000)),
        missingCacheRead: false,
        missingCacheWrite: false,
        totals: {
          totalTokens: n,
          uncachedInputTokens: input - read - write,
          cacheReadTokens: read,
          cacheWriteTokens: write,
          unclassifiedInputTokens: 0,
          outputTokens: output,
        },
      });
    }
  }
  return rows;
}

/**
 * Codex's 5-hour window over the last day as local snapshots would record it: a rise through each
 * window, a drop at each reset, and the current window climbing fast. Relative to `now`, like the
 * mock limits.
 */
function showcaseLimitHistory(now: number): UsageLimitObservation[] {
  const HOUR = 3_600_000;
  const resets = [-19.5, -13.75, -4.25];
  const observations: UsageLimitObservation[] = [];
  let u = 0.31;
  for (let h = -24; h <= -0.25; h += 0.25) {
    if (resets.some((r) => Math.abs(h - r) < 0.13)) u = 0.01;
    const night = h > -19 && h < -11;
    u += h > -4.25 ? 0.048 : night ? 0.002 : 0.02;
    observations.push({
      provider: "codex",
      window: "five_hour",
      at: Math.round(now + h * HOUR),
      utilization: Math.min(0.99, Math.round(u * 100) / 100),
    });
  }
  return observations.slice(-120);
}

/** Invented aggregate fixture, explicitly selected by browser tests. Never scans mock transcripts. */
export async function mockUsageOverview(query: UsageOverviewQuery): Promise<UsageOverview> {
  const state =
    typeof sessionStorage === "undefined" ? null : sessionStorage.getItem("gram.mock.usage");
  if (state === "payload-budget-before")
    throw new Error(
      "This period exceeds the recorded usage payload budget (1 MiB per message, 4 KiB per turn snapshot, 32 MiB total). Select a shorter period.",
    );
  if (state === "payload-budget-refusal")
    throw new Error(
      "This period exceeds the recorded usage payload budget (1 MiB per attribution projection, 4 KiB per turn snapshot, 32 MiB total). Select a shorter period.",
    );
  if (state === "error") throw new Error("Usage snapshot is unavailable");
  // The showcase runs to now, beside the live mock limits; the test fixtures stay fixed.
  const to = state === "showcase" ? Date.now() : Date.parse("2026-10-12T12:00:00Z");
  const from = to - query.days * 86_400_000;
  const rows: UsageOverviewRow[] =
    state === "showcase" ? showcaseRows(to, from, query.provider) : [];
  if (state === "sample" || state === "zero") {
    for (let age = 0; age < 90; age++) {
      const at = to - age * 86_400_000 - 3_600_000;
      if (at < from) continue;
      for (const provider of ["claude", "codex"] as const) {
        if (query.provider !== undefined && provider !== query.provider) continue;
        const n = state === "zero" ? 0 : ((age % 5) + 1) * (provider === "claude" ? 1700 : 900);
        const totals = {
          totalTokens: n * 10,
          uncachedInputTokens: n * 2,
          cacheReadTokens: n * 6,
          cacheWriteTokens: n,
          unclassifiedInputTokens: 0,
          outputTokens: n,
        };
        rows.push({
          day: new Date(at).toISOString().slice(0, 10),
          provider,
          model:
            provider === "codex" ? null : age < 14 ? "claude-example-new" : "claude-example-old",
          turns: 3,
          missingCacheRead: false,
          missingCacheWrite: false,
          totals,
        });
      }
    }
  }
  // Mirrors the actual migrated SQLite large-body oracle: 20 turns per provider, both Unknown.
  if (state === "large-history") {
    for (const provider of ["claude", "codex"] as const) {
      if (query.provider !== undefined && provider !== query.provider) continue;
      rows.push({
        day: "2026-10-12",
        provider,
        model: null,
        turns: 20,
        missingCacheRead: false,
        missingCacheWrite: false,
        totals: {
          totalTokens: provider === "claude" ? 3600 : 2400,
          uncachedInputTokens: provider === "claude" ? 2000 : 800,
          cacheReadTokens: 1000,
          cacheWriteTokens: 200,
          unclassifiedInputTokens: 0,
          outputTokens: 400,
        },
      });
    }
  }
  // Mirrors the immutable older-history handler oracle; all metadata and counts are invented.
  if (
    ["history-after", "history-partial"].includes(state ?? "") &&
    Date.parse("2026-10-06T12:00:00Z") >= from
  ) {
    const fixtures = [
      {
        provider: "codex" as const,
        model: "gpt-offline-old",
        totals: { ...empty(), totalTokens: 110, uncachedInputTokens: 100, outputTokens: 10 },
      },
      {
        provider: "codex" as const,
        model: "gpt-offline-new",
        totals: { ...empty(), totalTokens: 85, uncachedInputTokens: 80, outputTokens: 5 },
      },
      {
        provider: "claude" as const,
        model: "claude-offline-old",
        totals: {
          ...empty(),
          totalTokens: 32,
          uncachedInputTokens: 7,
          cacheReadTokens: 20,
          cacheWriteTokens: 3,
          outputTokens: 2,
        },
      },
    ];
    for (const fixture of fixtures)
      if (query.provider === undefined || query.provider === fixture.provider)
        rows.push({
          ...fixture,
          day: "2026-10-06",
          turns: 1,
          missingCacheRead: false,
          missingCacheWrite: false,
        });
  }
  const history =
    state?.startsWith("history-") && state !== "history-before"
      ? {
          sources: [
            {
              provider: "codex" as const,
              status: "partial" as const,
              files: 1,
              skippedFiles: state === "history-partial" ? 1 : 0,
              invalidLines: state === "history-untrusted-only" ? 1 : 0,
            },
            {
              provider: "claude" as const,
              status: "available" as const,
              files: 1,
              skippedFiles: 0,
              invalidLines: 0,
            },
          ],
          importedRecords: rows.length,
          matchedTurns: 0,
          unmatchedGramTurns: 0,
          untrustedGramTurns: state === "history-after" ? 0 : 1,
          ambiguousGramTurns: state === "history-partial" ? 1 : 0,
          selectedGramTurns: state === "history-after" ? 0 : state === "history-partial" ? 2 : 1,
          ambiguousRecords: 1,
          historyRecords: rows.length,
          matchedRecords: 0,
          overlappingRecords: 0,
          duplicateRecords: 0,
          omittedRecords: 0,
          coalescedRecords: 0,
          supersededRecords: 0,
        }
      : undefined;
  const totals = empty();
  for (const row of rows)
    for (const key of Object.keys(totals) as (keyof UsageTotals)[])
      (totals as Record<keyof UsageTotals, number>)[key] += row.totals[key];
  const recordedTurns = rows.reduce((sum, row) => sum + row.turns, 0);
  const showcase = state === "showcase";
  const breakdown = mockBreakdown(
    rows,
    showcase ? SHOWCASE_PLAN : SAMPLE_PLAN,
    showcase ? SHOWCASE_WORKSPACES : SAMPLE_WORKSPACES,
  );
  return {
    breakdown,
    ...(showcase && query.provider !== "claude"
      ? {
          localLimitHistory: {
            observations: showcaseLimitHistory(Date.now()),
            invalidReadings: 0,
            truncated: false,
          },
        }
      : {}),
    from,
    to,
    timezone: "UTC",
    provider: query.provider ?? null,
    totals,
    rows,
    ...(history === undefined
      ? {}
      : { history, partialUsageTurns: rows.filter((row) => row.provider === "codex").length }),
    recordedTurns,
    recordedConversations:
      history !== undefined
        ? rows.length === 0
          ? 0
          : query.provider === undefined
            ? 2
            : 1
        : state === "large-history"
          ? 1
          : rows.length,
    missingUsageTurns: state === "sample" ? 2 : 0,
    invalidUsageTurns: 0,
    unattributedTurns: state === "sample" ? 1 : 0,
    unknownModelTurns: rows
      .filter((row) => row.model === null)
      .reduce((n, row) => n + row.turns, 0),
    incompleteCacheTurns: 0,
    interruptedTurns: state === "sample" ? 1 : 0,
    openTurns: 0,
  };
}
