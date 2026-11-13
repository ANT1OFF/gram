// The sessions this machine's host keeps running after Gram quits, as Gram records them: which
// thread each is, its handle in the host, and how far this Gram handled its events. A Gram that
// opens again reads the record, keeps those the host still has, and follows each on from there,
// the turn it was in included. The record is a file in Gram's data folder, this user's alone.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ThreadId } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { LocalHostProcess } from "../host/local-process.ts";
import type { HostSessionsConnection } from "../host/protocol.ts";
import type { KeepHooks, KeptSession } from "./host-agent-sessions.ts";

export interface KeptSessionsShape {
  /** Whether this Gram's sessions on this machine outlive it: its host is kept running. */
  readonly on: boolean;
  /** The threads whose session the host still had from the Gram before this one. */
  readonly survivors: ReadonlySet<ThreadId>;
  /** The survivor of `threadId`, handed to the first session that opens for it, once. */
  readonly take: (threadId: ThreadId) => KeptSession | undefined;
  readonly hooks: KeepHooks;
  /** Leaves this Gram's sessions running in the host as it quits, for the next one. */
  readonly detach: () => void;
  /** Ends a survivor no thread here takes up any more (its thread is gone). */
  readonly discard: (threadId: ThreadId) => Effect.Effect<void>;
  /** How many sessions the record holds now: those that go on if Gram quits. */
  readonly recorded: () => number;
}

const off: KeptSessionsShape = {
  on: false,
  survivors: new Set(),
  take: () => undefined,
  hooks: { record: () => {}, forget: () => {}, detaching: () => false },
  detach: () => {},
  discard: () => Effect.void,
  recorded: () => 0,
};

interface Record {
  /** The host's process when the record was written: another one has none of these sessions. */
  readonly hostPid: number;
  readonly sessions: ReadonlyArray<KeptSession>;
}

const isKept = (value: unknown): value is KeptSession => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { [key: string]: unknown };
  return (
    typeof v["threadId"] === "string" &&
    typeof v["handle"] === "string" &&
    typeof v["confirmed"] === "number" &&
    typeof v["opened"] === "object" &&
    v["opened"] !== null
  );
};

/** The record in `file`, or none when it is missing or unreadable. */
export const readRecord = (file: string): Record | undefined => {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as { [key: string]: unknown };
    const sessions = value["sessions"];
    if (typeof value["hostPid"] !== "number" || !Array.isArray(sessions)) return undefined;
    return { hostPid: value["hostPid"], sessions: sessions.filter(isKept) };
  } catch {
    return undefined;
  }
};

const writeRecord = (file: string, record: Record) => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
  renameSync(temporary, file);
};

/**
 * The kept sessions of a host kept running after Gram quits, recorded in `file`: those it still
 * has from the last Gram are checked against it now, and every session from here on is recorded.
 */
export const makeKeptSessions = (
  file: string,
  sessions: HostSessionsConnection,
  hostPid: number,
): Effect.Effect<KeptSessionsShape> =>
  Effect.gen(function* () {
    const before = readRecord(file);
    const live = new Map<ThreadId, KeptSession>();
    // Another host process has none of the last one's sessions; this one says whether it still has
    // each, by its agent's process.
    if (before !== undefined && before.hostPid === hostPid) {
      for (const kept of before.sessions) {
        const there = yield* sessions.processId(kept.handle).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (there) live.set(kept.threadId, kept);
      }
    }
    const survivors = new Set(live.keys());
    const untaken = new Map(live);
    let detaching = false;
    const save = () => {
      try {
        writeRecord(file, { hostPid, sessions: [...live.values()] });
      } catch {
        // Unwritable: a Gram opened after this one finds nothing to follow, as before this record.
      }
    };
    save();
    return {
      on: true,
      survivors,
      take: (threadId) => {
        const kept = untaken.get(threadId);
        untaken.delete(threadId);
        return kept;
      },
      hooks: {
        record: (kept) => {
          const same = live.get(kept.threadId);
          if (
            same !== undefined &&
            same.handle === kept.handle &&
            same.confirmed === kept.confirmed
          )
            return;
          live.set(kept.threadId, kept);
          save();
        },
        forget: (threadId, handle) => {
          if (live.get(threadId)?.handle !== handle) return;
          live.delete(threadId);
          save();
        },
        detaching: () => detaching,
      },
      detach: () => {
        detaching = true;
        save();
      },
      discard: (threadId) =>
        Effect.suspend(() => {
          const kept = live.get(threadId);
          untaken.delete(threadId);
          if (kept === undefined) return Effect.void;
          live.delete(threadId);
          save();
          return sessions.close(kept.handle);
        }),
      recorded: () => live.size,
    } satisfies KeptSessionsShape;
  });

export class KeptSessions extends Context.Service<KeptSessions, KeptSessionsShape>()(
  "@gram/server/KeptSessions",
) {
  /** Nothing kept: this machine's host ends with Gram, as it always did. */
  static readonly off: KeptSessionsShape = off;

  /**
   * The kept sessions of this machine's host when it is the one kept running after Gram quits
   * (`LocalHostProcess.keptRunning`), recorded in Gram's data folder; nothing kept otherwise.
   */
  static layer(dataDir: string): Layer.Layer<KeptSessions, never, LocalHostProcess> {
    return Layer.effect(
      KeptSessions,
      Effect.gen(function* () {
        const local = yield* LocalHostProcess;
        const connection = local.connection;
        if (connection === undefined || local.keptRunning !== true) return off;
        return yield* makeKeptSessions(
          join(dataDir, "local-host", "sessions.json"),
          connection.sessions,
          connection.hello.pid,
        );
      }),
    );
  }
}

/** Removes the record, for a Gram whose host is no longer kept running. */
export const forgetKeptSessions = (dataDir: string) =>
  rmSync(join(dataDir, "local-host", "sessions.json"), { force: true });
