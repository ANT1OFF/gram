import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import {
  DRAFT_STASH_LIMIT,
  NotFound,
  type DraftStash,
  type StashId,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SqlClient } from "../platform/unstable.ts";
import { ThreadStore } from "./thread-store.ts";

/** A migrated database in a temp dir, removed when the test's scope closes. */
const withDb = <A, E>(effect: Effect.Effect<A, E, ThreadStore | SqlClient.SqlClient>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-draft-stash-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
      return yield* effect.pipe(
        Effect.provide(ThreadStore.layerSqlite(join(dir, "gram.db")).pipe(Layer.orDie)),
      );
    }),
  );

const addThread = (id: string) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const project = yield* store.ensureProject({ root: "/work/repo", name: "repo" });
    yield* store.insertThread({
      id,
      projectId: project.id,
      title: id,
      userNamed: false,
      model: { agent: "claude", model: "opus" },
      mode: "default",
      checkout: { kind: "main", path: "/work/repo" },
      labels: [],
      pinned: false,
      parked: false,
      unread: false,
      createdAt: 1,
      lastActivityAt: 1,
    } as unknown as Thread);
    return id as ThreadId;
  });

const stash = (threadId: ThreadId, n: number): DraftStash => ({
  id: `stash-${String(n).padStart(4, "0")}` as StashId,
  threadId,
  text: `draft ${n}`,
  attachments: [],
  createdAt: n,
});

describe("draft stashes", () => {
  it.effect("lists a thread's stashes newest first", () =>
    withDb(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const thread = yield* addThread("t-one");
        const other = yield* addThread("t-two");
        yield* store.putStash(stash(thread, 1));
        yield* store.putStash(stash(thread, 3));
        yield* store.putStash(stash(other, 2));

        expect((yield* store.listStashes(thread)).map((s) => s.text)).toEqual([
          "draft 3",
          "draft 1",
        ]);
        expect((yield* store.listStashes(other)).map((s) => s.text)).toEqual(["draft 2"]);
      }),
    ),
  );

  it.effect("drops the oldest past the limit and returns them", () =>
    withDb(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const thread = yield* addThread("t-many");
        for (let n = 1; n <= DRAFT_STASH_LIMIT; n++) {
          expect(yield* store.putStash(stash(thread, n))).toEqual([]);
        }
        const dropped = yield* store.putStash(stash(thread, DRAFT_STASH_LIMIT + 1));

        expect(dropped.map((s) => s.text)).toEqual(["draft 1"]);
        const kept = yield* store.listStashes(thread);
        expect(kept).toHaveLength(DRAFT_STASH_LIMIT);
        expect(kept.at(-1)?.text).toBe("draft 2");
      }),
    ),
  );

  it.effect("takes a stash: returns it once, then it's gone", () =>
    withDb(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const thread = yield* addThread("t-take");
        const other = yield* addThread("t-other");
        const saved = {
          ...stash(thread, 1),
          attachments: [{ path: "/data/attachments/t-take/a-shot.png", name: "shot.png" }],
        };
        yield* store.putStash(saved);

        const wrongThread = yield* Effect.flip(store.takeStash(other, saved.id));
        expect(wrongThread).toBeInstanceOf(NotFound);
        expect(yield* store.takeStash(thread, saved.id)).toEqual(saved);
        expect(yield* store.listStashes(thread)).toEqual([]);
        const again = yield* Effect.flip(store.takeStash(thread, saved.id));
        expect(again).toMatchObject({ _tag: "NotFound", entity: "stash" });
      }),
    ),
  );

  it.effect("keeps the first row when a stash with the same id is put again", () =>
    withDb(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const thread = yield* addThread("t-retry");
        const first = stash(thread, 1);
        yield* store.putStash(first);
        yield* store.putStash({ ...first, text: "the retry", createdAt: 2 });

        expect(yield* store.listStashes(thread)).toEqual([first]);
      }),
    ),
  );

  it.effect("goes with the thread when it's removed or closed", () =>
    withDb(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const removed = yield* addThread("t-removed");
        const closed = yield* addThread("t-closed");
        yield* store.putStash(stash(removed, 1));
        yield* store.putStash(stash(closed, 2));

        yield* store.removeThread(removed);
        yield* store.closeThread(closed, 1);

        expect(yield* store.listStashes(removed)).toEqual([]);
        expect(yield* store.listStashes(closed)).toEqual([]);
      }),
    ),
  );
});
