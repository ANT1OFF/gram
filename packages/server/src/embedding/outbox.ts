// The event sink's outbox: a small SQLite file of its own beside the server's database, so what
// is recorded survives a restart and is sent from where the receiver left off.
//
// The file names its own source id, made with it, and numbers events from 1 with no gaps: the
// number is kept in the same transaction as the row, not left to a rowid. A file that is lost, or
// that the receiver asks for more of than it kept, starts a new source at 1 rather than reuse a
// number for a different event.

import type { SinkEvent } from "@gram/contracts";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { DatabaseSync as Database } from "node:sqlite";

// Loaded like the store's own workers load it, so bundling leaves the builtin alone.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof Database;
};

/** An event as it is recorded; the outbox gives it its `seq`. */
export type SinkEventInput = Omit<SinkEvent, "seq">;

/**
 * How many events the receiver has confirmed are kept, so its ack can fall back that far (it lost
 * its newest writes) and still be answered from here.
 */
export const OUTBOX_KEEPS_CONFIRMED = 10_000;

export interface Outbox {
  /** The source id events are sent under. */
  readonly source: () => string;
  /** Records events in order, returning the last one's `seq`. */
  readonly append: (events: ReadonlyArray<SinkEventInput>) => number;
  /** The highest `seq` recorded; 0 with none. */
  readonly last: () => number;
  /** The highest `seq` the receiver has confirmed; 0 with none. */
  readonly confirmed: () => number;
  /** Up to `limit` events after `seq`, lowest first. */
  readonly after: (seq: number, limit: number) => ReadonlyArray<SinkEvent>;
  /**
   * Takes the receiver's ack. `true` when sending can go on from `ack + 1`; `false` when the
   * receiver asks for events no longer kept (or claims ones never recorded), which only `restart`
   * can answer.
   */
  readonly confirm: (ack: number) => boolean;
  /**
   * A new source at 1, dropping what the old one hadn't sent: for when `confirm` says `false`, or
   * the backlog is given up. What it does for the messages the receiver is then without is
   * `forget`'s to say: `"unsent"` puts each thread that had a `message` unsent back on the
   * backfill from the first of those (the receiver holds everything confirmed, so nothing else
   * is owed); `"all"` forgets the backfill was ever planned, for a receiver that says it no
   * longer holds what was confirmed.
   */
  readonly restart: (forget: "unsent" | "all") => void;
  // The backfill: stored messages owed to the receiver from before it was sent any, thread by
  // thread, kept here so a restart goes on from where the last one stopped.
  /** Whether the backfill was ever planned for this receiver. */
  readonly backfillPlanned: () => boolean;
  /**
   * Plans it: `threadIds` in the order they are to be sent, each from its first message.
   */
  readonly planBackfill: (threadIds: ReadonlyArray<string>) => void;
  /** The thread to send next and the place in it (a message's `seq`) sent up to; none when done. */
  readonly backfillNext: () => { readonly threadId: string; readonly afterSeq: number } | undefined;
  /**
   * Records `events`, a thread's next messages, and in the same transaction moves the thread's
   * place to `afterSeq`, or with `"done"` takes the thread off: what is recorded is never read
   * for again, and what isn't recorded is.
   */
  readonly appendBackfill: (
    threadId: string,
    events: ReadonlyArray<SinkEventInput>,
    afterSeq: number | "done",
  ) => void;
  /**
   * Who started each thread, kept here because nothing else the sink reads says so after a
   * restart. `undefined` forgets a thread's.
   */
  readonly setCreator: (threadId: string, person: string | undefined) => void;
  readonly creators: () => Map<string, string>;
  readonly close: () => void;
}

/** Opens (and makes) the outbox at `file`; `:memory:` for one that goes with the process. */
export const openOutbox = (file: string, keepsConfirmed = OUTBOX_KEEPS_CONFIRMED): Outbox => {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, body TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS creators (thread_id TEXT PRIMARY KEY, person TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS backfill (position INTEGER PRIMARY KEY, thread_id TEXT NOT NULL UNIQUE, after_seq INTEGER NOT NULL) STRICT;
  `);
  const getMeta = db.prepare("SELECT value FROM meta WHERE key = ?");
  const setMeta = db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  );
  const insert = db.prepare("INSERT INTO events (seq, at, body) VALUES (?, ?, ?)");
  const select = db.prepare("SELECT seq, body FROM events WHERE seq > ? ORDER BY seq LIMIT ?");
  const oldest = db.prepare("SELECT MIN(seq) AS seq FROM events");
  const prune = db.prepare("DELETE FROM events WHERE seq <= ?");
  const clear = db.prepare("DELETE FROM events");
  const putCreator = db.prepare(
    "INSERT INTO creators (thread_id, person) VALUES (?, ?) ON CONFLICT (thread_id) DO UPDATE SET person = excluded.person",
  );
  const dropCreator = db.prepare("DELETE FROM creators WHERE thread_id = ?");
  const allCreators = db.prepare("SELECT thread_id, person FROM creators");
  const dropMeta = db.prepare("DELETE FROM meta WHERE key = ?");
  // A thread already waiting keeps the earlier of the two places.
  const queueBackfill = db.prepare(
    `INSERT INTO backfill (position, thread_id, after_seq)
       VALUES ((SELECT COALESCE(MAX(position), 0) + 1 FROM backfill), ?, ?)
       ON CONFLICT (thread_id) DO UPDATE SET after_seq = MIN(after_seq, excluded.after_seq)`,
  );
  const nextBackfill = db.prepare(
    "SELECT thread_id, after_seq FROM backfill ORDER BY position LIMIT 1",
  );
  const moveBackfill = db.prepare("UPDATE backfill SET after_seq = ? WHERE thread_id = ?");
  const dropBackfill = db.prepare("DELETE FROM backfill WHERE thread_id = ?");
  const clearBackfill = db.prepare("DELETE FROM backfill");
  // Each thread's first unconfirmed message, by its place in the thread.
  const unsentMessages = db.prepare(
    `SELECT json_extract(body, '$.threadId') AS thread_id, MIN(json_extract(body, '$.data.seq')) AS first
       FROM events
       WHERE seq > ? AND json_extract(body, '$.type') = 'message'
       GROUP BY thread_id ORDER BY MIN(events.seq)`,
  );

  const read = (key: string): string | undefined =>
    (getMeta.get(key) as { value: string } | undefined)?.value;
  const number = (key: string): number => Number(read(key) ?? 0);
  const transaction = <A>(body: () => A): A => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const begin = () => {
    setMeta.run("source", randomUUID());
    setMeta.run("last", "0");
    setMeta.run("confirmed", "0");
  };
  if (read("source") === undefined) transaction(begin);

  const append = (events: ReadonlyArray<SinkEventInput>): number => {
    let seq = number("last");
    for (const event of events) {
      seq++;
      insert.run(seq, event.at, JSON.stringify({ ...event, seq } satisfies SinkEvent));
    }
    setMeta.run("last", String(seq));
    return seq;
  };

  return {
    source: () => read("source")!,
    append: (events) => transaction(() => append(events)),
    last: () => number("last"),
    confirmed: () => number("confirmed"),
    after: (seq, limit) =>
      (select.all(seq, limit) as Array<{ seq: number; body: string }>).map(
        (row) => JSON.parse(row.body) as SinkEvent,
      ),
    confirm: (ack) =>
      transaction(() => {
        if (!Number.isInteger(ack) || ack < 0 || ack > number("last")) return false;
        const kept = (oldest.get() as { seq: number | null }).seq;
        // Everything after the ack must still be here: nothing is, only when nothing is owed.
        if (ack < number("last") && (kept === null || kept > ack + 1)) return false;
        setMeta.run("confirmed", String(ack));
        prune.run(ack - keepsConfirmed);
        return true;
      }),
    restart: (forget) =>
      transaction(() => {
        if (forget === "all") {
          clearBackfill.run();
          dropMeta.run("backfill");
        } else {
          const unsent = unsentMessages.all(number("confirmed")) as Array<{
            thread_id: string | null;
            first: number | null;
          }>;
          for (const { thread_id, first } of unsent) {
            if (thread_id === null) continue;
            queueBackfill.run(thread_id, typeof first === "number" ? Math.max(0, first - 1) : 0);
          }
        }
        clear.run();
        begin();
      }),
    backfillPlanned: () => read("backfill") !== undefined,
    planBackfill: (threadIds) =>
      transaction(() => {
        for (const threadId of threadIds) queueBackfill.run(threadId, 0);
        setMeta.run("backfill", "planned");
      }),
    backfillNext: () => {
      const row = nextBackfill.get() as { thread_id: string; after_seq: number } | undefined;
      return row === undefined ? undefined : { threadId: row.thread_id, afterSeq: row.after_seq };
    },
    appendBackfill: (threadId, events, afterSeq) =>
      transaction(() => {
        append(events);
        if (afterSeq === "done") dropBackfill.run(threadId);
        else moveBackfill.run(afterSeq, threadId);
      }),
    setCreator: (threadId, person) => {
      if (person === undefined) dropCreator.run(threadId);
      else putCreator.run(threadId, person);
    },
    creators: () =>
      new Map(
        (allCreators.all() as Array<{ thread_id: string; person: string }>).map((row) => [
          row.thread_id,
          row.person,
        ]),
      ),
    close: () => db.close(),
  };
};
