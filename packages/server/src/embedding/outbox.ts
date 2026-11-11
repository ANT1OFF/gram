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
  /** A new source at 1, dropping what the old one hadn't sent: for when `confirm` says `false`. */
  readonly restart: () => void;
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

  return {
    source: () => read("source")!,
    append: (events) =>
      transaction(() => {
        let seq = number("last");
        for (const event of events) {
          seq++;
          insert.run(seq, event.at, JSON.stringify({ ...event, seq } satisfies SinkEvent));
        }
        setMeta.run("last", String(seq));
        return seq;
      }),
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
    restart: () =>
      transaction(() => {
        clear.run();
        begin();
      }),
    close: () => db.close(),
  };
};
