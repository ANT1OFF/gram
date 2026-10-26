import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  USAGE_MESSAGE_LIMIT,
  USAGE_TURN_LIMIT,
  USAGE_MESSAGE_BYTES,
  USAGE_PAYLOAD_BYTES,
  USAGE_MODEL_BYTES,
  USAGE_SNAPSHOT_BYTES,
} from "./query.ts";

const NOW = Date.parse("2026-10-12T12:00:00Z");
// Execute the production statement with native JSON functions counted, as in the
// independent review oracle. No elapsed-time threshold or transcript inference.
const source = readFileSync(new URL("./query.ts", import.meta.url), "utf8");
const statement = source.match(/const records = yield\* sql<[^`]+>`([\s\S]+?)`;/)?.[1];
if (statement === undefined) throw new Error("Usage statement not found");
const bindings: Record<string, number> = {
  from: NOW - 86_400_000,
  to: NOW,
  USAGE_TURN_LIMIT,
  "USAGE_TURN_LIMIT + 1": USAGE_TURN_LIMIT + 1,
  USAGE_MESSAGE_LIMIT,
  "USAGE_MESSAGE_LIMIT + 1": USAGE_MESSAGE_LIMIT + 1,
  USAGE_MESSAGE_BYTES,
  USAGE_PAYLOAD_BYTES,
  USAGE_MODEL_BYTES,
  USAGE_SNAPSHOT_BYTES,
};
const query = statement.replace(/\$\{([^}]+)\}/g, (_placeholder, expression: string) => {
  const value = bindings[expression];
  if (value === undefined) throw new Error(`Unknown SQL binding: ${expression}`);
  return String(value);
});

const fixture = () => {
  const db = new DatabaseSync(":memory:");
  const native = new DatabaseSync(":memory:");
  for (const table of ["turns", "closed_turns"])
    db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL,
      started_at INTEGER NOT NULL, ended_at INTEGER, reason TEXT, usage TEXT);
      CREATE INDEX ${table}_started ON ${table}(started_at)`);
  for (const table of ["messages", "closed_messages"])
    db.exec(`CREATE TABLE ${table} (thread_id TEXT NOT NULL, id TEXT NOT NULL,
      seq INTEGER NOT NULL, role TEXT NOT NULL, turn_id TEXT, message TEXT NOT NULL, usage_metadata TEXT,
      PRIMARY KEY(thread_id, id));
      CREATE INDEX ${table}_turn ON ${table}(turn_id, thread_id)`);
  let jsonCalls = 0;
  let transcriptCalls = 0;
  for (const [name, arity] of [
    ["json_valid", 1],
    ["json_extract", 2],
    ["json_type", 2],
  ] as const) {
    const fn = native.prepare(`SELECT ${name}(${Array(arity).fill("?").join(",")}) AS value`);
    db.function(name, { deterministic: true, varargs: true }, (...args) => {
      jsonCalls++;
      if (args.some((a) => typeof a === "string" && a.includes("TRANSCRIPT_SENTINEL")))
        transcriptCalls++;
      return fn.get(...args)?.["value"] ?? null;
    });
  }
  return {
    db,
    calls: () => jsonCalls,
    transcriptCalls: () => transcriptCalls,
    close: () => {
      db.close();
      native.close();
    },
  };
};

describe("Usage SQL work admission", () => {
  it.each(["", "closed_"])(
    "reads only %sprojections despite large selected transcripts",
    (prefix) => {
      const { db, calls, transcriptCalls, close } = fixture();
      try {
        db.exec(
          `INSERT INTO ${prefix}turns VALUES ('in', 'thread', ${NOW - 1000}, ${NOW - 500}, 'completed', NULL)`,
        );
        const body = JSON.stringify({
          parts: [{ type: "text", text: "TRANSCRIPT_SENTINEL".repeat(100_000) }],
        });
        const insert =
          db.prepare(`INSERT INTO ${prefix}messages (thread_id, id, seq, role, turn_id, message, usage_metadata)
        VALUES ('thread', ?, ?, 'assistant', 'in', ?, '{"metadata":{"agent":"claude"}}')`);
        for (let n = 0; n < 40; n++) insert.run(`large-${n}`, n, body);
        expect(db.prepare(query).all()).toMatchObject([
          { payload_limit_exceeded: 0, agent: "claude", model: null },
        ]);
        expect(calls()).toBeGreaterThan(0);
        expect(transcriptCalls()).toBe(0);
      } finally {
        close();
      }
    },
  );

  it("admits the exact UTF-8 projection byte limit and refuses one byte more before JSON", () => {
    const { db, calls, close } = fixture();
    try {
      db.exec(
        `INSERT INTO turns VALUES ('in', 'thread', ${NOW - 1000}, ${NOW - 500}, 'completed', NULL)`,
      );
      const base = JSON.stringify({ metadata: { agent: "claude" }, ignored: "é".repeat(1000) });
      const exact = base + " ".repeat(USAGE_MESSAGE_BYTES - Buffer.byteLength(base));
      db.prepare(`INSERT INTO messages (thread_id, id, seq, role, turn_id, message, usage_metadata)
        VALUES ('thread', 'main', 1, 'assistant', 'in', '{}', ?)`).run(exact);
      expect(db.prepare(query).all()).toMatchObject([
        { payload_limit_exceeded: 0, agent: "claude" },
      ]);
      const before = calls();
      db.prepare("UPDATE messages SET usage_metadata = ?").run(exact + "a");
      expect(db.prepare(query).all()).toMatchObject([{ payload_limit_exceeded: 1, agent: null }]);
      expect(calls()).toBe(before);
    } finally {
      close();
    }
  });

  it.each(["", "closed_"])(
    "bounds %sattribution projection bytes before JSON evaluation",
    (prefix) => {
      const { db, calls, close } = fixture();
      try {
        db.exec(
          `INSERT INTO ${prefix}turns VALUES ('in', 'thread', ${NOW - 1000}, ${NOW - 500}, 'completed', NULL)`,
        );
        db.prepare(
          `INSERT INTO ${prefix}messages (thread_id, id, seq, role, turn_id, usage_metadata, message) VALUES ('thread', 'large', 1, 'assistant', 'in', ?, '{}')`,
        ).run("x".repeat(USAGE_MESSAGE_BYTES + 1));
        expect(db.prepare(query).all()).toMatchObject([
          { payload_limit_exceeded: 1, agent: null, model: null },
        ]);
        expect(calls()).toBe(0);
      } finally {
        close();
      }
    },
  );

  it("bounds total payload bytes before parsing even when each selected projection fits", () => {
    const { db, calls, close } = fixture();
    try {
      db.exec(
        `INSERT INTO turns VALUES ('in', 'thread', ${NOW - 1000}, ${NOW - 500}, 'completed', NULL)`,
      );
      const insert = db.prepare(
        "INSERT INTO messages (thread_id, id, seq, role, turn_id, usage_metadata, message) VALUES ('thread', ?, ?, 'assistant', 'in', ?, '{}')",
      );
      db.exec("BEGIN");
      for (let i = 0; i <= USAGE_PAYLOAD_BYTES / USAGE_MESSAGE_BYTES; i++)
        insert.run(`reply-${i}`, i, "x".repeat(USAGE_MESSAGE_BYTES));
      db.exec("COMMIT");
      expect(db.prepare(query).all()).toMatchObject([
        { payload_limit_exceeded: 1, agent: null, model: null },
      ]);
      expect(calls()).toBe(0);
    } finally {
      close();
    }
  });

  it.each(["", "closed_"])(
    "bounds %sturn snapshot bytes before metadata or server decoding",
    (prefix) => {
      const { db, calls, close } = fixture();
      try {
        db.prepare(`INSERT INTO ${prefix}turns VALUES ('in', 'thread', ?, ?, 'completed', ?)`).run(
          NOW - 1000,
          NOW - 500,
          "x".repeat(USAGE_SNAPSHOT_BYTES + 1),
        );
        db.exec(
          `INSERT INTO ${prefix}messages (thread_id, id, seq, role, turn_id, usage_metadata, message) VALUES ('thread', 'reply', 1, 'assistant', 'in', '{"metadata":{"agent":"claude"}}', '{}')`,
        );
        expect(db.prepare(query).all()).toMatchObject([
          { payload_limit_exceeded: 1, usage: null, agent: null },
        ]);
        expect(calls()).toBe(0);
      } finally {
        close();
      }
    },
  );

  it("bounds UTF-8 model bytes before grouping or returning labels and admits the exact boundary", () => {
    const { db, close } = fixture();
    try {
      db.exec(
        `INSERT INTO turns VALUES ('in', 'thread', ${NOW - 1000}, ${NOW - 500}, 'completed', '{"tokens":{"inputTokens":1,"outputTokens":2}}')`,
      );
      const model = "é".repeat(USAGE_MODEL_BYTES / 2);
      db.prepare(
        "INSERT INTO messages (thread_id, id, seq, role, turn_id, usage_metadata, message) VALUES ('thread', 'reply', 1, 'assistant', 'in', ?, '{}')",
      ).run(JSON.stringify({ metadata: { agent: "claude", model } }));
      expect(db.prepare(query).all()).toMatchObject([{ model_limit_exceeded: 0, model }]);
      db.prepare("UPDATE messages SET usage_metadata = ?").run(
        JSON.stringify({ metadata: { agent: "claude", model: model + "é" } }),
      );
      expect(db.prepare(query).all()).toMatchObject([
        { model_limit_exceeded: 1, model: null, usage: null },
      ]);
    } finally {
      close();
    }
  });
  it("does not parse unrelated active or closed transcripts and uses turn-message indexes", () => {
    const { db, calls, close } = fixture();
    try {
      db.exec(`INSERT INTO turns VALUES ('in', 'thread', ${NOW - 1000}, ${NOW - 500}, 'completed', NULL);
        INSERT INTO turns VALUES ('old', 'thread', ${NOW - 86_400_001}, ${NOW - 86_400_000}, 'completed', NULL);
        INSERT INTO closed_turns SELECT * FROM turns WHERE id = 'old'`);
      for (const table of ["messages", "closed_messages"])
        db.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 30000)
          INSERT INTO ${table} (thread_id, id, seq, role, turn_id, usage_metadata, message) SELECT 'thread', 'old-' || x, x, 'assistant', 'old',
          '{"metadata":{"agent":"codex","model":"invented"},"parts":[{"type":"text","text":"Invented unrelated content"}]}', '{}' FROM n`);
      expect(db.prepare(query).all()).toHaveLength(1);
      expect(calls()).toBe(0);
      const plans = db
        .prepare(`EXPLAIN QUERY PLAN ${query}`)
        .all()
        .map((row) => row["detail"]);
      expect(
        plans.some((detail) => String(detail).includes("SEARCH m USING INDEX messages_turn")),
      ).toBe(true);
      expect(
        plans.some((detail) =>
          String(detail).includes("SEARCH m USING INDEX closed_messages_turn"),
        ),
      ).toBe(true);
      expect(plans.some((detail) => /\bSCAN m(?:\s|$)/.test(String(detail)))).toBe(false);
    } finally {
      close();
    }
  });

  it("refuses turn overflow before any linked transcript JSON parsing", () => {
    const { db, calls, close } = fixture();
    try {
      db.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ${USAGE_TURN_LIMIT + 1})
        INSERT INTO turns SELECT 'turn-' || x, 'thread', ${NOW - 1000}, ${NOW - 500}, 'completed', NULL FROM n;
        INSERT INTO messages (thread_id, id, seq, role, turn_id, usage_metadata, message) SELECT thread_id, id, rowid, 'assistant', id,
        '{"metadata":{"agent":"codex","model":"invented"}}', '{}' FROM turns`);
      expect(db.prepare(query).all()).toHaveLength(USAGE_TURN_LIMIT + 1);
      expect(calls()).toBe(0);
    } finally {
      close();
    }
  });

  it.each(["", "closed_"])(
    "refuses %smessage fanout before parsing rather than attributing truncated history",
    (prefix) => {
      const { db, calls, close } = fixture();
      try {
        db.exec(`INSERT INTO ${prefix}turns VALUES ('in', 'thread', ${NOW - 1000}, ${NOW - 500}, 'completed', NULL);
        WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 60000)
        INSERT INTO ${prefix}messages (thread_id, id, seq, role, turn_id, usage_metadata, message) SELECT 'thread', 'reply-' || x, x, 'assistant', 'in',
        '{"metadata":{"agent":"codex","model":"invented"}}', '{}' FROM n`);
        expect(db.prepare(query).all()).toMatchObject([
          { message_limit_exceeded: 1, agent: null, model: null },
        ]);
        expect(calls()).toBe(0);
      } finally {
        close();
      }
    },
  );

  it("admits the exact message limit and counts nested and user lanes in the work budget", () => {
    const { db, calls, close } = fixture();
    try {
      db.exec(`INSERT INTO turns VALUES ('in', 'thread', ${NOW - 1000}, ${NOW - 500}, 'completed', NULL);
        WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ${USAGE_MESSAGE_LIMIT - 1})
        INSERT INTO messages (thread_id, id, seq, role, turn_id, usage_metadata, message) SELECT 'thread', 'reply-' || x, x, 'user', 'in', NULL, '{}' FROM n;
        INSERT INTO messages (thread_id, id, seq, role, turn_id, usage_metadata, message) VALUES ('thread', 'main', ${USAGE_MESSAGE_LIMIT}, 'assistant', 'in',
        '{"metadata":{"agent":"claude","model":"invented"}}', '{}')`);
      expect(db.prepare(query).all()).toMatchObject([
        { message_limit_exceeded: 0, agent: "claude", model: "invented" },
      ]);
      expect(calls()).toBeGreaterThan(0);
      const before = calls();
      db.exec(`INSERT INTO messages (thread_id, id, seq, role, turn_id, usage_metadata, message) VALUES ('thread', 'nested', ${USAGE_MESSAGE_LIMIT + 1}, 'assistant', 'in',
        '{"metadata":{"agent":"codex","parentToolUseId":"invented-child"}}', '{}')`);
      expect(db.prepare(query).all()).toMatchObject([
        { message_limit_exceeded: 1, agent: null, model: null },
      ]);
      expect(calls()).toBe(before);
    } finally {
      close();
    }
  });
});
