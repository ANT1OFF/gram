import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqlClient } from "../platform/unstable.ts";
import { DATABASE_FILE, serverDatabaseFile } from "./database-file.ts";
import { MIGRATIONS_TABLE } from "./migrations.ts";
import { ThreadStore } from "./thread-store.ts";

const tempDir = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "gram-database-file-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
);

/**
 * A data directory as a 0.x build leaves it after a crash: `gram.db` with the migrator's
 * bookkeeping, a row only its WAL holds, and the shared memory that indexes the WAL. Copied while
 * the writer is open, so all three files are there. Synthetic rows only.
 */
const preOneAt = (dir: string) => {
  const scratch = mkdtempSync(join(tmpdir(), "gram-database-file-scratch-"));
  const source = join(scratch, "gram.db");
  const db = new DatabaseSync(source);
  try {
    db.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY NOT NULL,
        name VARCHAR(255) NOT NULL);
      INSERT INTO effect_sql_migrations (migration_id, name) VALUES (1, 'initial');
      CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL);
      PRAGMA wal_checkpoint(TRUNCATE);
      INSERT INTO threads (id, title) VALUES ('t-old', 'only in the WAL');`);
    for (const suffix of ["", "-wal", "-shm"]) {
      copyFileSync(`${source}${suffix}`, join(dir, `gram.db${suffix}`));
    }
  } finally {
    db.close();
    rmSync(scratch, { recursive: true, force: true });
  }
};

const hashes = (dir: string) =>
  Object.fromEntries(
    ["gram.db", "gram.db-wal", "gram.db-shm"].map((name) => [
      name,
      createHash("sha256")
        .update(readFileSync(join(dir, name)))
        .digest("hex"),
    ]),
  );

/** Starts the store where the server would in `dir`, keeping what it logs. */
const start = (dir: string) =>
  Effect.gen(function* () {
    const lines: Array<Record<string, unknown>> = [];
    const capture = Logger.make(({ message, fiber }) => {
      lines.push({ message, ...fiber.getRef(References.CurrentLogAnnotations) });
    });
    const opened = yield* Effect.gen(function* () {
      const file = yield* serverDatabaseFile(dir);
      return yield* Effect.gen(function* () {
        const store = yield* ThreadStore;
        const sql = yield* SqlClient.SqlClient;
        const tables = yield* sql<{
          name: string;
        }>`SELECT name FROM sqlite_master WHERE type = 'table'`;
        return {
          file,
          threads: yield* store.listThreads,
          tables: new Set(tables.map((t) => t.name)),
        };
      }).pipe(Effect.provide(ThreadStore.layerSqlite(file)));
    }).pipe(Effect.provide(Logger.layer([capture])));
    return { ...opened, lines };
  });

describe("the server's database file", () => {
  it.effect("is a new one the baseline makes in a fresh data directory", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const started = yield* start(dir);
      expect(started.file).toBe(join(dir, DATABASE_FILE));
      expect(started.tables.has(MIGRATIONS_TABLE)).toBe(true);
      expect(started.threads).toEqual([]);
      expect(started.lines).toEqual([]);
      expect(readdirSync(dir).filter((name) => !name.startsWith(DATABASE_FILE))).toEqual([]);
    }),
  );

  it.effect("starts beside a 0.x database, leaving its files byte for byte as they were", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      preOneAt(dir);
      const before = hashes(dir);
      const started = yield* start(dir);

      expect(started.file).toBe(join(dir, DATABASE_FILE));
      expect(started.tables.has(MIGRATIONS_TABLE)).toBe(true);
      expect(started.tables.has("effect_sql_migrations")).toBe(false);
      expect(started.threads).toEqual([]);
      expect(started.lines).toEqual([
        {
          message: ["Gram 1.0 starts with a new database; the 0.x one beside it is left untouched"],
          database: join(dir, DATABASE_FILE),
          untouched: join(dir, "gram.db"),
        },
      ]);
      // Not opened, so not even the shared memory's read marks moved.
      expect(hashes(dir)).toEqual(before);
      expect(
        readdirSync(dir)
          .filter((name) => !name.startsWith(DATABASE_FILE))
          .toSorted(),
      ).toEqual(["gram.db", "gram.db-shm", "gram.db-wal"]);

      // And again: the new database is the one that opens, with what the first start wrote.
      const again = yield* start(dir);
      expect(again.tables.has(MIGRATIONS_TABLE)).toBe(true);
      expect(hashes(dir)).toEqual(before);
    }),
  );
});
