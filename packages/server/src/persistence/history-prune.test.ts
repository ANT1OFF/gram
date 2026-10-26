// The start's sweep of the append-only history tables: what is past its window goes, and what
// something still reads stays.
import { describe, expect, it } from "@effect/vitest";
import type { Thread } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqlClient } from "../platform/unstable.ts";
import { DAY_MS } from "../zone-time.ts";
import {
  HELPER_EVENTS_KEPT_MS,
  HELPER_USAGE_KEPT_MS,
  ORCHESTRATION_EVENTS_KEPT_MS,
  pruneHistory,
  SETTINGS_AUDIT_KEPT_MS,
  SETTINGS_AUDIT_KEPT_ROWS,
  ThreadStore,
} from "./thread-store.ts";

const NOW = Date.UTC(2026, 9, 24, 12);

const withStore = <A, E>(effect: Effect.Effect<A, E, ThreadStore | SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(ThreadStore.layerSqlite(":memory:").pipe(Layer.orDie)));

const day = (at: number) => new Date(at).toISOString().slice(0, 10);

describe("pruneHistory", () => {
  it.effect(
    "drops orchestration events past 90 days, but not a living or closed worker's spawn",
    () =>
      withStore(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const store = yield* ThreadStore;
          const project = yield* store.ensureProject({ root: "/work/repo", name: "repo" });
          yield* store.insertThread({
            id: "worker",
            projectId: project.id,
            title: "worker",
            userNamed: false,
            model: { agent: "claude", model: "opus" },
            mode: "default",
            checkout: { kind: "main", path: "/work/repo" },
            labels: [],
            pinned: false,
            parked: false,
            unread: false,
            createdAt: 1,
            lastActivityAt: 1,
          } as unknown as Thread);
          const old = NOW - ORCHESTRATION_EVENTS_KEPT_MS - DAY_MS;
          const recent = NOW - ORCHESTRATION_EVENTS_KEPT_MS + DAY_MS;
          const event = (at: number, kind: string, data: unknown) =>
            sql`INSERT INTO orchestration_events (workspace_id, at, kind, data)
            VALUES ('w', ${at}, ${kind}, ${JSON.stringify(data)})`;
          yield* event(old, "digest", {});
          yield* event(old, "spawn", { threadId: "gone" });
          yield* event(old, "spawn", { threadId: "worker" });
          // A closed worker, which a reopen brings back, keeps its spawn too.
          yield* sql`INSERT INTO closed_threads (thread_id, closed_at, data) VALUES ('closed', 1, '{}')`;
          yield* event(old, "spawn", { threadId: "closed" });
          yield* event(recent, "digest", {});

          yield* pruneHistory(sql, NOW);

          const kept = yield* sql<{ kind: string; data: string }>`SELECT kind, data
          FROM orchestration_events ORDER BY seq`;
          expect(kept.map((row) => [row.kind, JSON.parse(row.data)])).toEqual([
            ["spawn", { threadId: "worker" }],
            ["spawn", { threadId: "closed" }],
            ["digest", {}],
          ]);
        }),
      ),
  );

  it.effect("keeps a year of the settings audit, the newest 1,000, and any still asked", () =>
    withStore(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const audit = (at: number, requestId: string | null) =>
          sql`INSERT INTO settings_audit (at, thread_id, proposer_role, scope, request_id,
              approved_by, approved_at, changes, shown)
            VALUES (${at}, 't', 'agent', 'app', ${requestId}, 'user', ${at}, '[]', '[]')`;
        const old = NOW - SETTINGS_AUDIT_KEPT_MS - DAY_MS;
        // Past a year, and enough of them that the oldest fall outside the newest 1,000. The one
        // asked in a request no longer open goes like the rest.
        yield* audit(old, "answered-request");
        for (let i = 0; i < SETTINGS_AUDIT_KEPT_ROWS + 5; i++) yield* audit(old, null);
        yield* audit(NOW, null);

        yield* pruneHistory(sql, NOW);

        const [counted] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count
          FROM settings_audit`;
        // The newest 1,000, today's among them.
        expect(counted?.count).toBe(SETTINGS_AUDIT_KEPT_ROWS);
        const [latest] = yield* sql<{ newest: number }>`SELECT MAX(at) AS newest
          FROM settings_audit`;
        expect(latest?.newest).toBe(NOW);
      }),
    ),
  );

  it.effect("keeps an old audit entry whose approval request is still open", () =>
    withStore(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* ThreadStore;
        const project = yield* store.ensureProject({ root: "/work/repo", name: "repo" });
        yield* store.insertThread({
          id: "asker",
          projectId: project.id,
          title: "asker",
          userNamed: false,
          model: { agent: "claude", model: "opus" },
          mode: "default",
          checkout: { kind: "main", path: "/work/repo" },
          labels: [],
          pinned: false,
          parked: false,
          unread: false,
          createdAt: 1,
          lastActivityAt: 1,
        } as unknown as Thread);
        yield* sql`INSERT INTO requests (thread_id, id, created_at, request)
          VALUES ('asker', 'still-open', 1, '{}')`;
        const old = NOW - SETTINGS_AUDIT_KEPT_MS - DAY_MS;
        const audit = (requestId: string | null) =>
          sql`INSERT INTO settings_audit (at, thread_id, proposer_role, scope, request_id,
              approved_by, approved_at, changes, shown)
            VALUES (${old}, 'asker', 'agent', 'app', ${requestId}, 'user', ${old}, '[]', '[]')`;
        yield* audit("still-open");
        yield* audit(null);
        // Past the newest-1,000 floor, so only age and the request decide.
        for (let i = 0; i < SETTINGS_AUDIT_KEPT_ROWS; i++)
          yield* sql`INSERT INTO settings_audit (at, thread_id, proposer_role, scope,
              approved_by, approved_at, changes, shown)
            VALUES (${NOW}, 'asker', 'agent', 'app', 'user', ${NOW}, '[]', '[]')`;

        yield* pruneHistory(sql, NOW);

        const kept = yield* sql<{ request_id: string | null }>`SELECT request_id
          FROM settings_audit WHERE at = ${old}`;
        expect(kept.map((row) => row.request_id)).toEqual(["still-open"]);
      }),
    ),
  );

  it.effect("keeps 400 days of helper usage and 30 of helper events", () =>
    withStore(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const usage = (at: number) =>
          sql`INSERT INTO helper_usage (day, kind, model, calls, input_tokens, output_tokens,
              cost_usd, failures)
            VALUES (${day(at)}, 'title', 'm', 1, 1, 1, 0, 0)`;
        const event = (at: number) =>
          sql`INSERT INTO helper_events (day, kind, event, n) VALUES (${day(at)}, 'suggest', 'shown', 1)`;
        yield* usage(NOW - HELPER_USAGE_KEPT_MS - DAY_MS);
        yield* usage(NOW - HELPER_USAGE_KEPT_MS + DAY_MS);
        yield* usage(NOW);
        yield* event(NOW - HELPER_EVENTS_KEPT_MS - DAY_MS);
        yield* event(NOW - 7 * DAY_MS);
        yield* event(NOW);

        yield* pruneHistory(sql, NOW);

        const usageDays = yield* sql<{ day: string }>`SELECT day FROM helper_usage ORDER BY day`;
        expect(usageDays.map((row) => row.day)).toEqual([
          day(NOW - HELPER_USAGE_KEPT_MS + DAY_MS),
          day(NOW),
        ]);
        const eventDays = yield* sql<{ day: string }>`SELECT day FROM helper_events ORDER BY day`;
        expect(eventDays.map((row) => row.day)).toEqual([day(NOW - 7 * DAY_MS), day(NOW)]);
      }),
    ),
  );
});
