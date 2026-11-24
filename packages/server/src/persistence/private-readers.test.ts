import { describe, expect, it } from "@effect/vitest";
import { CLOSED_THREADS_LIMIT, type Thread, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { SqlClient } from "../platform/unstable.ts";

const thread = (projectId: string, id: string, overrides: Partial<Thread> = {}): Thread =>
  ({
    id,
    projectId,
    title: "synthetic",
    userNamed: false,
    model: { agent: "claude", model: "opus" },
    mode: "default",
    checkout: { kind: "main", path: `/synthetic/${id}` },
    labels: [],
    pinned: false,
    parked: false,
    unread: false,
    createdAt: 1,
    lastActivityAt: 1,
    ...overrides,
  }) as Thread;

/** A fresh process's store and reader rule: modules loaded anew, as at a restart. */
const freshModules = Effect.promise(async () => {
  vi.resetModules();
  const store = await import("./thread-store.ts");
  const readers = await import("../embedding/readable-by.ts");
  return { ThreadStore: store.ThreadStore, ...readers };
});

describe("a private thread pushed off the closed list", () => {
  it.effect("is still its reader's alone, and so is its workspace, after a restart", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-private-readers-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
      const file = join(dir, "gram.db");
      const id = "t-private" as ThreadId;

      const before = yield* freshModules;
      yield* Effect.gen(function* () {
        const store = yield* before.ThreadStore;
        const project = yield* store.ensureProject({ root: "/synthetic/repo", name: "repo" });
        yield* store.insertThread(
          thread(project.id, id, {
            readableBy: "ada",
            workspaceId: "w-private",
          } as Partial<Thread>),
        );
        yield* store.closeThread(id, 1);
        for (let i = 0; i <= CLOSED_THREADS_LIMIT; i++) {
          const other = `t-open-${i}` as ThreadId;
          yield* store.insertThread(thread(project.id, other));
          yield* store.closeThread(other, 10 + i);
        }
        expect((yield* store.listClosed).map((each) => each.thread.id)).not.toContain(id);
      }).pipe(
        Effect.provide(before.ThreadStore.layerSqlite(file).pipe(Layer.orDie)),
        Effect.scoped,
      );

      const after = yield* freshModules;
      expect(after.privacyOf(id)).toBeUndefined();
      yield* Effect.gen(function* () {
        yield* after.ThreadStore;
        expect(after.privacyOf(id)?.readableBy).toBe("ada");
        expect(after.readableByOfWorkspace("w-private")).toBe("ada");
        expect(after.readerMayWorkspace({ subject: "bob" }, { id: "w-private" })).toBe(false);
        expect(
          after.touchesUnreadable({ subject: "bob" }, [`/synthetic/${id}/notes.md`], "read"),
        ).toBe(true);
      }).pipe(Effect.provide(after.ThreadStore.layerSqlite(file).pipe(Layer.orDie)), Effect.scoped);
    }).pipe(Effect.scoped),
  );

  it.effect("never brings back a reader its live row no longer has, after a restart", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-private-readers-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
      const file = join(dir, "gram.db");
      const id = "t-back" as ThreadId;
      const before = yield* freshModules;
      yield* Effect.gen(function* () {
        const store = yield* before.ThreadStore;
        const sql = yield* SqlClient.SqlClient;
        const project = yield* store.ensureProject({ root: "/synthetic/repo", name: "repo" });
        yield* sql`INSERT INTO private_readers (thread_id, data)
          VALUES (${id}, ${JSON.stringify({ readableBy: "ada", readers: ["carol"] })})`;
        yield* store.insertThread(thread(project.id, id, { readableBy: "ada", readers: [] }));
      }).pipe(
        Effect.provide(before.ThreadStore.layerSqlite(file).pipe(Layer.orDie)),
        Effect.scoped,
      );

      const after = yield* freshModules;
      yield* Effect.gen(function* () {
        yield* after.ThreadStore;
        expect(after.privacyOf(id)?.readableBy).toBe("ada");
        expect([...after.readersOf(id)]).toEqual([]);
      }).pipe(Effect.provide(after.ThreadStore.layerSqlite(file).pipe(Layer.orDie)), Effect.scoped);
    }).pipe(Effect.scoped),
  );
});
