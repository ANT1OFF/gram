import { DEFAULT_SETTINGS, type HostId, Settings, Thread, type ThreadId } from "@gram/contracts";
import { SqliteMigrator } from "@effect/sql-sqlite-node";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "../platform/unstable.ts";
import { MIGRATIONS_TABLE, migrationLoader, migrations, migratorOptions } from "./migrations.ts";
import { LOCAL_PERSON, personKey } from "../embedding/person.ts";
import { ThreadStore } from "./thread-store.ts";

const tableNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`;
  return new Set(rows.map((r) => r.name));
});

/** Every schema object the app made, by type and name: SQLite's own and FTS5's shadow tables aside. */
const objects = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ type: string; name: string }>`SELECT type, name FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND NOT (type = 'table' AND name GLOB '*_search_*')
    ORDER BY type, name`;
  return rows.map((r) => `${r.type} ${r.name}`);
});

const applied = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ migration_id: number; name: string }>`SELECT migration_id, name
    FROM ${sql(MIGRATIONS_TABLE)} ORDER BY migration_id`;
});

const storedMessage = (parts: ReadonlyArray<unknown>) => JSON.stringify({ parts });

const tempDir = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "gram-baseline-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
);

describe("migration ordering gate", () => {
  const memory = SqliteClient.layer({ filename: ":memory:" });

  it.effect("the production registry is the baseline, then contiguous ids", () =>
    Effect.gen(function* () {
      const resolved = yield* migrationLoader(migrations);
      expect(resolved.map(([id, name]) => [id, name])).toEqual([
        [1, "baseline"],
        [2, "merge_freezes"],
        [3, "message_receipts"],
        [4, "merge_fences"],
        [5, "usage_limit_history"],
        [6, "message_parts"],
        [7, "hosts"],
        [8, "actor_events"],
        [9, "queue_actor"],
        [10, "person_settings"],
      ]);
    }).pipe(
      Effect.provide(SqliteMigrator.layer(migratorOptions({})).pipe(Layer.provideMerge(memory))),
    ),
  );

  for (const [label, record, message] of [
    ["a gap", { "0001_first": Effect.void, "0003_third": Effect.void }, /contiguous/],
    ["a duplicate id", { "0001_first": Effect.void, "0001_other": Effect.void }, /contiguous/],
    ["a malformed key", { first: Effect.void }, /Invalid migration key/],
    ["an id starting at zero", { "0000_first": Effect.void }, /contiguous/],
  ] as const) {
    it.effect(`rejects ${label} before running migrations`, () =>
      Effect.gen(function* () {
        const error = yield* SqliteMigrator.run(migratorOptions(record)).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "MigrationError", kind: "BadState" });
        expect(error.message).toMatch(message);
        expect(yield* applied).toEqual([]);
      }).pipe(Effect.provide(memory)),
    );
  }

  it.effect("rejects a late lower id instead of silently skipping it or running later ids", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const late = {
        "0001_first": Effect.void,
        "0002_late": sql`CREATE TABLE late (id INTEGER)`.pipe(Effect.asVoid),
        "0003_third": Effect.void,
        "0004_next": sql`CREATE TABLE next (id INTEGER)`.pipe(Effect.asVoid),
      };
      yield* SqliteMigrator.run({
        loader: SqliteMigrator.fromRecord({
          "0001_first": late["0001_first"],
          "0003_third": late["0003_third"],
        }),
        table: MIGRATIONS_TABLE,
      });
      const error = yield* SqliteMigrator.run(migratorOptions(late)).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "MigrationError",
        kind: "BadState",
        message: expect.stringContaining(
          "2_late was not applied, but the database is already at 3",
        ),
      });
      expect(error.message).toContain(
        "appending a repair migration alone will still fail this check",
      );
      expect((yield* tableNames).has("late")).toBe(false);
      expect((yield* tableNames).has("next")).toBe(false);
      expect((yield* applied).map((row) => row.migration_id)).toEqual([1, 3]);
    }).pipe(Effect.provide(memory)),
  );

  it.effect("rejects reuse of an applied id by a differently named migration", () =>
    Effect.gen(function* () {
      yield* SqliteMigrator.run(migratorOptions({ "0001_first": Effect.void }));
      const error = yield* SqliteMigrator.run(migratorOptions({ "0001_other": Effect.void })).pipe(
        Effect.flip,
      );
      expect(error).toMatchObject({
        _tag: "MigrationError",
        kind: "BadState",
        message: expect.stringContaining("1_other conflicts with applied migration 1_first"),
      });
    }).pipe(Effect.provide(memory)),
  );
});

describe("the baseline", () => {
  it.effect("creates the 1.0 schema whole and records itself as migration 1", () =>
    Effect.gen(function* () {
      expect(yield* objects).toEqual([
        "index actor_events_thread",
        "index closed_messages_turn",
        "index closed_turns_started",
        "index closed_turns_thread",
        "index draft_stashes_thread",
        "index dreams_workspace",
        "index message_parts_thread_type",
        "index message_receipts_pending",
        "index message_receipts_responses",
        "index messages_search_pending",
        "index messages_thread_rev",
        "index messages_thread_seq",
        "index messages_turn",
        "index orchestration_events_workspace",
        "index session_leases_host",
        "index thread_outputs_at",
        "index thread_wakes_thread",
        "index threads_host",
        "index turns_started",
        "index turns_thread",
        "index turns_thread_usage",
        "index usage_credit_history_bucket",
        "index usage_limit_history_bucket",
        "index wait_items_open",
        "index worker_reports_interface",
        "index worker_reports_thread",
        "index worker_reports_workspace",
        "table actor_events",
        "table automatic_dream",
        "table closed_messages",
        "table closed_threads",
        "table closed_turns",
        "table draft_stashes",
        "table dream_watermarks",
        "table dreams",
        "table feature_cards",
        "table feed_revision",
        "table helper_events",
        "table helper_outputs",
        "table helper_usage",
        "table hosts",
        "table labels",
        "table local_checks",
        "table merge_fences",
        "table merge_freezes",
        "table message_parts",
        "table message_receipts",
        "table message_search",
        "table messages",
        "table orchestration_events",
        "table orchestration_outbox",
        "table palettes",
        "table person_settings",
        "table profiles",
        "table projects",
        "table queue_items",
        "table requests",
        "table schema_migrations",
        "table session_leases",
        "table settings",
        "table settings_audit",
        "table tasks",
        "table thread_outputs",
        "table thread_plans",
        "table thread_title_search",
        "table thread_wakes",
        "table threads",
        "table threads_version",
        "table turns",
        "table usage_credit_history",
        "table usage_limit_history",
        "table usage_limits",
        "table wait_items",
        "table worker_reports",
        "table workspaces",
        "trigger closed_messages_usage_insert",
        "trigger closed_messages_usage_update",
        "trigger helper_outputs_request_deleted",
        "trigger messages_parts_delete",
        "trigger messages_parts_insert",
        "trigger messages_parts_update",
        "trigger messages_search_delete",
        "trigger messages_search_insert",
        "trigger messages_search_update",
        "trigger messages_usage_insert",
        "trigger messages_usage_update",
        "trigger threads_search_delete",
        "trigger threads_search_insert",
        "trigger threads_search_update",
        "trigger threads_version_delete",
        "trigger threads_version_insert",
        "trigger threads_version_update",
      ]);
      expect((yield* applied).map((row) => [row.migration_id, row.name])).toEqual([
        [1, "baseline"],
        [2, "merge_freezes"],
        [3, "message_receipts"],
        [4, "merge_fences"],
        [5, "usage_limit_history"],
        [6, "message_parts"],
        [7, "hosts"],
        [8, "actor_events"],
        [9, "queue_actor"],
        [10, "person_settings"],
      ]);
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT id, rev FROM feed_revision`).toEqual([{ id: 0, rev: 0 }]);
      expect(yield* sql`SELECT id, length(token) AS bytes FROM threads_version`).toEqual([
        { id: 0, bytes: 16 },
      ]);
    }).pipe(Effect.provide(ThreadStore.layerSqlite(":memory:"))),
  );

  it.effect("runs once: a reopened database keeps its rows and runs nothing again", () =>
    Effect.gen(function* () {
      const file = join(yield* tempDir, "gram.db");
      yield* Effect.gen(function* () {
        const store = yield* ThreadStore;
        yield* store.ensureProject({ root: "/invented/baseline", name: "baseline" });
      }).pipe(Effect.provide(ThreadStore.layerSqlite(file)));
      yield* Effect.gen(function* () {
        const store = yield* ThreadStore;
        expect((yield* store.listProjects).map((p) => p.root)).toEqual(["/invented/baseline"]);
        expect((yield* applied).map((row) => row.name)).toEqual([
          "baseline",
          "merge_freezes",
          "message_receipts",
          "merge_fences",
          "usage_limit_history",
          "message_parts",
          "hosts",
          "actor_events",
          "queue_actor",
          "person_settings",
        ]);
      }).pipe(Effect.provide(ThreadStore.layerSqlite(file)));
    }),
  );

  it.effect("upgrades the previous 0002 database to receipts without replacing existing data", () =>
    Effect.gen(function* () {
      const file = join(yield* tempDir, "upgrade-receipts.db");
      const open = (record: Parameters<typeof migratorOptions>[0]) =>
        SqliteMigrator.layer(migratorOptions(record)).pipe(
          Layer.provideMerge(SqliteClient.layer({ filename: file })),
        );
      const previous = {
        "0001_baseline": migrations["0001_baseline"],
        "0002_merge_freezes": migrations["0002_merge_freezes"],
      };
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projects(id, root, name) VALUES ('prior-project', '/synthetic/upgrade', 'before receipts')`;
        expect((yield* applied).map((row) => row.migration_id)).toEqual([1, 2]);
        expect(yield* sql`SELECT name FROM sqlite_master WHERE name = 'message_receipts'`).toEqual(
          [],
        );
      }).pipe(Effect.provide(open(previous)));
      for (let reopen = 0; reopen < 2; reopen++) {
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          expect(yield* sql`SELECT id, name FROM projects`).toEqual([
            { id: "prior-project", name: "before receipts" },
          ]);
          expect((yield* applied).map((row) => [row.migration_id, row.name])).toEqual([
            [1, "baseline"],
            [2, "merge_freezes"],
            [3, "message_receipts"],
            [4, "merge_fences"],
            [5, "usage_limit_history"],
            [6, "message_parts"],
            [7, "hosts"],
            [8, "actor_events"],
            [9, "queue_actor"],
            [10, "person_settings"],
          ]);
          // A closed thread has no live row, but must retain its permanent safety identity.
          if (reopen === 0) {
            yield* sql`INSERT INTO message_receipts(thread_id, client_message_id, fingerprint, retired)
              VALUES ('closed-thread', 'old-client-id', 'synthetic', 1)`;
          }
          expect(yield* sql`SELECT client_message_id, retired FROM message_receipts`).toEqual([
            { client_message_id: "old-client-id", retired: 1 },
          ]);
        }).pipe(Effect.provide(open(migrations)));
      }
    }),
  );

  it.effect(
    "upgrades the previous 0003 database to merge fences and preserves its data on reopen",
    () =>
      Effect.gen(function* () {
        const file = join(yield* tempDir, "previous-to-fences.db");
        const closed = Schema.decodeUnknownSync(Thread)({
          id: "closed-worker",
          projectId: "upgrade-project",
          title: "prior closed worker",
          userNamed: false,
          model: { agent: "claude", model: "synthetic" },
          mode: "default",
          checkout: { kind: "main", path: "/invented/previous-schema" },
          labels: [],
          pinned: false,
          parked: false,
          unread: false,
          createdAt: 1,
          lastActivityAt: 1,
        });
        const fence = {
          key: "synthetic-base",
          moved: [],
          pending: {
            pr: { repo: "example/project", number: 5 },
            threadId: "upgrade-worker" as ThreadId,
            head: "expected-head",
            tip: "checked-tip",
            at: 1,
          },
        };
        const entries = Object.entries(migrations);
        // By name, not position: later migrations append after it.
        const index = entries.findIndex(([key]) => /^\d+_merge_fences$/.test(key));
        expect(index).toBeGreaterThan(0);
        const previous = Object.fromEntries(entries.slice(0, index));
        const previousId = Number(entries[index]![0].split("_")[0]) - 1;
        const open = (record: Parameters<typeof migratorOptions>[0]) =>
          SqliteMigrator.layer(migratorOptions(record)).pipe(
            Layer.provideMerge(SqliteClient.layer({ filename: file })),
          );
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          expect((yield* applied).at(-1)?.migration_id).toBe(previousId);
          expect((yield* tableNames).has("merge_fences")).toBe(false);
          yield* sql`INSERT INTO projects (id, root, name) VALUES ('upgrade-project', '/invented/previous-schema', 'preserved')`;
          yield* sql`INSERT INTO local_checks (key, data) VALUES ('older-pass', '{"synthetic":"retained"}')`;
          yield* sql`INSERT INTO closed_threads(thread_id, closed_at, data)
            VALUES (${closed.id}, 1, ${JSON.stringify(closed)})`;
          yield* sql`INSERT INTO message_receipts(thread_id, client_message_id, fingerprint, retired)
            VALUES ('closed-worker', 'prior-retry', 'synthetic-prior-receipt', 1)`;
        }).pipe(Effect.provide(open(previous)));
        for (let reopen = 0; reopen < 2; reopen++) {
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            expect((yield* applied).map((r) => [r.migration_id, r.name])).toEqual(
              entries.map(([key]) => {
                const [id, ...name] = key.split("_");
                return [Number(id), name.join("_")];
              }),
            );
            expect(
              yield* sql`SELECT root, name FROM projects WHERE id = 'upgrade-project'`,
            ).toEqual([{ root: "/invented/previous-schema", name: "preserved" }]);
            expect(yield* sql`SELECT data FROM local_checks WHERE key = 'older-pass'`).toEqual([
              { data: '{"synthetic":"retained"}' },
            ]);
            expect(
              yield* sql`SELECT client_message_id, fingerprint, retired FROM message_receipts`,
            ).toEqual([
              {
                client_message_id: "prior-retry",
                fingerprint: "synthetic-prior-receipt",
                retired: 1,
              },
            ]);
            expect((yield* tableNames).has("merge_fences")).toBe(true);
            const store = yield* ThreadStore;
            if (reopen === 0) yield* store.putMergeFence(fence);
            expect(yield* store.listMergeFences).toEqual([fence]);
          }).pipe(Effect.provide(ThreadStore.layerSqlite(file)));
        }
      }),
  );

  it.effect(
    "a reopened database keeps unresolved fences and moved tips independently of threads",
    () =>
      Effect.gen(function* () {
        const file = join(yield* tempDir, "fences.db");
        const record = {
          key: "example/project\u0000main",
          moved: ["old-tip"],
          pending: {
            pr: { repo: "example/project", number: 5 },
            head: "expected-head",
            threadId: "invented-worker" as ThreadId,
            tip: "checked-tip",
            at: 1,
          },
        };
        yield* Effect.gen(function* () {
          const store = yield* ThreadStore;
          yield* store.putMergeFence(record);
        }).pipe(Effect.provide(ThreadStore.layerSqlite(file)));
        yield* Effect.gen(function* () {
          const store = yield* ThreadStore;
          expect(yield* store.listMergeFences).toEqual([record]);
          yield* store.putMergeFence({
            key: record.key,
            moved: [...record.moved, record.pending.tip],
          });
        }).pipe(Effect.provide(ThreadStore.layerSqlite(file)));
        yield* Effect.gen(function* () {
          const store = yield* ThreadStore;
          expect(yield* store.listMergeFences).toEqual([
            { key: record.key, moved: ["old-tip", "checked-tip"] },
          ]);
        }).pipe(Effect.provide(ThreadStore.layerSqlite(file)));
      }),
  );

  it.effect("upgrades the previous 0004 database to limit history, keeping kept readings", () =>
    Effect.gen(function* () {
      const file = join(yield* tempDir, "previous-to-limit-history.db");
      const entries = Object.entries(migrations);
      const index = entries.findIndex(([key]) => /^\d+_usage_limit_history$/.test(key));
      expect(index).toBeGreaterThan(0);
      const previous = Object.fromEntries(entries.slice(0, index));
      const open = (record: Parameters<typeof migratorOptions>[0]) =>
        SqliteMigrator.layer(migratorOptions(record)).pipe(
          Layer.provideMerge(SqliteClient.layer({ filename: file })),
        );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        expect((yield* applied).at(-1)?.name).toBe("merge_fences");
        expect((yield* tableNames).has("usage_limit_history")).toBe(false);
        yield* sql`INSERT INTO usage_limits (key, data) VALUES ('codex//five_hour', '{"synthetic":true}')`;
        // What 0003 and 0004 keep, so an edit to 0005 that touched their tables would fail here.
        yield* sql`INSERT INTO message_receipts(thread_id, client_message_id, fingerprint, retired)
          VALUES ('synthetic-thread', 'synthetic-client-id', 'synthetic-print', 1)`;
        yield* sql`INSERT INTO merge_fences (key, data) VALUES ('synthetic-base', '{"synthetic":true}')`;
      }).pipe(Effect.provide(open(previous)));
      for (let reopen = 0; reopen < 2; reopen++) {
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          expect((yield* applied).map((row) => row.name).slice(-7)).toEqual([
            "merge_fences",
            "usage_limit_history",
            "message_parts",
            "hosts",
            "actor_events",
            "queue_actor",
            "person_settings",
          ]);
          expect(yield* sql`SELECT key, data FROM usage_limits`).toEqual([
            { key: "codex//five_hour", data: '{"synthetic":true}' },
          ]);
          expect(
            yield* sql`SELECT thread_id, client_message_id, fingerprint, retired FROM message_receipts`,
          ).toEqual([
            {
              thread_id: "synthetic-thread",
              client_message_id: "synthetic-client-id",
              fingerprint: "synthetic-print",
              retired: 1,
            },
          ]);
          expect(yield* sql`SELECT key, data FROM merge_fences`).toEqual([
            { key: "synthetic-base", data: '{"synthetic":true}' },
          ]);
          if (reopen === 0) {
            yield* sql`INSERT INTO usage_limit_history
              (agent, limit_window, bucket, window_id, utilization, peak, resets_at)
              VALUES ('codex', 'five_hour', 900000, 1, 0.4, 0.5, NULL)`;
            yield* sql`INSERT INTO usage_credit_history (agent, bucket, balance, spent, added)
              VALUES ('codex', 900000, 1250, 0, 0)`;
          }
          expect(
            yield* sql`SELECT agent, limit_window, bucket, utilization, peak, resets_at
            FROM usage_limit_history`,
          ).toEqual([
            {
              agent: "codex",
              limit_window: "five_hour",
              bucket: 900000,
              utilization: 0.4,
              peak: 0.5,
              resets_at: null,
            },
          ]);
          expect(yield* sql`SELECT agent, bucket, balance FROM usage_credit_history`).toEqual([
            { agent: "codex", bucket: 900000, balance: 1250 },
          ]);
        }).pipe(Effect.provide(open(migrations)));
      }
    }),
  );

  it.effect("upgrades the previous 0005 database to part types, indexing its stored messages", () =>
    Effect.gen(function* () {
      const file = join(yield* tempDir, "previous-to-message-parts.db");
      const entries = Object.entries(migrations);
      const index = entries.findIndex(([key]) => /^\d+_message_parts$/.test(key));
      expect(index).toBeGreaterThan(0);
      const previous = Object.fromEntries(entries.slice(0, index));
      const open = (record: Parameters<typeof migratorOptions>[0]) =>
        SqliteMigrator.layer(migratorOptions(record)).pipe(
          Layer.provideMerge(SqliteClient.layer({ filename: file })),
        );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        expect((yield* tableNames).has("message_parts")).toBe(false);
        yield* sql`INSERT INTO projects(id, root, name) VALUES ('p', '/synthetic/parts', 'parts')`;
        yield* sql`INSERT INTO threads(id, project_id, created_at, last_activity_at, data)
          VALUES ('t', 'p', 0, 0, '{}')`;
        yield* sql`INSERT INTO messages(thread_id, id, seq, role, message) VALUES
          ('t', 'u1', 1, 'user', ${storedMessage([{ type: "text" }, { type: "file" }, { type: "file" }])}),
          ('t', 'a1', 2, 'assistant', ${storedMessage([{ type: "data-handoff" }])}),
          ('t', 'bad', 3, 'assistant', 'not json')`;
      }).pipe(Effect.provide(open(previous)));
      for (let reopen = 0; reopen < 2; reopen++) {
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          expect((yield* applied).map((row) => row.name)).toContain("message_parts");
          expect(
            yield* sql`SELECT m.id, p.type FROM message_parts p
              JOIN messages m ON m.rowid = p.message_rowid ORDER BY m.seq, p.type`,
          ).toEqual([
            { id: "u1", type: "file" },
            { id: "u1", type: "text" },
            { id: "a1", type: "data-handoff" },
          ]);
        }).pipe(Effect.provide(open(migrations)));
      }
    }),
  );

  it.effect("takes a 1.x migration appended after it, once, on a database it made", () =>
    Effect.gen(function* () {
      const file = join(yield* tempDir, "gram.db");
      const open = (record: Parameters<typeof migratorOptions>[0]) =>
        SqliteMigrator.layer(migratorOptions(record)).pipe(
          Layer.provideMerge(SqliteClient.layer({ filename: file })),
        );
      yield* Effect.void.pipe(Effect.provide(open(migrations)));
      // The next free id, whatever the registry has grown to, so this outlives each new migration.
      const shipped = Object.keys(migrations).map((key) => {
        const [id, ...name] = key.split("_");
        return [Number(id), name.join("_")] as const;
      });
      const nextId = shipped.length + 1;
      const next = {
        ...migrations,
        [`${String(nextId).padStart(4, "0")}_example`]: Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`ALTER TABLE projects ADD COLUMN example TEXT`;
        }),
      };
      for (let reopen = 0; reopen < 2; reopen++) {
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const columns = yield* sql<{
            name: string;
          }>`SELECT name FROM pragma_table_info('projects')`;
          expect(columns.map((c) => c.name)).toContain("example");
          expect((yield* applied).map((row) => [row.migration_id, row.name])).toEqual([
            ...shipped,
            [nextId, "example"],
          ]);
        }).pipe(Effect.provide(open(next)));
      }
    }),
  );
  it.effect(
    "upgrades the database before a person's own settings: the saved pane grid is the local person's",
    () =>
      Effect.gen(function* () {
        const file = join(yield* tempDir, "previous-to-person-settings.db");
        const entries = Object.entries(migrations);
        // By name, not position: later migrations append after it.
        const index = entries.findIndex(([key]) => /^\d+_person_settings$/.test(key));
        expect(index).toBeGreaterThan(0);
        const previous = Object.fromEntries(entries.slice(0, index));
        const open = (record: Parameters<typeof migratorOptions>[0]) =>
          SqliteMigrator.layer(migratorOptions(record)).pipe(
            Layer.provideMerge(SqliteClient.layer({ filename: file })),
          );
        const grid = { preset: "2c", panes: ["t-left", "t-right"], colFr: [2, 1], focused: 1 };
        const saved = JSON.stringify({
          ...Schema.encodeSync(Settings)(DEFAULT_SETTINGS),
          layout: { grid, focusMode: true },
        });
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          expect((yield* tableNames).has("person_settings")).toBe(false);
          yield* sql`INSERT INTO settings (key, value) VALUES ('app', ${saved})`;
        }).pipe(Effect.provide(open(previous)));
        for (let reopen = 0; reopen < 2; reopen++) {
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            // The shared row is as it was, and the grid is now the local person's own.
            expect(yield* sql`SELECT value FROM settings WHERE key = 'app'`).toEqual([
              { value: saved },
            ]);
            expect(yield* sql`SELECT person, key, value FROM person_settings`).toEqual([
              { person: "local", key: "layout.grid", value: JSON.stringify(grid) },
            ]);
          }).pipe(Effect.provide(open(migrations)));
        }
        // The app reads it back as the desktop's one person, and nobody else is given it.
        yield* Effect.gen(function* () {
          const store = yield* ThreadStore;
          expect((yield* store.getSettingsFor(LOCAL_PERSON)).layout).toEqual({
            grid,
            focusMode: true,
          });
          expect((yield* store.getSettingsFor(personKey("someone-else"))).layout).toEqual({
            focusMode: true,
          });
        }).pipe(Effect.provide(ThreadStore.layerSqlite(file)));
      }),
  );
  it.effect("upgrades a database with no saved grid, or a row it can't read, to no rows", () =>
    Effect.gen(function* () {
      const entries = Object.entries(migrations);
      const index = entries.findIndex(([key]) => /^\d+_person_settings$/.test(key));
      const previous = Object.fromEntries(entries.slice(0, index));
      for (const [name, value] of [
        ["none", JSON.stringify({ layout: { focusMode: true } })],
        ["unreadable", "{not json"],
        ["cleared", JSON.stringify({ layout: { grid: null } })],
      ] as const) {
        const file = join(yield* tempDir, `person-settings-${name}.db`);
        const open = (record: Parameters<typeof migratorOptions>[0]) =>
          SqliteMigrator.layer(migratorOptions(record)).pipe(
            Layer.provideMerge(SqliteClient.layer({ filename: file })),
          );
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO settings (key, value) VALUES ('app', ${value})`;
        }).pipe(Effect.provide(open(previous)));
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          expect(yield* sql`SELECT person FROM person_settings`).toEqual([]);
        }).pipe(Effect.provide(open(migrations)));
      }
    }),
  );
  it.effect(
    "upgrades the database before hosts: every thread is on this machine: every thread is on this machine",
    () =>
      Effect.gen(function* () {
        const file = join(yield* tempDir, "previous-to-hosts.db");
        const entries = Object.entries(migrations);
        // By name, not position: later migrations append after it.
        const index = entries.findIndex(([key]) => /^\d+_hosts$/.test(key));
        expect(index).toBeGreaterThan(0);
        const previous = Object.fromEntries(entries.slice(0, index));
        const open = (record: Parameters<typeof migratorOptions>[0]) =>
          SqliteMigrator.layer(migratorOptions(record)).pipe(
            Layer.provideMerge(SqliteClient.layer({ filename: file })),
          );
        const prior = Schema.decodeUnknownSync(Thread)({
          id: "prior-thread",
          projectId: "hosts-project",
          title: "written before hosts",
          userNamed: false,
          model: { agent: "claude", model: "synthetic" },
          mode: "default",
          checkout: { kind: "main", path: "/invented/before-hosts" },
          labels: [],
          pinned: false,
          parked: false,
          unread: false,
          createdAt: 1,
          lastActivityAt: 1,
        });
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          expect((yield* tableNames).has("hosts")).toBe(false);
          yield* sql`INSERT INTO projects (id, root, name) VALUES ('hosts-project', '/invented/before-hosts', 'kept')`;
          yield* sql`INSERT INTO threads (id, project_id, created_at, last_activity_at, data)
          VALUES (${prior.id}, 'hosts-project', 1, 1, ${JSON.stringify(prior)})`;
        }).pipe(Effect.provide(open(previous)));
        for (let reopen = 0; reopen < 2; reopen++) {
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            expect((yield* applied).at(-1)?.name).toBe(entries.at(-1)![0].replace(/^\d+_/, ""));
            expect(yield* sql`SELECT id, host_id FROM threads ORDER BY id`).toEqual(
              reopen === 0
                ? [{ id: "prior-thread", host_id: "local" }]
                : [
                    { id: "prior-thread", host_id: "local" },
                    { id: "remote-thread", host_id: "tower" },
                  ],
            );
            const store = yield* ThreadStore;
            const read = yield* store.getThread(prior.id);
            expect(read.checkout).toEqual({ kind: "main", path: "/invented/before-hosts" });
            if (reopen === 0) {
              // A checkout on another machine projects its host into the column; one with none stays local.
              yield* store.insertThread({
                ...prior,
                id: "remote-thread" as ThreadId,
                checkout: { kind: "main", path: "/invented/on-tower", hostId: "tower" as HostId },
              });
              yield* sql`INSERT INTO session_leases (thread_id, host_id, epoch, leased_at)
              VALUES ('remote-thread', 'tower', 1, 1)`;
            }
            expect(
              yield* sql`SELECT thread_id, host_id, epoch FROM session_leases ORDER BY thread_id`,
            ).toEqual([{ thread_id: "remote-thread", host_id: "tower", epoch: 1 }]);
          }).pipe(Effect.provide(ThreadStore.layerSqlite(file)));
        }
      }),
  );
});
