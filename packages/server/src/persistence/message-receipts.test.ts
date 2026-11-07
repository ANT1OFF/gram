import { describe, expect, it } from "@effect/vitest";
import {
  CLOSED_THREADS_LIMIT,
  InvalidState,
  SendResult,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "../platform/unstable.ts";
import { MESSAGE_RECEIPT_LIMIT } from "./message-receipts.ts";
import { ThreadStore } from "./thread-store.ts";

const T = "t1" as ThreadId;
const seed = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const project = yield* store.ensureProject({ root: "/synthetic/repo", name: "synthetic" });
  for (const id of [T, "t2" as ThreadId])
    yield* store.insertThread({
      id,
      projectId: project.id,
      title: "synthetic",
      userNamed: false,
      model: { agent: "claude", model: "synthetic" },
      mode: "default",
      checkout: { kind: "main", path: "/synthetic/repo" },
      labels: [],
      pinned: false,
      parked: false,
      unread: false,
      createdAt: 1,
      lastActivityAt: 1,
    } as Thread);
});
const memory = ThreadStore.layerSqlite(":memory:").pipe(Layer.orDie);

describe("durable message receipts", () => {
  it.effect("joins concurrent retries, isolates threads, and rejects changed input", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* ThreadStore;
      let calls = 0;
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const action = Effect.gen(function* () {
        calls++;
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(finish);
        return { queued: false };
      });
      const send = (threadId = T, input = "hello") =>
        store.messageReceipt(
          threadId,
          "same-id",
          ["send", input],
          SendResult,
          InvalidState,
          action,
        );
      const first = yield* Effect.forkScoped(send());
      yield* Deferred.await(entered);
      const retry = yield* Effect.forkScoped(send());
      yield* Deferred.succeed(finish, undefined);
      expect(yield* Fiber.join(first)).toEqual({ queued: false });
      expect(yield* Fiber.join(retry)).toEqual({ queued: false });
      expect(calls).toBe(1);
      expect(yield* send(T, "changed").pipe(Effect.flip)).toMatchObject({ _tag: "InvalidState" });
      yield* send("t2" as ThreadId);
      expect(calls).toBe(2);
    }).pipe(Effect.provide(memory), Effect.scoped),
  );

  it.effect("finishes a receipt after the disconnected caller is interrupted", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* ThreadStore;
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      let calls = 0;
      const action = Effect.gen(function* () {
        calls++;
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(finish);
        return { queued: false };
      });
      const send = store.messageReceipt(
        T,
        "disconnected",
        ["send"],
        SendResult,
        InvalidState,
        action,
      );
      const observer = yield* Effect.forkScoped(send);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(observer);
      yield* Deferred.succeed(finish, undefined);
      expect(yield* send).toEqual({ queued: false });
      expect(calls).toBe(1);
    }).pipe(Effect.provide(memory), Effect.scoped),
  );

  it.effect("replays success and typed failure after closing and reopening SQLite", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-message-receipts-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
      );
      const file = join(dir, "messages.db");
      let calls = 0;
      const send = Effect.gen(function* () {
        const store = yield* ThreadStore;
        const action = Effect.sync(() => {
          calls++;
          return { queued: true };
        });
        expect(
          yield* store.messageReceipt(T, "success", ["send"], SendResult, InvalidState, action),
        ).toEqual({ queued: true });
        const error = new InvalidState({ threadId: T, message: "synthetic refusal" });
        const failure = yield* store
          .messageReceipt(T, "failure", ["steer"], SendResult, InvalidState, Effect.fail(error))
          .pipe(Effect.flip);
        expect(failure).toEqual(error);
      });
      yield* seed.pipe(
        Effect.andThen(send),
        Effect.andThen(
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            yield* store
              .messageReceipt(
                T,
                "uncertain",
                ["send"],
                SendResult,
                InvalidState,
                Effect.die("synthetic crash"),
              )
              .pipe(Effect.exit);
          }),
        ),
        Effect.provide(ThreadStore.layerSqlite(file)),
      );
      yield* send.pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const refused = yield* store
              .messageReceipt(
                T,
                "uncertain",
                ["send"],
                SendResult,
                InvalidState,
                Effect.die("must never dispatch"),
              )
              .pipe(Effect.flip);
            expect(refused).toMatchObject({ _tag: "InvalidState" });
          }),
        ),
        Effect.provide(ThreadStore.layerSqlite(file)),
      );
      expect(calls).toBe(1);
    }),
  );

  it.effect("refuses a late retry after response eviction and SQLite restart", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-expired-receipts-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
      );
      const file = join(dir, "expired.db");
      let deliveries = 0;
      const action = (id: string) =>
        Effect.sync(() => {
          if (id === "very-old") deliveries++;
          return { queued: false };
        });
      yield* Effect.gen(function* () {
        yield* seed;
        const store = yield* ThreadStore;
        const sql = yield* SqlClient.SqlClient;
        yield* store.messageReceipt(
          T,
          "very-old",
          ["send"],
          SendResult,
          InvalidState,
          action("very-old"),
        );
        yield* sql`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ${MESSAGE_RECEIPT_LIMIT - 1})
          INSERT INTO message_receipts(thread_id, client_message_id, fingerprint, outcome)
          SELECT ${T}, 'filler-' || x, 'synthetic', '{"ok":true,"value":{"queued":false}}' FROM n`;
        yield* store.messageReceipt(
          T,
          "newest",
          ["send"],
          SendResult,
          InvalidState,
          action("newest"),
        );
      }).pipe(Effect.provide(ThreadStore.layerSqlite(file)));
      yield* Effect.gen(function* () {
        const store = yield* ThreadStore;
        const retry = yield* store
          .messageReceipt(T, "very-old", ["send"], SendResult, InvalidState, action("very-old"))
          .pipe(Effect.exit);
        expect(deliveries).toBe(1);
        expect(retry._tag).toBe("Failure");
      }).pipe(Effect.provide(ThreadStore.layerSqlite(file)));
    }),
  );

  for (const uncertain of [false, true]) {
    it.effect(
      `keeps ${uncertain ? "uncertain" : "completed"} identities through close, restart and reopen`,
      () =>
        Effect.gen(function* () {
          const dir = mkdtempSync(join(tmpdir(), "gram-closed-receipts-"));
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
          );
          const file = join(dir, "closed.db");
          let deliveries = 0;
          const action = Effect.gen(function* () {
            deliveries++;
            if (uncertain && deliveries === 1) return yield* Effect.die("synthetic process loss");
            return { queued: false };
          });
          yield* Effect.gen(function* () {
            yield* seed;
            const store = yield* ThreadStore;
            yield* store
              .messageReceipt(T, "before-close", ["send"], SendResult, InvalidState, action)
              .pipe(Effect.exit);
            yield* store.closeThread(T, 100);
          }).pipe(Effect.provide(ThreadStore.layerSqlite(file)));
          yield* Effect.gen(function* () {
            const store = yield* ThreadStore;
            const closed = yield* store.takeNewestClosed;
            expect(closed?.closed.thread.id).toBe(T);
            yield* store.insertThread(closed!.closed.thread);
            yield* store.restoreClosedHistory(T);
            const retry = yield* store
              .messageReceipt(T, "before-close", ["send"], SendResult, InvalidState, action)
              .pipe(Effect.exit);
            expect(deliveries).toBe(1);
            expect(retry._tag).toBe(uncertain ? "Failure" : "Success");
          }).pipe(Effect.provide(ThreadStore.layerSqlite(file)));
        }),
    );
  }

  it.effect(
    "drops safety records only when a closed thread is forgotten or evicted permanently",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const store = yield* ThreadStore;
        const sql = yield* SqlClient.SqlClient;
        const thread = yield* store.getThread(T);
        for (const [id, at] of [
          [T, 1],
          ["t2" as ThreadId, 2],
        ] as const) {
          yield* store.messageReceipt(
            id,
            "identity",
            ["send"],
            SendResult,
            InvalidState,
            Effect.succeed({ queued: false }),
          );
          yield* store.closeThread(id, at);
        }
        yield* store.forgetClosed("t2" as ThreadId);
        expect(
          yield* sql`SELECT client_message_id FROM message_receipts WHERE thread_id = 't2'`,
        ).toEqual([]);
        expect(
          yield* sql`SELECT client_message_id FROM message_receipts WHERE thread_id = ${T}`,
        ).toEqual([{ client_message_id: "identity" }]);
        for (let i = 0; i < CLOSED_THREADS_LIMIT; i++) {
          yield* store.rememberClosed(
            { ...thread, id: `closed-filler-${i}` as ThreadId },
            i + 3,
            [],
          );
        }
        expect((yield* store.listClosed).map((closed) => closed.thread.id)).not.toContain(T);
        expect(
          yield* sql`SELECT client_message_id FROM message_receipts WHERE thread_id = ${T}`,
        ).toEqual([]);
      }).pipe(Effect.provide(memory), Effect.scoped),
  );

  it.effect(
    "syncs the reservation at FULL before dispatch, then returns ordinary writes to NORMAL",
    () =>
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "gram-receipt-sync-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
        );
        yield* Effect.gen(function* () {
          yield* seed;
          const store = yield* ThreadStore;
          const sql = yield* SqlClient.SqlClient;
          // SQLite cannot change synchronous inside this transaction. Seeing FULL at INSERT,
          // then entering the action, proves that reservation committed at FULL before delivery.
          yield* sql`CREATE TABLE receipt_sync_probe (level INTEGER NOT NULL)`;
          yield* sql`CREATE TRIGGER receipt_sync_probe BEFORE INSERT ON message_receipts BEGIN
          INSERT INTO receipt_sync_probe SELECT synchronous FROM pragma_synchronous;
        END`;
          yield* store.messageReceipt(
            T,
            "sync-before-delivery",
            ["send"],
            SendResult,
            InvalidState,
            Effect.gen(function* () {
              const [normal] = yield* sql<{ synchronous: number }>`PRAGMA synchronous`;
              expect(Number(normal!.synchronous)).toBe(1);
              const [committed] = yield* sql<{
                level: number;
              }>`SELECT level FROM receipt_sync_probe`;
              expect(Number(committed!.level)).toBe(2);
              return { queued: false };
            }),
          );
        }).pipe(Effect.provide(ThreadStore.layerSqlite(join(dir, "sync.db"))));
      }),
  );

  it.effect("never dispatches a failed reservation and restores NORMAL after rollback", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* ThreadStore;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TRIGGER fail_reservation BEFORE INSERT ON message_receipts BEGIN
        SELECT RAISE(ABORT, 'synthetic reservation failure');
      END`;
      let deliveries = 0;
      const action = Effect.sync(() => {
        deliveries++;
        return { queued: false };
      });
      const send = store.messageReceipt(
        T,
        "retry-after-rollback",
        ["send"],
        SendResult,
        InvalidState,
        action,
      );
      expect((yield* send.pipe(Effect.exit))._tag).toBe("Failure");
      expect(deliveries).toBe(0);
      expect(
        yield* sql`SELECT client_message_id FROM message_receipts WHERE thread_id = ${T}`,
      ).toEqual([]);
      const [normal] = yield* sql<{ synchronous: number }>`PRAGMA synchronous`;
      expect(Number(normal!.synchronous)).toBe(1);
      yield* sql`DROP TRIGGER fail_reservation`;
      expect(yield* send).toEqual({ queued: false });
      expect(deliveries).toBe(1);
    }).pipe(Effect.provide(memory), Effect.scoped),
  );

  it.effect("bounds recent responses and unfinished work without evicting safety identities", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* ThreadStore;
      const sql = yield* SqlClient.SqlClient;
      // A defect models process loss after reservation, before an outcome can be recorded.
      yield* store
        .messageReceipt(
          T,
          "uncertain",
          ["send"],
          SendResult,
          InvalidState,
          Effect.die("synthetic crash"),
        )
        .pipe(Effect.exit);
      let dispatched = false;
      const action = Effect.sync(() => {
        dispatched = true;
        return { queued: false };
      });
      expect(
        yield* store
          .messageReceipt(T, "uncertain", ["send"], SendResult, InvalidState, action)
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "InvalidState" });
      expect(dispatched).toBe(false);
      // Seed historical completed receipts to exercise the exact pruning boundary efficiently.
      yield* sql`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ${MESSAGE_RECEIPT_LIMIT})
      INSERT INTO message_receipts(thread_id, client_message_id, fingerprint, outcome)
      SELECT ${T}, 'old-' || x, 'synthetic', '{"ok":true,"value":{"queued":false}}' FROM n`;
      yield* store.messageReceipt(T, "new", ["send"], SendResult, InvalidState, action);
      const [count] = yield* sql<{ total: number; recent: number; responses: number }>`SELECT
        COUNT(*) AS total, SUM(retired = 0) AS recent, SUM(outcome IS NOT NULL) AS responses
        FROM message_receipts WHERE thread_id = ${T}`;
      expect(Number(count!.total)).toBe(MESSAGE_RECEIPT_LIMIT + 2);
      expect(Number(count!.recent)).toBe(MESSAGE_RECEIPT_LIMIT);
      expect(Number(count!.responses)).toBe(MESSAGE_RECEIPT_LIMIT - 1);
      const [pending] =
        yield* sql`SELECT outcome FROM message_receipts WHERE thread_id = ${T} AND client_message_id = 'uncertain'`;
      expect(pending).toEqual({ outcome: null });
      yield* sql`UPDATE message_receipts SET outcome = NULL WHERE thread_id = ${T}`;
      dispatched = false;
      const full = yield* store
        .messageReceipt(T, "over-capacity", ["send"], SendResult, InvalidState, action)
        .pipe(Effect.flip);
      expect(full).toMatchObject({ _tag: "InvalidState" });
      expect(dispatched).toBe(false);
      yield* store.removeThread(T);
      expect(yield* sql`SELECT * FROM message_receipts WHERE thread_id = ${T}`).toEqual([]);
    }).pipe(Effect.provide(memory), Effect.scoped),
  );
});
