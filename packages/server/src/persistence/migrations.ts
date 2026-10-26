import { SqliteMigrator } from "@effect/sql-sqlite-node";
import * as Effect from "effect/Effect";
import { SqlClient } from "../platform/unstable.ts";
import { searchSchema } from "../search/schema.ts";
import { usageSchema } from "../usage/schema.ts";

/** The table that records which migrations a database has run. */
export const MIGRATIONS_TABLE = "schema_migrations";

/**
 * The 1.0 schema, created whole. Entities whose contract shape is still moving keep the full
 * encoded value in a `data` JSON column; the projected columns exist for ordering, lookups and
 * foreign keys.
 */
const baseline = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Projects, threads and what a thread holds. `completed_reason` is why `completedAt` is set
  // (agent | user | prMerged | idle), null while unsettled. `local_check` is the project's own full
  // check (`git/local-checks.ts`).
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
  // `lastTurnUsage` walks this backwards instead of sorting the thread's turns.
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
  // The runtime-owned input queue, so queued prompts survive an agent restart or relaunch.
  // `notice_key` is the key a server notice was sent under (`sendNotice`), so a restart can't take
  // a notice a pause holds for the user's own word; `turn_id` the turn an input was on its way to
  // the agent in (`QueuedInput.turnId`), so a restart before the agent took it sends it again.
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

  // The last closed threads as they were, so ⌘⇧T reaches them after a reload or restart, with
  // copies of their messages and turns. No foreign keys: the thread row is gone until the reopen.
  // `workers` is a closed orchestrator's `{ threadId, feature }` list, so a reopen can link them to
  // it again: closing it cuts their `spawnedBy`, and nothing else says whose they were.
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

  // Feed revisions (`thread.subscribe`'s `afterRev`). `feed_revision` is one counter for every
  // thread, so a closed and reopened thread never issues a revision a client already holds; a
  // message row keeps the revision it was last written at, and a thread its latest (`feed_rev`) and
  // the one its messages were last removed or replaced at (`feed_reset_rev`), before which nothing
  // can resume.
  yield* sql`CREATE TABLE feed_revision (
    id INTEGER PRIMARY KEY CHECK (id = 0),
    rev INTEGER NOT NULL
  )`;
  yield* sql`INSERT INTO feed_revision (id, rev) VALUES (0, 0)`;
  // `listThreads` keeps its decoded list while `threads_version` holds the token it was read under:
  // any write to what it returns draws a new random token, and a rolled-back write restores the old
  // one, so a list read inside that transaction is never reused.
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

  // Thread plans: the plan and the agent's latest todo list, JSON, apart from
  // `threads.data` because they change often and a plan write shouldn't rewrite the thread row. Kept
  // while the thread is closed, so a reopened thread gets its plan back.
  yield* sql`CREATE TABLE thread_plans (
    thread_id TEXT PRIMARY KEY,
    plan TEXT,
    turn_plan TEXT,
    rev INTEGER NOT NULL DEFAULT 0
  )`;
  // What waits on the user per thread, open and lately resolved.
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
  // Wakes a plain thread set itself with `schedule_wake`; a workspace's live in its outbox. `pr` is
  // the PR a wake waits on beside its time, as `{ onPr, on, seen }` JSON.
  yield* sql`CREATE TABLE thread_wakes (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    set_at INTEGER NOT NULL,
    note TEXT NOT NULL,
    pr TEXT
  )`;
  yield* sql`CREATE INDEX thread_wakes_thread ON thread_wakes (thread_id)`;
  // The files each thread produced, recorded as they land (`outputs/workspace-outputs.ts`): one row
  // per thread and path, which a rewrite updates in place. The Files view pages them newest first.
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

  // Settings and the entities the settings name.
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
  // Every settings change an agent proposed and the user approved (`settings/chat-tools.ts`): who
  // proposed it, the approval that let it through, and each key's before and after.
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

  // Threaded orchestration. `workspaces.data` is the `WorkspaceState`
  // JSON; `orchestrator_thread_id` mirrors its slot so a claim is one UNIQUE-checked statement.
  // `orchestration_outbox.data` is the service's own delivery state, opaque to the store, and
  // `orchestration_events` is the append-only audit the budgets are counted from.
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
  // A worker's latest report, and its latest that states an interface, found by seeking rather than
  // by reading the workspace's whole history each time a ledger is built. The second index is
  // partial, so a worker whose reports state none has nothing in it to walk past.
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

  // Dreams. `data` is the `Dream` JSON; `thread_id` mirrors its
  // `threadId` so closing the thread a dream ran as can clear the link in the same transaction,
  // leaving the row and the output on disk to be reviewed.
  yield* sql`CREATE TABLE dreams (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    thread_id TEXT,
    created_at INTEGER NOT NULL,
    data TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX dreams_workspace ON dreams(workspace_id, created_at)`;
  // Per-thread dream watermarks ("What a dream reads"): how much of each thread a memory version
  // has consolidated, written when a dream is adopted. Keyed by version, so a Restore brings back
  // that version's marks and discarding a dream moves none.
  yield* sql`CREATE TABLE dream_watermarks (
    workspace_id TEXT NOT NULL,
    memory_version TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (workspace_id, memory_version, thread_id)
  )`;
  yield* sql`CREATE TABLE automatic_dream (workspace_id TEXT PRIMARY KEY, data TEXT NOT NULL)`;

  // The helper scheduler's tables. `helper_usage` is the ledger its budget reads, a row per UTC day,
  // kind and model; `helper_outputs` the latest output per thread, kind and request (the empty
  // request for a thread-wide one) with the basis it came from, so an unchanged thread costs no
  // call; `helper_events` counters the helper features keep about themselves (a suggestion shown,
  // accepted). None of them holds transcript text except `helper_outputs.data`, which lives and
  // dies with its thread like the messages it came from.
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
  // A request's outputs go with it: answering, clearing (including startup), and deletion through
  // any store path.
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

  // The latest reading of each subscription limit window (`usage/limit-readings.ts`), by key.
  yield* sql`CREATE TABLE usage_limits (key TEXT PRIMARY KEY, data TEXT NOT NULL)`;
  // Gram's own full checks of a PR's head merged onto its base (`git/local-checks.ts`), which the
  // solo merge policy accepts in place of CI: one row per head and merged tree, finished ones only.
  yield* sql`CREATE TABLE local_checks (key TEXT PRIMARY KEY, data TEXT NOT NULL)`;

  yield* searchSchema;
  yield* usageSchema;
});

/**
 * Every migration, in order: the baseline, then each 1.x change appended with the next contiguous
 * id (`0002_name`, …) after merging main. Never reserve an id or change a shipped one. The loader
 * rejects anything Effect's migrator would silently skip.
 */
export const migrations = {
  "0001_baseline": baseline,
};

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
    const latest = applied.at(-1)?.migration_id ?? 0;
    const names = new Map(applied.map((row) => [row.migration_id, row.name]));
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
