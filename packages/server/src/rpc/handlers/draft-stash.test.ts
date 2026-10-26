import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import {
  DRAFT_STASH_LIMIT,
  ThreadNotFound,
  type Attachment,
  type StashId,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../../config.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import type { SqlClient } from "../../platform/unstable.ts";
import { canSymlink } from "../../fs/test-symlinks.ts";
import { TEST_CONFIG } from "../../runtime/test-harness.ts";
import { draftStashHandlers } from "./draft-stash.ts";

/** A migrated database and a data dir in one temp folder, removed when the test's scope closes. */
const withHandlers = <A, E>(
  effect: (
    handlers: Effect.Success<typeof draftStashHandlers>,
    dataDir: string,
  ) => Effect.Effect<A, E, ThreadStore | SqlClient.SqlClient | ServerConfig>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const dataDir = mkdtempSync(join(tmpdir(), "gram-draft-stash-rpc-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dataDir, { recursive: true })));
      const layer = Layer.merge(
        ThreadStore.layerSqlite(join(dataDir, "gram.db")).pipe(Layer.orDie),
        ServerConfig.layer({ ...TEST_CONFIG, dataDir }),
      );
      return yield* Effect.gen(function* () {
        const handlers = yield* draftStashHandlers;
        return yield* effect(handlers, dataDir);
      }).pipe(Effect.provide(layer));
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

/** A client-generated stash id, as the composer sends with each add. */
const newId = () => randomUUID() as StashId;

/** An uploaded file under the thread's attachments folder, as `attachment.upload` stores it. */
const upload = (dataDir: string, threadId: ThreadId, name: string): Attachment => {
  const folder = join(dataDir, "attachments", threadId);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `abcd1234-${name}`);
  writeFileSync(path, "bytes");
  return { path, name };
};

describe("thread.stash.*", () => {
  it.effect("stashes, lists and takes a draft back with its attachments", () =>
    withHandlers((h, dataDir) =>
      Effect.gen(function* () {
        const threadId = yield* addThread("t-rpc");
        const shot = upload(dataDir, threadId, "shot.png");
        const added = yield* h["thread.stash.add"]({
          id: newId(),
          threadId,
          text: "half a thought",
          attachments: [shot],
        } as never);

        expect((yield* h["thread.stash.list"]({ threadId } as never)).stashes).toEqual([added]);
        const taken = yield* h["thread.stash.take"]({ threadId, stashId: added.id } as never);
        expect(taken).toEqual(added);
        expect((yield* h["thread.stash.list"]({ threadId } as never)).stashes).toEqual([]);
        // Taking a stash back hands its files to the composer, so they stay.
        expect(existsSync(shot.path)).toBe(true);
      }),
    ),
  );

  it.effect("removing a stash deletes its uploads but never a file from disk", () =>
    withHandlers((h, dataDir) =>
      Effect.gen(function* () {
        const threadId = yield* addThread("t-remove");
        const shot = upload(dataDir, threadId, "shot.png");
        const desktop = join(dataDir, "desktop-notes.txt");
        writeFileSync(desktop, "keep me");
        const added = yield* h["thread.stash.add"]({
          id: newId(),
          threadId,
          text: "discard me",
          attachments: [shot, { path: desktop, name: "desktop-notes.txt" }],
        } as never);

        yield* h["thread.stash.remove"]({ threadId, stashId: added.id } as never);

        expect(existsSync(shot.path)).toBe(false);
        expect(existsSync(desktop)).toBe(true);
        const missing = yield* Effect.flip(
          h["thread.stash.remove"]({ threadId, stashId: added.id } as never),
        );
        expect(missing).toMatchObject({ _tag: "NotFound", entity: "stash" });
      }),
    ),
  );

  it.effect.skipIf(!canSymlink)(
    "never deletes through a link in the attachments folder to a file outside it",
    () =>
      withHandlers((h, dataDir) =>
        Effect.gen(function* () {
          const threadId = yield* addThread("t-link");
          const outside = join(dataDir, "outside");
          mkdirSync(outside);
          writeFileSync(join(outside, "victim.txt"), "keep me");
          const folder = join(dataDir, "attachments", threadId);
          mkdirSync(folder, { recursive: true });
          symlinkSync(outside, join(folder, "linked"));
          const added = yield* h["thread.stash.add"]({
            id: newId(),
            threadId,
            text: "discard me",
            attachments: [{ path: join(folder, "linked", "victim.txt"), name: "victim.txt" }],
          } as never);

          yield* h["thread.stash.remove"]({ threadId, stashId: added.id } as never);

          expect(existsSync(join(outside, "victim.txt"))).toBe(true);
        }),
      ),
  );

  it.effect("deletes the uploads of stashes dropped past the limit", () =>
    withHandlers((h, dataDir) =>
      Effect.gen(function* () {
        const threadId = yield* addThread("t-limit");
        const oldest = upload(dataDir, threadId, "oldest.png");
        yield* h["thread.stash.add"]({
          id: newId(),
          threadId,
          text: "oldest",
          attachments: [oldest],
        } as never);
        for (let n = 1; n <= DRAFT_STASH_LIMIT; n++) {
          // The clock is real, so later stashes sort newer by insertion order too.
          yield* h["thread.stash.add"]({
            id: newId(),
            threadId,
            text: `newer ${n}`,
            attachments: [],
          } as never);
        }

        const texts = (yield* h["thread.stash.list"]({ threadId } as never)).stashes.map(
          (s) => s.text,
        );
        expect(texts).toHaveLength(DRAFT_STASH_LIMIT);
        expect(texts).not.toContain("oldest");
        expect(existsSync(oldest.path)).toBe(false);
      }),
    ),
  );

  it.effect("keeps an upload that another stash still references", () =>
    withHandlers((h, dataDir) =>
      Effect.gen(function* () {
        const threadId = yield* addThread("t-shared");
        const shot = upload(dataDir, threadId, "shot.png");
        // A lost reply leaves the chips in the composer, and ⌘S again stashes them under a new id.
        const first = yield* h["thread.stash.add"]({
          id: newId(),
          threadId,
          text: "twice",
          attachments: [shot],
        } as never);
        const second = yield* h["thread.stash.add"]({
          id: newId(),
          threadId,
          text: "twice",
          attachments: [shot],
        } as never);

        yield* h["thread.stash.remove"]({ threadId, stashId: first.id } as never);
        expect(existsSync(shot.path)).toBe(true);
        yield* h["thread.stash.remove"]({ threadId, stashId: second.id } as never);
        expect(existsSync(shot.path)).toBe(false);
      }),
    ),
  );

  it.effect("keeps an upload the live draft still uses", () =>
    withHandlers((h, dataDir) =>
      Effect.gen(function* () {
        const threadId = yield* addThread("t-live");
        const shot = upload(dataDir, threadId, "shot.png");
        const added = yield* h["thread.stash.add"]({
          id: newId(),
          threadId,
          text: "the composer kept its chips",
          attachments: [shot],
        } as never);

        yield* h["thread.stash.remove"]({
          threadId,
          stashId: added.id,
          keep: [shot.path],
        } as never);

        expect(existsSync(shot.path)).toBe(true);
      }),
    ),
  );

  it.effect("keeps a dropped stash's upload that a newer stash references", () =>
    withHandlers((h, dataDir) =>
      Effect.gen(function* () {
        const threadId = yield* addThread("t-trim-shared");
        const shot = upload(dataDir, threadId, "shot.png");
        yield* h["thread.stash.add"]({
          id: newId(),
          threadId,
          text: "oldest",
          attachments: [shot],
        } as never);
        yield* h["thread.stash.add"]({
          id: newId(),
          threadId,
          text: "again",
          attachments: [shot],
        } as never);
        for (let n = 2; n <= DRAFT_STASH_LIMIT; n++) {
          yield* h["thread.stash.add"]({
            id: newId(),
            threadId,
            text: `newer ${n}`,
            attachments: [],
          } as never);
        }

        const texts = (yield* h["thread.stash.list"]({ threadId } as never)).stashes.map(
          (s) => s.text,
        );
        expect(texts).not.toContain("oldest");
        expect(texts).toContain("again");
        expect(existsSync(shot.path)).toBe(true);
      }),
    ),
  );

  it.effect("a retried add with the same id stores one row and returns the original", () =>
    withHandlers((h) =>
      Effect.gen(function* () {
        const threadId = yield* addThread("t-retry");
        const other = yield* addThread("t-elsewhere");
        const id = newId();
        const first = yield* h["thread.stash.add"]({
          id,
          threadId,
          text: "sent once",
          attachments: [],
        } as never);
        const retried = yield* h["thread.stash.add"]({
          id,
          threadId,
          text: "sent once",
          attachments: [],
        } as never);

        expect(retried).toEqual(first);
        expect((yield* h["thread.stash.list"]({ threadId } as never)).stashes).toEqual([first]);
        const taken = yield* Effect.flip(
          h["thread.stash.add"]({ id, threadId: other, text: "clash", attachments: [] } as never),
        );
        expect(taken).toMatchObject({ _tag: "NotFound", entity: "stash" });
        expect((yield* h["thread.stash.list"]({ threadId: other } as never)).stashes).toEqual([]);
      }),
    ),
  );

  it.effect("fails for a thread that doesn't exist", () =>
    withHandlers((h) =>
      Effect.gen(function* () {
        const threadId = "t-missing" as ThreadId;
        const error = yield* Effect.flip(h["thread.stash.list"]({ threadId } as never));
        expect(error).toBeInstanceOf(ThreadNotFound);
        const take = yield* Effect.flip(
          h["thread.stash.take"]({ threadId, stashId: "stash-0001" as StashId } as never),
        );
        expect(take).toBeInstanceOf(ThreadNotFound);
      }),
    ),
  );
});
