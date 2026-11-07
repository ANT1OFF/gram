import { describe, expect, it } from "@effect/vitest";
import { InvalidState, SendResult, type Thread, type ThreadId } from "@gram/contracts";
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

  it.effect("bounds the table without evicting uncertain reservations", () =>
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
      const [count] = yield* sql<{
        n: number;
      }>`SELECT COUNT(*) AS n FROM message_receipts WHERE thread_id = ${T}`;
      expect(Number(count!.n)).toBe(MESSAGE_RECEIPT_LIMIT);
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
    }).pipe(Effect.provide(memory), Effect.scoped),
  );
});
