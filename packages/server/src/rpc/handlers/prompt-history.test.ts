import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { ThreadNotFound, type Thread, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ThreadStore } from "../../persistence/thread-store.ts";
import type { SqlClient } from "../../platform/unstable.ts";
import { promptHistoryHandlers } from "./prompt-history.ts";

/** A migrated database in a temp dir, removed when the test's scope closes. */
const withDb = <A, E>(effect: Effect.Effect<A, E, ThreadStore | SqlClient.SqlClient>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-prompt-history-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
      return yield* effect.pipe(
        Effect.provide(ThreadStore.layerSqlite(join(dir, "gram.db")).pipe(Layer.orDie)),
      );
    }),
  );

const addThread = (id: string, root: string, lastActivityAt: number) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const project = yield* store.ensureProject({ root, name: root });
    yield* store.insertThread({
      id,
      projectId: project.id,
      title: id,
      userNamed: false,
      model: { agent: "claude", model: "opus" },
      mode: "default",
      checkout: { kind: "main", path: root },
      labels: [],
      pinned: false,
      parked: false,
      unread: false,
      createdAt: 1,
      lastActivityAt,
    } as unknown as Thread);
    return id as ThreadId;
  });

let messageId = 0;
const say = (threadId: ThreadId, role: "user" | "assistant", text: string) =>
  Effect.flatMap(ThreadStore, (store) =>
    store.upsertMessage(threadId, {
      id: `m${++messageId}`,
      role,
      parts: [{ type: "text", text }],
    } as never),
  );

describe("thread.promptHistory", () => {
  it.effect("recalls this thread's prompts first, then the project's recent threads", () =>
    withDb(
      Effect.gen(function* () {
        const current = yield* addThread("t-current", "/work/repo", 10);
        const older = yield* addThread("t-older", "/work/repo", 5);
        const recent = yield* addThread("t-recent", "/work/repo", 9);
        const elsewhere = yield* addThread("t-elsewhere", "/work/other", 99);

        yield* say(older, "user", "bump the dependencies");
        yield* say(recent, "user", "add a regression test");
        yield* say(elsewhere, "user", "rewrite the README");
        yield* say(current, "user", "fix the flaky login test");
        yield* say(current, "assistant", "Fixed.");
        yield* say(current, "user", "add a regression test");
        yield* say(current, "user", "  ");

        const handlers = yield* promptHistoryHandlers;
        const { prompts } = yield* handlers["thread.promptHistory"]({ threadId: current });
        expect(prompts).toEqual([
          "add a regression test",
          "fix the flaky login test",
          "bump the dependencies",
        ]);

        const capped = yield* handlers["thread.promptHistory"]({ threadId: current, limit: 2 });
        expect(capped.prompts).toEqual(["add a regression test", "fix the flaky login test"]);

        const missing = yield* Effect.flip(
          handlers["thread.promptHistory"]({ threadId: "t-gone" as ThreadId }),
        );
        expect(missing).toBeInstanceOf(ThreadNotFound);
      }),
    ),
  );
});
