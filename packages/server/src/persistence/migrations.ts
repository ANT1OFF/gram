import { SqliteMigrator } from "@effect/sql-sqlite-node";
import * as Effect from "effect/Effect";
import { SqlClient } from "../platform/unstable.ts";
import { searchSchema } from "../search/schema.ts";
import { usageSchema } from "../usage/schema.ts";

/** The table that records which migrations a database has run. */
export const MIGRATIONS_TABLE = "schema_migrations";

const baseline = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    root TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    repo_root TEXT,
    bookmarked INTEGER NOT NULL DEFAULT 0,
    last_opened_at INTEGER,
    local_check TEXT
  )`;
  yield* sql`CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    agent_session_id TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    parked INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL,
    data TEXT NOT NULL,
    completed_reason TEXT,
    feed_rev INTEGER NOT NULL DEFAULT 0,
    feed_reset_rev INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE TABLE messages (
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    turn_id TEXT,
    message TEXT NOT NULL,
    rev INTEGER NOT NULL DEFAULT 0,
    usage_metadata TEXT,
    search_pending INTEGER,
    PRIMARY KEY (thread_id, id)
  )`;
  yield* sql`CREATE UNIQUE INDEX messages_thread_seq ON messages(thread_id, seq)`;
  yield* sql`CREATE INDEX messages_thread_rev ON messages(thread_id, rev)`;
  yield* sql`CREATE INDEX messages_turn ON messages(turn_id, thread_id)`;
  yield* sql`CREATE TABLE turns (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    reason TEXT,
    usage TEXT,
    cost_usd REAL,
    checkpoint_ref TEXT
  )`;
  yield* sql`CREATE INDEX turns_thread ON turns(thread_id, started_at)`;
  yield* sql`CREATE INDEX turns_started ON turns(started_at)`;
  yield* sql`CREATE INDEX turns_thread_usage ON turns(thread_id, ended_at)
    WHERE ended_at IS NOT NULL AND usage IS NOT NULL`;
  yield* sql`CREATE TABLE requests (
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    request TEXT NOT NULL,
    PRIMARY KEY (thread_id, id)
  )`;
  yield* sql`CREATE TABLE tasks (
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (thread_id, id)
  )`;
  yield* sql`CREATE TABLE queue_items (
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    position INTEGER NOT NULL,
    input TEXT NOT NULL,
    notice_key TEXT,
    turn_id TEXT,
    PRIMARY KEY (thread_id, id)
  )`;
  yield* sql`CREATE TABLE draft_stashes (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    data TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX draft_stashes_thread ON draft_stashes(thread_id, created_at)`;

  yield* sql`CREATE TABLE closed_threads (
    thread_id TEXT PRIMARY KEY,
    closed_at INTEGER NOT NULL,
    data TEXT NOT NULL,
    workers TEXT
  )`;
  yield* sql`CREATE TABLE closed_messages (
    thread_id TEXT NOT NULL,
    id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    turn_id TEXT,
    message TEXT NOT NULL,
    usage_metadata TEXT,
    PRIMARY KEY (thread_id, id)
  )`;
  yield* sql`CREATE INDEX closed_messages_turn ON closed_messages(turn_id, thread_id)`;
  yield* sql`CREATE TABLE closed_turns (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    reason TEXT,
    usage TEXT,
    cost_usd REAL,
    checkpoint_ref TEXT
  )`;
  yield* sql`CREATE INDEX closed_turns_thread ON closed_turns(thread_id)`;
  yield* sql`CREATE INDEX closed_turns_started ON closed_turns(started_at)`;

  yield* sql`CREATE TABLE feed_revision (
    id INTEGER PRIMARY KEY CHECK (id = 0),
    rev INTEGER NOT NULL
  )`;
  yield* sql`INSERT INTO feed_revision (id, rev) VALUES (0, 0)`;
  yield* sql`CREATE TABLE threads_version (
    id INTEGER PRIMARY KEY CHECK (id = 0),
    token BLOB NOT NULL
  )`;
  yield* sql`INSERT INTO threads_version (id, token) VALUES (0, randomblob(16))`;
  for (const [name, event] of [
    ["insert", "INSERT"],
    ["update", "UPDATE OF id, data, sort_order, created_at"],
    ["delete", "DELETE"],
  ] as const)
    yield* sql.unsafe(`CREATE TRIGGER threads_version_${name} AFTER ${event} ON threads BEGIN
      UPDATE threads_version SET token = randomblob(16);
    END`);

  yield* sql`CREATE TABLE thread_plans (
    thread_id TEXT PRIMARY KEY,
    plan TEXT,
    turn_plan TEXT,
    rev INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE TABLE wait_items (
    thread_id TEXT NOT NULL,
    id TEXT NOT NULL,
    message_id TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    told_at INTEGER,
    item TEXT NOT NULL,
    PRIMARY KEY (thread_id, id)
  )`;
  yield* sql`CREATE INDEX wait_items_open ON wait_items (thread_id) WHERE resolved_at IS NULL`;
  yield* sql`CREATE TABLE thread_wakes (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    set_at INTEGER NOT NULL,
    note TEXT NOT NULL,
    pr TEXT
  )`;
  yield* sql`CREATE INDEX thread_wakes_thread ON thread_wakes (thread_id)`;
  yield* sql`CREATE TABLE thread_outputs (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    at INTEGER NOT NULL,
    UNIQUE (thread_id, path)
  )`;
  yield* sql`CREATE INDEX thread_outputs_at ON thread_outputs(at, seq)`;

  yield* sql`CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE labels (
    id TEXT PRIMARY KEY,
    sort_order INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE palettes (
    id TEXT PRIMARY KEY,
    builtin INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE profiles (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE settings_audit (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    thread_id TEXT NOT NULL,
    proposer_role TEXT NOT NULL,
    scope TEXT NOT NULL,
    workspace_id TEXT,
    request_id TEXT,
    approved_by TEXT NOT NULL,
    approved_at INTEGER NOT NULL,
    changes TEXT NOT NULL,
    shown TEXT NOT NULL,
    reason TEXT,
    project_id TEXT
  )`;

  yield* sql`CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    orchestrator_thread_id TEXT UNIQUE,
    created_at INTEGER NOT NULL,
    data TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE worker_reports (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    data TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX worker_reports_workspace ON worker_reports(workspace_id, seq)`;
  yield* sql`CREATE INDEX worker_reports_thread ON worker_reports(workspace_id, thread_id, seq)`;
  yield* sql`CREATE INDEX worker_reports_interface ON worker_reports(workspace_id, thread_id, seq)
    WHERE json_extract(data, '$.interface') IS NOT NULL`;
  yield* sql`CREATE TABLE orchestration_outbox (
    workspace_id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE orchestration_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    data TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX orchestration_events_workspace
    ON orchestration_events(workspace_id, at)`;
  yield* sql`CREATE TABLE feature_cards (
    workspace_id TEXT NOT NULL,
    feature TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (workspace_id, feature)
  )`;

  yield* sql`CREATE TABLE dreams (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    thread_id TEXT,
    created_at INTEGER NOT NULL,
    data TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX dreams_workspace ON dreams(workspace_id, created_at)`;
  yield* sql`CREATE TABLE dream_watermarks (
    workspace_id TEXT NOT NULL,
    memory_version TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (workspace_id, memory_version, thread_id)
  )`;
  yield* sql`CREATE TABLE automatic_dream (workspace_id TEXT PRIMARY KEY, data TEXT NOT NULL)`;

  yield* sql`CREATE TABLE helper_usage (
    day TEXT NOT NULL,
    kind TEXT NOT NULL,
    model TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, kind, model)
  )`;
  yield* sql`CREATE TABLE helper_outputs (
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    request_id TEXT NOT NULL DEFAULT '',
    basis TEXT NOT NULL,
    prompt_version INTEGER NOT NULL,
    model TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (thread_id, kind, request_id)
  )`;
  yield* sql`CREATE TRIGGER helper_outputs_request_deleted AFTER DELETE ON requests BEGIN
    DELETE FROM helper_outputs
    WHERE thread_id = OLD.thread_id AND request_id = OLD.id AND request_id <> '';
  END`;
  yield* sql`CREATE TABLE helper_events (
    day TEXT NOT NULL,
    kind TEXT NOT NULL,
    event TEXT NOT NULL,
    n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, kind, event)
  )`;

  yield* sql`CREATE TABLE usage_limits (key TEXT PRIMARY KEY, data TEXT NOT NULL)`;
  yield* sql`CREATE TABLE local_checks (key TEXT PRIMARY KEY, data TEXT NOT NULL)`;

  yield* searchSchema;
  yield* usageSchema;
});

const mergeFreezes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE merge_freezes (key TEXT PRIMARY KEY, data TEXT NOT NULL)`;
});

const messageReceipts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE message_receipts (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    client_message_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    outcome TEXT,
    retired INTEGER NOT NULL DEFAULT 0,
    UNIQUE (thread_id, client_message_id)
  )`;
  yield* sql`CREATE INDEX message_receipts_pending ON message_receipts(thread_id)
    WHERE outcome IS NULL AND retired = 0`;
  yield* sql`CREATE INDEX message_receipts_responses ON message_receipts(thread_id, seq DESC)
    WHERE outcome IS NOT NULL`;
});

const mergeFences = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE merge_fences (key TEXT PRIMARY KEY, data TEXT NOT NULL)`;
});

const usageLimitHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE usage_limit_history (
    agent TEXT NOT NULL,
    limit_window TEXT NOT NULL,
    bucket INTEGER NOT NULL,
    window_id INTEGER NOT NULL,
    utilization REAL NOT NULL,
    peak REAL NOT NULL,
    resets_at INTEGER,
    PRIMARY KEY (agent, limit_window, bucket, window_id)
  ) WITHOUT ROWID`;
  yield* sql`CREATE INDEX usage_limit_history_bucket ON usage_limit_history(bucket)`;
  yield* sql`CREATE TABLE usage_credit_history (
    agent TEXT NOT NULL,
    bucket INTEGER NOT NULL,
    balance REAL NOT NULL,
    spent REAL NOT NULL,
    added REAL NOT NULL,
    PRIMARY KEY (agent, bucket)
  ) WITHOUT ROWID`;
  yield* sql`CREATE INDEX usage_credit_history_bucket ON usage_credit_history(bucket)`;
});

const partTypesOf = (row: "new") =>
  `INSERT INTO message_parts (message_rowid, thread_id, type)
    SELECT DISTINCT ${row}.rowid, ${row}.thread_id, json_extract(p.value, '$.type')
    FROM json_each(CASE WHEN json_valid(${row}.message) THEN ${row}.message ELSE '{}' END, '$.parts') p
    WHERE json_extract(p.value, '$.type') IS NOT NULL;`;

const messageParts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const statements = [
    `CREATE TABLE message_parts (
      message_rowid INTEGER NOT NULL,
      thread_id TEXT NOT NULL,
      type TEXT NOT NULL,
      PRIMARY KEY (message_rowid, type)
    ) WITHOUT ROWID`,
    `CREATE INDEX message_parts_thread_type ON message_parts(thread_id, type)`,
    `CREATE TRIGGER messages_parts_insert AFTER INSERT ON messages BEGIN
        DELETE FROM message_parts WHERE message_rowid = new.rowid;
        ${partTypesOf("new")}
      END`,
    `CREATE TRIGGER messages_parts_update AFTER UPDATE OF message, search_pending, thread_id ON messages
      WHEN new.search_pending IS NULL OR new.search_pending IS old.search_pending BEGIN
        DELETE FROM message_parts WHERE message_rowid = old.rowid;
        ${partTypesOf("new")}
      END`,
    `CREATE TRIGGER messages_parts_delete AFTER DELETE ON messages BEGIN
      DELETE FROM message_parts WHERE message_rowid = old.rowid;
    END`,
    `INSERT INTO message_parts (message_rowid, thread_id, type)
      SELECT DISTINCT m.rowid, m.thread_id, json_extract(p.value, '$.type')
      FROM messages m,
        json_each(CASE WHEN json_valid(m.message) THEN m.message ELSE '{}' END, '$.parts') p
      WHERE json_extract(p.value, '$.type') IS NOT NULL`,
  ];
  for (const statement of statements) yield* sql.unsafe(statement);
});

const hosts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE threads ADD COLUMN host_id TEXT NOT NULL DEFAULT 'local'`;
  yield* sql`CREATE INDEX threads_host ON threads(host_id) WHERE host_id <> 'local'`;
  yield* sql`CREATE TABLE hosts (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    removed_at INTEGER,
    data TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE session_leases (
    thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
    host_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    leased_at INTEGER NOT NULL
  )`;
  yield* sql`CREATE INDEX session_leases_host ON session_leases(host_id)`;
});

const actorEvents = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE actor_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    actor_id TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    actor_role TEXT NOT NULL,
    action TEXT NOT NULL,
    thread_id TEXT,
    workspace_id TEXT,
    data TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX actor_events_thread ON actor_events(thread_id, seq)
    WHERE thread_id IS NOT NULL`;
});

const queueActor = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE queue_items ADD COLUMN actor TEXT`;
});

const personSettings = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE person_settings (
    person TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (person, key)
  ) WITHOUT ROWID`;
  yield* sql`INSERT INTO person_settings (person, key, value)
    SELECT 'local', 'layout.grid', json_extract(value, '$.layout.grid') FROM settings
    WHERE key = 'app' AND json_valid(value)
      AND json_type(value, '$.layout.grid') = 'object'`;
});

const waitPerson = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE wait_items ADD COLUMN person TEXT`;
});

const folderTrust = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projects ADD COLUMN folder_trust TEXT`;
  yield* sql`UPDATE projects SET folder_trust = 'trusted'`;
});

const userMessages = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS messages_thread_user ON messages(thread_id, seq) WHERE role = 'user'`;
});

const actorNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS actor_events_actor ON actor_events(actor_id, seq)`;
});

const privateReaders = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE private_readers (thread_id TEXT PRIMARY KEY, data TEXT NOT NULL)`;
});

const workspaceHolders = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE workspace_holders (workspace_id TEXT PRIMARY KEY, data TEXT NOT NULL)`;
});

const projectOrigins = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projects ADD COLUMN origin_identity TEXT`;
});

const dreamCursors = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE dream_cursors (workspace_id TEXT PRIMARY KEY, data TEXT NOT NULL)`;
  yield* sql`INSERT INTO dream_cursors (workspace_id, data)
    SELECT w.id, json_object(
      'reportSeq', COALESCE((SELECT MAX(r.seq) FROM worker_reports r WHERE r.workspace_id = w.id), 0),
      'eventSeq', COALESCE((SELECT MAX(e.seq) FROM orchestration_events e WHERE e.workspace_id = w.id), 0),
      'at', CAST(strftime('%s', 'now') AS INTEGER) * 1000
    ) FROM workspaces w`;
});

export const migrations = {
  "0001_baseline": baseline,
  "0002_merge_freezes": mergeFreezes,
  "0003_message_receipts": messageReceipts,
  "0004_merge_fences": mergeFences,
  "0005_usage_limit_history": usageLimitHistory,
  "0006_message_parts": messageParts,
  "0007_hosts": hosts,
  "0008_actor_events": actorEvents,
  "0009_queue_actor": queueActor,
  "0010_person_settings": personSettings,
  "0011_wait_person": waitPerson,
  "0012_user_messages": userMessages,
  "0013_actor_names": actorNames,
  "0014_folder_trust": folderTrust,
  "0015_private_readers": privateReaders,
  "0016_workspace_holders": workspaceHolders,
  "0017_project_origins": projectOrigins,
  "0018_dream_cursors": dreamCursors,
};

const MOVED: ReadonlyArray<{ readonly from: number; readonly name: string }> = [
  { from: 9, name: "user_messages" },
];

/**
 * Validate in Effect's loader, inside its migration transaction and before it chooses pending ids.
 * `fromRecord` silently drops malformed keys; the migrator silently skips ids <= the latest applied.
 * Both must fail at startup instead.
 */
export const migrationLoader = (
  record: Parameters<typeof SqliteMigrator.fromRecord>[0],
): SqliteMigrator.Loader<SqlClient.SqlClient> =>
  Effect.gen(function* () {
    for (const key of Object.keys(record)) {
      if (!/^\d{4,}_[a-z][a-z0-9_]*$/.test(key)) {
        return yield* new SqliteMigrator.MigrationError({
          kind: "BadState",
          message: `Invalid migration key "${key}"; use NNNN_name`,
        });
      }
    }
    const resolved = yield* SqliteMigrator.fromRecord(record);
    for (const [index, [id, name]] of resolved.entries()) {
      if (id !== index + 1) {
        return yield* new SqliteMigrator.MigrationError({
          kind: "BadState",
          message: `Migration ids must be contiguous from 0001: expected ${index + 1}, found ${id}_${name}`,
        });
      }
    }

    const sql = yield* SqlClient.SqlClient;
    const applied = yield* sql<{ migration_id: number; name: string }>`
      SELECT migration_id, name FROM ${sql(MIGRATIONS_TABLE)} ORDER BY migration_id`.pipe(
      Effect.mapError(
        (cause) =>
          new SqliteMigrator.MigrationError({
            kind: "BadState",
            message: "Could not validate applied migrations",
            cause,
          }),
      ),
    );
    const moved = applied.filter((row) =>
      MOVED.some((each) => each.from === row.migration_id && each.name === row.name),
    );
    for (const row of moved) {
      yield* sql`DELETE FROM ${sql(MIGRATIONS_TABLE)} WHERE migration_id = ${row.migration_id} AND name = ${row.name}`.pipe(
        Effect.mapError(
          (cause) =>
            new SqliteMigrator.MigrationError({
              kind: "BadState",
              message: `Could not move migration ${row.migration_id}_${row.name}`,
              cause,
            }),
        ),
      );
    }
    const kept = applied.filter((row) => !moved.includes(row));
    const keptLatest = kept.at(-1)?.migration_id ?? 0;
    const readLatest = applied.at(-1)?.migration_id ?? 0;
    if (moved.length > 0) {
      for (const [id, name, load] of resolved) {
        if (id <= keptLatest || id > readLatest) continue;
        yield* load.pipe(
          Effect.flatMap(
            (migration) => migration as Effect.Effect<unknown, unknown, SqlClient.SqlClient>,
          ),
          Effect.andThen(
            sql`INSERT INTO ${sql(MIGRATIONS_TABLE)} (migration_id, name) VALUES (${id}, ${name})`,
          ),
          Effect.mapError(
            (cause) =>
              new SqliteMigrator.MigrationError({
                kind: "Failed",
                message: `Migration ${id}_${name} failed while moving an earlier one`,
                cause,
              }),
          ),
        );
        kept.push({ migration_id: id, name });
      }
    }
    const latest = kept.at(-1)?.migration_id ?? 0;
    const names = new Map(kept.map((row) => [row.migration_id, row.name]));
    for (const [id, name] of resolved) {
      if (id > latest) continue;
      const recorded = names.get(id);
      if (recorded === name) continue;
      return yield* new SqliteMigrator.MigrationError({
        kind: "BadState",
        message:
          recorded === undefined
            ? `Migration ${id}_${name} was not applied, but the database is already at ${latest}; startup requires explicit reconciliation of the schema and migration history after verifying the skipped migration's intended effects; appending a repair migration alone will still fail this check`
            : `Migration ${id}_${name} conflicts with applied migration ${id}_${recorded}; never reuse a shipped id`,
      });
    }
    return resolved;
  });

export const migratorOptions = (record: Parameters<typeof SqliteMigrator.fromRecord>[0]) => ({
  loader: migrationLoader(record),
  table: MIGRATIONS_TABLE,
});

export const MigrationsLayer = SqliteMigrator.layer(migratorOptions(migrations));
