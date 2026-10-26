import { SqliteMigrator } from "@effect/sql-sqlite-node";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "../platform/unstable.ts";
import { MIGRATIONS_TABLE, migrationLoader, migrations, migratorOptions } from "./migrations.ts";
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

const tempDir = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "gram-baseline-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
);

describe("migration ordering gate", () => {
  const memory = SqliteClient.layer({ filename: ":memory:" });

  it.effect("the production registry is the baseline, then contiguous ids", () =>
    Effect.gen(function* () {
      const resolved = yield* migrationLoader(migrations);
      expect(resolved.map(([id, name]) => [id, name])).toEqual([[1, "baseline"]]);
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
        "index closed_messages_turn",
        "index closed_turns_started",
        "index closed_turns_thread",
        "index draft_stashes_thread",
        "index dreams_workspace",
        "index messages_search_pending",
        "index messages_thread_rev",
        "index messages_thread_seq",
        "index messages_turn",
        "index orchestration_events_workspace",
        "index thread_outputs_at",
        "index thread_wakes_thread",
        "index turns_started",
        "index turns_thread",
        "index turns_thread_usage",
        "index wait_items_open",
        "index worker_reports_interface",
        "index worker_reports_thread",
        "index worker_reports_workspace",
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
        "table labels",
        "table local_checks",
        "table message_search",
        "table messages",
        "table orchestration_events",
        "table orchestration_outbox",
        "table palettes",
        "table profiles",
        "table projects",
        "table queue_items",
        "table requests",
        "table schema_migrations",
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
        "table usage_limits",
        "table wait_items",
        "table worker_reports",
        "table workspaces",
        "trigger closed_messages_usage_insert",
        "trigger closed_messages_usage_update",
        "trigger helper_outputs_request_deleted",
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
        expect((yield* applied).map((row) => row.name)).toEqual(["baseline"]);
      }).pipe(Effect.provide(ThreadStore.layerSqlite(file)));
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
      const next = {
        ...migrations,
        "0002_example": Effect.gen(function* () {
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
            [1, "baseline"],
            [2, "example"],
          ]);
        }).pipe(Effect.provide(open(next)));
      }
    }),
  );
});
